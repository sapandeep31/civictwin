"use client";

/**
 * Praesidium 3D neighborhood canvas — isometric planning view.
 *
 * Night-mode scene with procedural geometry, placement interaction,
 * selection, drag-move, coverage overlays, and simulation playback.
 * Selection state lives in the editor store, never in the engine.
 */

import { Suspense, useMemo, useRef, useState, useEffect, useCallback } from "react";
import * as THREE from "three";
import { Canvas, useThree, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { useEditor, playbackClock, isLocked } from "@/lib/store/editor";
import { cn } from "@/lib/utils";
import type { Vec2 } from "@/lib/world/types";
import { computeCoverage } from "@/lib/sim/scenarios";
import { RoadsLayer, BuildingsLayer, FacilitiesLayer, StreetlightsLayer, CamerasLayer, GuardsLayer, createRoadGeometries } from "./layers";
import { AgentsLayer, EventsLayer, PlaybackTicker } from "./playback";
import { SiteLayers, contentExtent, fitZoom, DEFAULT_ZOOM } from "./siteLayers";
import { DramaLayer } from "./drama";
import { FocusFlyer } from "./focusFlyer";
import { PatrolRoutes, PatrolHUD } from "./patrolEditor";
import { snapToWalkable } from "@/lib/world/patrol";

/* ------------------------------------------------------------------ */

export const SCENE_THEMES = {
  night: {
    name: "Night Digital Twin",
    icon: "🌙",
    bg: "#0b121e",
    fogNear: 750,
    fogFar: 1800,
    ambientColor: "#94a3b8",
    ambientIntensity: 0.68,
    hemiSky: "#38bdf8",
    hemiGround: "#0f172a",
    hemiIntensity: 0.75,
    dirColor: "#e0f2fe",
    dirIntensity: 1.35,
    rimColor: "#818cf8",
    rimIntensity: 0.55,
    groundColor: "#0f172a",
    gridCellColor: "#1e293b",
    gridSectionColor: "#334155",
    frameColor: "#0ea5e9",
  },
  sunset: {
    name: "Golden Hour",
    icon: "🌅",
    bg: "#181116",
    fogNear: 700,
    fogFar: 1700,
    ambientColor: "#fed7aa",
    ambientIntensity: 0.75,
    hemiSky: "#fb923c",
    hemiGround: "#2a1205",
    hemiIntensity: 0.85,
    dirColor: "#f97316",
    dirIntensity: 1.6,
    rimColor: "#f43f5e",
    rimIntensity: 0.6,
    groundColor: "#1c1917",
    gridCellColor: "#3f3f46",
    gridSectionColor: "#71717a",
    frameColor: "#f59e0b",
  },
  daylight: {
    name: "Daylight Architectural",
    icon: "☀️",
    bg: "#eef2f6",
    fogNear: 800,
    fogFar: 2200,
    ambientColor: "#f8fafc",
    ambientIntensity: 1.05,
    hemiSky: "#7dd3fc",
    hemiGround: "#e2e8f0",
    hemiIntensity: 0.9,
    dirColor: "#ffffff",
    dirIntensity: 1.85,
    rimColor: "#94a3b8",
    rimIntensity: 0.35,
    groundColor: "#e2e8f0",
    gridCellColor: "#cbd5e1",
    gridSectionColor: "#94a3b8",
    frameColor: "#2563eb",
  },
};

const snap = (v: number) => Math.round(v);

function InteractionPlane({
  onGroundPoint,
  onGroundDoubleClick,
  onGroundMove,
  onGroundUp,
  onGroundRightClick,
}: {
  onGroundRightClick?: (p: Vec2) => void;
  onGroundPoint: (p: Vec2, e: ThreeEvent<MouseEvent>) => void;
  onGroundDoubleClick?: (p: Vec2, e: ThreeEvent<MouseEvent>) => void;
  onGroundMove: (p: Vec2) => void;
  onGroundUp: () => void;
}) {
  const half = 3000;
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      onClick={(e) => {
        if (e.nativeEvent.button !== 0) return;
        e.stopPropagation();
        if (e.delta > 4) return; // camera drag, not a click
        onGroundPoint({ x: snap(e.point.x), z: snap(e.point.z) }, e);
      }}
      onContextMenu={(e) => {
        // right press+release without movement (a right drag rotates the camera instead)
        e.nativeEvent.preventDefault();
        if (e.delta > 5) return;
        e.stopPropagation();
        onGroundRightClick?.({ x: snap(e.point.x), z: snap(e.point.z) });
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onGroundDoubleClick?.({ x: snap(e.point.x), z: snap(e.point.z) }, e);
      }}
      onPointerMove={(e) => onGroundMove({ x: e.point.x, z: e.point.z })}
      onPointerUp={() => onGroundUp()}
    >
      <planeGeometry args={[half, half]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function GhostPreview({ pointer }: { pointer: React.RefObject<Vec2 | null> }) {
  const tool = useEditor((s) => s.tool);
  const roadDraft = useEditor((s) => s.roadDraft);
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    const p = pointer.current;
    ref.current.visible = tool !== "select" && !!p;
    if (p) ref.current.position.set(snap(p.x), 0, snap(p.z));
  });

  if (tool === "select" || (tool === "road" && roadDraft.length > 0)) return null;
  return (
    <group ref={ref}>
      {tool === "streetlight" && <LampGhost />}
      {tool === "camera" && <CameraGhost />}
      {tool === "guard" && <GuardGhost />}
      {tool === "building" && <BuildingGhost />}
      {tool === "facility" && <FacilityGhost />}
      {tool === "road" && <RoadGhost />}
    </group>
  );
}

function RoadGhost() {
  return (
    <mesh position={[0, 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[1.6, 24]} />
      <meshBasicMaterial color="#38bdf8" transparent opacity={0.65} depthWrite={false} />
    </mesh>
  );
}

function LampGhost() {
  return (
    <group>
      <mesh position={[0, 4, 0]}>
        <cylinderGeometry args={[0.09, 0.13, 8, 6]} />
        <meshBasicMaterial color="#ffd98a" transparent opacity={0.7} />
      </mesh>
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[18, 24]} />
        <meshBasicMaterial color="#ffd98a" transparent opacity={0.12} depthWrite={false} />
      </mesh>
    </group>
  );
}
function CameraGhost() {
  return (
    <group>
      <mesh position={[0, 3.2, 0]}>
        <boxGeometry args={[0.7, 0.4, 0.4]} />
        <meshBasicMaterial color="#35b8a6" transparent opacity={0.85} />
      </mesh>
      <mesh position={[0, 0.05, 8]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[14, 20, Math.PI / 2 - 0.7, 1.4]} />
        <meshBasicMaterial color="#35b8a6" transparent opacity={0.15} depthWrite={false} />
      </mesh>
    </group>
  );
}
function GuardGhost() {
  return (
    <mesh position={[0, 0.9, 0]}>
      <capsuleGeometry args={[0.35, 1.1, 4, 8]} />
      <meshBasicMaterial color="#e8c34a" transparent opacity={0.8} />
    </mesh>
  );
}
function BuildingGhost() {
  return (
    <mesh position={[0, 4.5, 0]}>
      <boxGeometry args={[12, 9, 10]} />
      <meshBasicMaterial color="#8fa3b8" transparent opacity={0.4} />
    </mesh>
  );
}
function FacilityGhost() {
  return (
    <mesh position={[0, 0.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[8, 24]} />
      <meshBasicMaterial color="#7fb8a8" transparent opacity={0.4} depthWrite={false} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ */

function SceneContents() {
  const project = useEditor((s) => s.project);
  const tool = useEditor((s) => s.tool);
  const selection = useEditor((s) => s.selection);
  const layers = useEditor((s) => s.layers);
  const roadDraft = useEditor((s) => s.roadDraft);
  const dragState = useEditor((s) => s.dragState);
  const store = useEditor;

  const pointer = useRef<Vec2 | null>(null);
  const controlsRef = useRef<any>(null);
  const controls = useThree((s) => s.controls) as any;

  // disable orbit while dragging
  useEffect(() => {
    if (controls) controls.enabled = !dragState;
  }, [dragState, controls]);

  // global pointerup safety net for drags
  useEffect(() => {
    const up = () => {
      const s = store.getState();
      if (s.dragState) s.endDrag();
      const c = (window as any).__praesidiumControls?.current;
      if (c && !c.enabled && !store.getState().dragState) c.enabled = true;
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [store]);

  const coverage = useMemo(() => {
    if (!project) return null;
    if (!layers.coverage && !layers.lighting && !layers.cctv) return null;
    try {
      return computeCoverage(project.world, project.scenario.ambientVisibility, project.scenario.cctvRangeScale);
    } catch {
      return null;
    }
  }, [project?.world, project?.scenario.ambientVisibility, project?.scenario.cctvRangeScale, layers.coverage, layers.lighting, layers.cctv]);

  const lastClickTimeRef = useRef<number>(0);

  const handleGroundDoubleClick = useCallback(() => {
    const s = store.getState();
    if (s.routeDraw) s.finishRouteDraw();
    else if (s.tool === "road" && s.roadDraft.length >= 2) {
      s.commitRoad();
    }
  }, [store]);

  const handleGroundPoint = useCallback(
    (p: Vec2) => {
      const s = store.getState();
      if (!s.project) return;
      if (s.dragState) {
        s.endDrag();
        return;
      }
      // Navigate mode / locked simulation view: clicking never edits the world.
      if (isLocked(s) || (s.mode !== "edit" && (s.tool !== "select" || s.moveMode))) {
        if (s.tool === "select" && s.selection) s.select(null);
        return;
      }
      const lim = {
        x: Math.max(-s.project.world.bounds.width / 2, Math.min(s.project.world.bounds.width / 2, p.x)),
        z: Math.max(-s.project.world.bounds.depth / 2, Math.min(s.project.world.bounds.depth / 2, p.z)),
      };
      // move mode: relocate the selected object, then exit move mode
      if (s.tool === "select" && s.moveMode && s.selection) {
        s.moveObject(s.selection, lim.x, lim.z);
        s.setMoveMode(false);
        return;
      }
      // patrol route drawing: every click adds a stop, snapped to the walkable network
      if (s.routeDraw) {
        s.appendWaypoint(s.routeDraw.guardId, snapToWalkable(s.project.world, lim));
        return;
      }
      switch (s.tool) {
        case "select":
          if (s.selection) s.select(null);
          break;
        case "streetlight":
          s.addStreetlight(lim.x, lim.z);
          break;
        case "camera":
          s.addCamera(lim.x, lim.z);
          break;
        case "guard":
          // left-click extends the selected guard's route; guards are dropped with right-click
          s.guardToolClick(lim);
          break;
        case "building":
          s.addBuilding(lim.x, lim.z);
          break;
        case "facility":
          s.addFacility(lim.x, lim.z);
          break;
        case "road": {
          const now = Date.now();
          const isDouble = now - lastClickTimeRef.current < 450;
          lastClickTimeRef.current = now;

          const draft = s.roadDraft;
          if (draft.length > 0) {
            const last = draft[draft.length - 1];
            const dist = Math.hypot(lim.x - last.x, lim.z - last.z);
            if ((isDouble || dist < 2.5) && draft.length >= 2) {
              s.commitRoad();
              return;
            }
          }
          s.pushRoadPoint(lim);
          break;
        }
      }
    },
    [store]
  );

  const handleGroundRightClick = useCallback(
    (p: Vec2) => {
      const s = store.getState();
      if (!s.project || isLocked(s) || s.mode !== "edit" || s.tool !== "guard") return;
      const w = s.project.world;
      const lim = {
        x: Math.max(-w.bounds.width / 2, Math.min(w.bounds.width / 2, p.x)),
        z: Math.max(-w.bounds.depth / 2, Math.min(w.bounds.depth / 2, p.z)),
      };
      const sp = snapToWalkable(w, lim);
      s.addGuard(sp.x, sp.z);
    },
    [store]
  );

  const sceneTheme = useEditor((s) => s.sceneTheme) ?? "night";

  if (!project) return null;
  const b =project.world.bounds;
  const theme = SCENE_THEMES[sceneTheme] ?? SCENE_THEMES.night;

  return (
    <>
      <ambientLight intensity={theme.ambientIntensity} color={theme.ambientColor} />
      <hemisphereLight args={[theme.hemiSky, theme.hemiGround, theme.hemiIntensity]} />
      <directionalLight position={[120, 200, 80]} intensity={theme.dirIntensity} color={theme.dirColor} />
      <directionalLight position={[-120, 100, -80]} intensity={theme.rimIntensity} color={theme.rimColor} />

      {/* ground */}
      {/* well below the satellite image (2.5 cm) so they never fight in the depth buffer at any angle */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.3, 0]} receiveShadow>
        <planeGeometry args={[b.width + 60, b.depth + 60]} />
        <meshStandardMaterial color={theme.groundColor} roughness={0.85} />
      </mesh>
      <Grid
        position={[0, 0.001, 0]}
        args={[b.width + 60, b.depth + 60]}
        cellSize={10}
        cellThickness={0.6}
        cellColor={theme.gridCellColor}
        sectionSize={50}
        sectionThickness={1.2}
        sectionColor={theme.gridSectionColor}
        fadeDistance={1400}
        fadeStrength={1}
        infiniteGrid={false}
      />
      {/* bounds frame */}
      <lineSegments position={[0, 0.02, 0]}>
        <edgesGeometry args={[new THREE.PlaneGeometry(b.width, b.depth).toNonIndexed()]} />
        <lineBasicMaterial color={theme.frameColor} />
      </lineSegments>

      <SiteLayers />
      <RoadsLayer
        roads={project.world.roads}
        coverage={coverage && layers.coverage ? coverage.perRoadLit : null}
        selectedId={selection?.kind === "road" ? selection.id : null}
        theme={sceneTheme}
      />
      <BuildingsLayer buildings={project.world.buildings} selectedId={selection?.kind === "building" ? selection.id : null} theme={sceneTheme} />
      <FacilitiesLayer facilities={project.world.facilities} showLabels={layers.labels} selectedId={selection?.kind === "facility" ? selection.id : null} />
      <StreetlightsLayer lights={project.world.streetlights} showPools={layers.lighting} selectedId={selection?.kind === "streetlight" ? selection.id : null} />
      <CamerasLayer cameras={project.world.cameras} showFov={layers.cctv} selectedId={selection?.kind === "camera" ? selection.id : null} />
      <GuardsLayer guards={project.world.guards} showRoutes={false} selectedId={selection?.kind === "guard" ? selection.id : null} />
      <PatrolRoutes />

      <AgentsLayer />
      <DramaLayer />
      <EventsLayer />
      <PlaybackTicker />

      <InteractionPlane
        onGroundPoint={handleGroundPoint}
        onGroundDoubleClick={handleGroundDoubleClick}
        onGroundRightClick={handleGroundRightClick}
        onGroundMove={(p) => {
          const s = store.getState();
          if (s.dragState) {
            s.updateDrag(p.x, p.z);
          } else {
            pointer.current = p;
          }
        }}
        onGroundUp={() => {
          const s = store.getState();
          if (s.dragState) s.endDrag();
        }}
      />
      <GhostPreview pointer={pointer} />

      {/* road draft preview */}
      {roadDraft.length > 0 && <RoadDraft pts={roadDraft} pointer={pointer} />}

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minZoom={0.5}
        maxZoom={14}
        zoomToCursor
        mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE }}
        touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
        maxPolarAngle={Math.PI / 2.04}
        minPolarAngle={0.01}
        target={[0, 0, 0]}
      />
      <CanvasControlsBridge controlsRef={controlsRef} />
      <FocusFlyer />
    </>
  );
}

function CanvasControlsBridge({ controlsRef }: { controlsRef: React.MutableRefObject<any> }) {
  useEffect(() => {
    (window as any).__praesidiumControls = controlsRef;
  }, [controlsRef]);
  return null;
}

function RoadDraft({ pts, pointer }: { pts: Vec2[]; pointer: React.RefObject<Vec2 | null> }) {
  const cursorGroupRef = useRef<THREE.Group>(null);
  const reticleRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const p = pointer.current;
    if (reticleRef.current) {
      if (p) {
        reticleRef.current.visible = true;
        reticleRef.current.position.set(snap(p.x), 0.12, snap(p.z));
      } else {
        reticleRef.current.visible = false;
      }
    }
    if (cursorGroupRef.current) {
      if (p && pts.length > 0) {
        const lastPt = pts[pts.length - 1];
        const dx = snap(p.x) - lastPt.x;
        const dz = snap(p.z) - lastPt.z;
        const len = Math.hypot(dx, dz);
        if (len >= 0.5) {
          cursorGroupRef.current.visible = true;
          const midX = (lastPt.x + snap(p.x)) / 2;
          const midZ = (lastPt.z + snap(p.z)) / 2;
          cursorGroupRef.current.position.set(midX, 0.10, midZ);
          cursorGroupRef.current.rotation.set(0, -Math.atan2(dz, dx) + Math.PI / 2, 0);
          const mesh = cursorGroupRef.current.children[0] as THREE.Mesh;
          if (mesh) mesh.scale.set(1, len, 1);
        } else {
          cursorGroupRef.current.visible = false;
        }
      } else {
        cursorGroupRef.current.visible = false;
      }
    }
  });

  const draftGeo = useMemo(() => {
    if (pts.length < 2) return null;
    return createRoadGeometries(pts, 4, false).roadGeo;
  }, [pts]);

  return (
    <group raycast={() => null}>
      {/* Waypoint markers */}
      {pts.map((p, i) => (
        <group key={i} position={[p.x, 0.11, p.z]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[1.5, 24]} />
            <meshBasicMaterial color="#38bdf8" />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
            <circleGeometry args={[0.6, 16]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
        </group>
      ))}

      {/* Fixed road draft segments */}
      {draftGeo && (
        <mesh geometry={draftGeo} position={[0, 0.10, 0]}>
          <meshStandardMaterial
            color="#38bdf8"
            emissive="#0284c7"
            emissiveIntensity={0.6}
            transparent
            opacity={0.8}
            roughness={0.4}
          />
        </mesh>
      )}

      {/* Live segment connecting last point to cursor */}
      <group ref={cursorGroupRef} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[4, 1]} />
          <meshStandardMaterial
            color="#38bdf8"
            emissive="#0284c7"
            emissiveIntensity={0.5}
            transparent
            opacity={0.65}
            depthWrite={false}
          />
        </mesh>
      </group>

      {/* Target reticle at cursor */}
      <group ref={reticleRef} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.8, 2.2, 24]} />
          <meshBasicMaterial color="#38bdf8" />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.5, 16]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */

function ViewPresetButtons() {
  const [activeView, setActiveView] = useState<"isometric" | "road" | "topdown">("isometric");

  const setView = (v: "isometric" | "road" | "topdown") => {
    setActiveView(v);
    const controls = (window as any).__praesidiumControls?.current;
    if (!controls) return;
    // geo twins are framed on the society itself, not the captured box's centre
    const pr = useEditor.getState().project;
    const c = pr?.source.geo ? contentExtent(pr.world) : { cx: 0, cz: 0 };
    if (v === "isometric") {
      controls.target.set(c.cx, 0, c.cz);
      controls.object.position.set(c.cx + 190, 170, c.cz + 190);
      controls.object.zoom = fitZoom(controls.object);
    } else if (v === "road") {
      // Zoomed-in street corridor perspective focused on road network & lighting
      controls.target.set(5, 0, -5);
      controls.object.position.set(95, 45, 95);
      controls.object.zoom = 4.4;
    } else if (v === "topdown") {
      // 2D orthographic map view looking straight down
      controls.target.set(c.cx, 0, c.cz);
      controls.object.position.set(c.cx + 0.01, 320, c.cz + 0.01);
      controls.object.zoom = fitZoom(controls.object);
    }
    controls.object.updateProjectionMatrix();
    controls.update();
  };

  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-[#2c3a4a] bg-[#141d27]/90 p-1 shadow-lg backdrop-blur-md">
      <button
        onClick={() => setView("isometric")}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition",
          activeView === "isometric"
            ? "bg-[#2563eb] text-white shadow-sm"
            : "text-[#94a3b8] hover:bg-[#1e293b] hover:text-[#f8fafc]"
        )}
        title="Reset to default isometric angle"
      >
        <span>⤢</span>
        <span>Reset view</span>
      </button>
      <button
        onClick={() => setView("road")}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition",
          activeView === "road"
            ? "bg-[#2563eb] text-white shadow-sm"
            : "text-[#94a3b8] hover:bg-[#1e293b] hover:text-[#f8fafc]"
        )}
        title="Switch to pedestrian road/street level perspective"
      >
        <span>🛣️</span>
        <span>Road view</span>
      </button>
      <button
        onClick={() => setView("topdown")}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition",
          activeView === "topdown"
            ? "bg-[#2563eb] text-white shadow-sm"
            : "text-[#94a3b8] hover:bg-[#1e293b] hover:text-[#f8fafc]"
        )}
        title="Switch to 2D top-down map plan view"
      >
        <span>🧭</span>
        <span className="hidden sm:inline">Top-down</span>
      </button>
    </div>
  );
}

function ModeToggle() {
  const mode = useEditor((s) => s.mode);
  const setMode = useEditor((s) => s.setMode);
  const locked = useEditor((s) => isLocked(s));
  const seg = (m: "navigate" | "edit", label: string, key: string, title: string) => (
    <button
      onClick={() => setMode(m)}
      disabled={locked && m === "edit"}
      title={locked && m === "edit" ? "Locked while a simulation is loaded — exit to edit" : title}
      className={cn(
        "flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
        mode === m ? (m === "edit" ? "bg-[#2e7d5b] text-white shadow-sm" : "bg-[#2563eb] text-white shadow-sm") : "text-[#94a3b8] hover:bg-[#1e293b] hover:text-[#f8fafc]"
      )}
    >
      <span>{label}</span>
      <kbd className="rounded bg-black/25 px-1 text-[9px] font-semibold">{key}</kbd>
    </button>
  );
  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-[#2c3a4a] bg-[#141d27]/90 p-1 shadow-lg backdrop-blur-md">
      {seg("navigate", "Navigate", "Esc", "Navigate: drag pans, right-drag rotates, nothing is moved (Esc)")}
      {seg("edit", "Edit", "E", "Edit: place and drag objects (E)")}
    </div>
  );
}

function SimulationLockBadge() {
  const locked = useEditor((s) => isLocked(s));
  const exit = useEditor((s) => s.exitSimulation);
  if (!locked) return null;
  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-20 flex items-center gap-2.5 rounded-full border border-[#f59e0b]/60 bg-[#0f172a]/95 py-1 pl-3.5 pr-1.5 text-xs text-white shadow-2xl backdrop-blur-md">
      <span className="text-[#fbbf24]">🔒</span>
      <span className="font-medium">Simulation view — editing locked</span>
      <button onClick={exit} className="rounded-full bg-[#2e7d5b] px-3 py-1 text-[11px] font-semibold text-white hover:bg-[#276c4f]">
        Exit to edit
      </button>
    </div>
  );
}

const HINT_KEY = "praesidium.controlsHint.dismissed";

function ControlsHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(localStorage.getItem(HINT_KEY) !== "1");
    } catch {
      setShow(true);
    }
  }, []);
  if (!show) return null;
  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 flex items-center gap-2 rounded-md border border-[#2c3a4a] bg-[#141d27]/80 px-2.5 py-1 text-[10.5px] text-[#94a3b8] backdrop-blur-md">
      <span>Left drag pan · Right drag rotate · Scroll zoom · <kbd className="rounded bg-black/30 px-1">E</kbd> edit mode</span>
      <button
        aria-label="Dismiss controls hint"
        title="Dismiss"
        onClick={() => {
          setShow(false);
          try {
            localStorage.setItem(HINT_KEY, "1");
          } catch {}
        }}
        className="rounded px-1 text-[12px] leading-none hover:bg-[#1e293b] hover:text-white"
      >
        ×
      </button>
    </div>
  );
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function RoadDrawingHUD() {
  const tool = useEditor((s) => s.tool);
  const roadDraft = useEditor((s) => s.roadDraft);
  const commitRoad = useEditor((s) => s.commitRoad);
  const cancelRoad = useEditor((s) => s.cancelRoad);

  if (tool !== "road") return null;

  return (
    <div className="pointer-events-auto absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2.5 rounded-full border border-[#0ea5e9]/60 bg-[#0f172a]/95 px-4 py-1.5 text-xs text-white shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#38bdf8] opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#38bdf8]" />
      </span>
      <span className="font-semibold text-[#38bdf8]">Road & Path Tool</span>
      <span className="text-[#cbd5e1]">
        {roadDraft.length === 0
          ? "Click anywhere on the map to start"
          : `${roadDraft.length} point${roadDraft.length > 1 ? "s" : ""} placed · Click next point · Double-click to finish`}
      </span>
      {roadDraft.length >= 2 && (
        <button
          onClick={commitRoad}
          className="rounded-md bg-[#2e7d5b] px-2.5 py-1 text-xs font-semibold text-white shadow hover:bg-[#276c4f] transition flex items-center gap-1"
        >
          Finish Road <kbd className="rounded bg-black/20 px-1 text-[10px]">Enter</kbd>
        </button>
      )}
      <button
        onClick={cancelRoad}
        className="rounded-md bg-[#334155]/80 px-2 py-1 text-xs text-[#94a3b8] hover:bg-[#475569] hover:text-white transition"
      >
        Cancel <kbd className="rounded bg-black/20 px-1 text-[10px]">Esc</kbd>
      </button>
    </div>
  );
}

export default function NeighborhoodCanvas() {
  const [webgl] = useState(webglAvailable);
  const [gesture, setGesture] = useState<"pan" | "rotate" | null>(null);
  const tool = useEditor((s) => s.tool);
  const mode = useEditor((s) => s.mode);
  const dragging = useEditor((s) => s.dragState !== null);
  // the Compare view mounts two replay canvases — pause the main one meanwhile
  const compareOpen = useEditor((s) => s.compareOpen && !!s.project?.interventionRun);
  useEffect(() => {
    const up = () => setGesture(null);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);
  const cursor = dragging
    ? "move"
    : gesture === "pan"
      ? "grabbing"
      : gesture === "rotate"
        ? "move"
        : mode === "edit" && tool !== "select"
          ? "crosshair"
          : "grab";
  const sceneTheme = useEditor((s) => s.sceneTheme) ?? "night";
  const theme = SCENE_THEMES[sceneTheme] ?? SCENE_THEMES.night;

  if (!webgl) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0b1016] p-8 text-center">
        <div className="text-2xl font-semibold text-[#e6eef7]">3D view unavailable</div>
        <p className="max-w-md text-sm text-[#9fb2c4]">
          Your browser does not have WebGL enabled, which Praesidium needs to render the
          neighborhood. Enable hardware acceleration or try a modern desktop browser. The rest
          of the application remains usable.
        </p>
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full"
      style={{ backgroundColor: theme.bg, cursor }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDownCapture={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName !== "CANVAS") return;
        setGesture(e.button === 0 ? "pan" : "rotate");
      }}
    >
      <Canvas
        orthographic
        frameloop={compareOpen ? "never" : "always"}
        dpr={[1, 1.75]}
        camera={{ position: [190, 170, 190], zoom: DEFAULT_ZOOM, near: -800, far: 4000, frustumCulled: false }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={[theme.bg]} />
        <fog attach="fog" args={[theme.bg, theme.fogNear, theme.fogFar]} />
        <Suspense fallback={null}>
          <SceneContents />
        </Suspense>
      </Canvas>

      {/* Road drawing HUD banner */}
      <RoadDrawingHUD />
      <PatrolHUD />

      <SimulationLockBadge />

      {/* canvas toolbar */}
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
        <ViewPresetButtons />
        <ModeToggle />
      </div>

      <ControlsHint />
    </div>
  );
}


