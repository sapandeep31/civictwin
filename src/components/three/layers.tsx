"use client";

/**
 * Static world layers for the Praesidium 3D scene.
 * All geometry is procedural. Instancing is used for buildings.
 */

import { useMemo, useRef, useEffect } from "react";
import * as THREE from "three";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Line as DreiLine } from "@react-three/drei";
import { useEditor, liveMove } from "@/lib/store/editor";
import type { CctvCamera, Facility, Guard, Road, Streetlight } from "@/lib/world/types";

/* ------------------------------------------------------------------ */
/* native 3D label badge (zero DOM nodes / zero createRoot)            */
/* ------------------------------------------------------------------ */

const labelTextureCache = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();

function getLabelTexture(text: string, color = "#cfe0ee", bg = "rgba(20, 29, 39, 0.88)"): { texture: THREE.CanvasTexture; aspect: number } {
  const key = `${text}_${color}_${bg}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;

  if (typeof document === "undefined") {
    const dummy = new THREE.CanvasTexture({} as never);
    return { texture: dummy, aspect: 1 };
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const dummy = new THREE.CanvasTexture(canvas);
    return { texture: dummy, aspect: 1 };
  }

  const fontSize = 28;
  const font = `600 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const textWidth = Math.max(metrics.width, 24);

  const padX = 22;
  const padY = 12;
  const w = Math.ceil(textWidth + padX * 2);
  const h = Math.ceil(fontSize + padY * 2);
  canvas.width = w;
  canvas.height = h;

  ctx.font = font;
  ctx.textBaseline = "middle";

  const r = 8;
  ctx.fillStyle = bg;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(0, 0, w, h, r);
  } else {
    ctx.rect(0, 0, w, h);
  }
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.fillText(text, padX, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const result = { texture, aspect: w / h };
  labelTextureCache.set(key, result);
  return result;
}

function LabelBadge({
  text,
  position,
  height = 2.2,
}: {
  text: string;
  position: [number, number, number];
  height?: number;
}) {
  const { texture, aspect } = useMemo(() => getLabelTexture(text), [text]);
  const width = height * aspect;

  return (
    <sprite position={position} scale={[width, height, 1]}>
      <spriteMaterial map={texture} depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

/* ------------------------------------------------------------------ */
/* shared drag helpers                                                 */
/* ------------------------------------------------------------------ */

const DRAG_THRESHOLD_PX = 6;

function setControlsEnabled(v: boolean) {
  const c = (window as any).__praesidiumControls?.current;
  if (c) c.enabled = v;
}

/**
 * Edit-mode only: select on press, but only start moving the object once the
 * pointer has travelled DRAG_THRESHOLD_PX. Orbit controls are held off for this
 * gesture so it never pans/rotates the camera while an object is grabbed.
 */
export function armPendingDrag(e: ThreeEvent<PointerEvent>, kind: "streetlight" | "camera" | "facility" | "building", id: string, offX: number, offZ: number) {
  const sx = e.nativeEvent.clientX;
  const sy = e.nativeEvent.clientY;
  setControlsEnabled(false);
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
    cleanup();
    useEditor.getState().beginDrag(kind, id, offX, offZ);
  };
  const up = () => {
    cleanup();
    if (!useEditor.getState().dragState) setControlsEnabled(true);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** Pointer handlers shared by selectable objects. Navigate mode: click selects only. */
function useObjectDrag(kind: "streetlight" | "camera" | "facility", id: string, x: number, z: number) {
  const store = useEditor;
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    const s = store.getState();
    if (e.nativeEvent.button !== 0) return; // right/middle = camera gestures
    if (s.tool !== "select" || s.mode !== "edit" || s.activeRun !== null) return;
    e.stopPropagation();
    s.select({ kind, id } as never);
    armPendingDrag(e, kind, id, x - e.point.x, z - e.point.z);
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return; // it was a camera drag, not a click
    const s = store.getState();
    if (s.tool === "select" && !s.moveMode) {
      e.stopPropagation();
      s.select({ kind, id } as never);
    }
  };
  return { onPointerDown, onClick };
}
/** Objects read liveMove during drags to show smooth movement without re-renders. */
function useLivePosition(id: string, ref: React.RefObject<THREE.Group | null>, x: number, z: number) {
  const dragging = useEditor((s) => s.dragState?.id === id);
  useFrame(() => {
    if (!ref.current) return;
    if (liveMove.id === id) {
      ref.current.position.x = liveMove.x;
      ref.current.position.z = liveMove.z;
    } else if (dragging) {
      // keep last committed position while dragging without live value
    } else {
      ref.current.position.x = x;
      ref.current.position.z = z;
    }
  });
  return dragging;
}

/* ------------------------------------------------------------------ */
/* Roads                                                               */
/* ------------------------------------------------------------------ */

export function createRoadGeometries(
  points: { x: number; z: number }[],
  width: number,
  isPath: boolean
): {
  roadGeo: THREE.BufferGeometry | null;
  curbGeo: THREE.BufferGeometry | null;
  lineGeo: THREE.BufferGeometry | null;
} {
  if (points.length < 2) {
    return { roadGeo: null, curbGeo: null, lineGeo: null };
  }

  const roadPositions: number[] = [];
  const curbPositions: number[] = [];
  const linePositions: number[] = [];

  const curbWidth = isPath ? 0.35 : 0.45;
  const halfRoad = Math.max(width / 2, 0.8);

  for (let i = 0; i + 1 < points.length; i++) {
    const p1 = new THREE.Vector2(points[i].x, points[i].z);
    const p2 = new THREE.Vector2(points[i + 1].x, points[i + 1].z);
    const dir = new THREE.Vector2(p2.x - p1.x, p2.y - p1.y);
    const len = dir.length();
    if (len < 0.01) continue;
    dir.divideScalar(len);
    const normal = new THREE.Vector2(-dir.y, dir.x);

    // Road bed vertices
    const left1 = p1.clone().addScaledVector(normal, halfRoad);
    const right1 = p1.clone().addScaledVector(normal, -halfRoad);
    const left2 = p2.clone().addScaledVector(normal, halfRoad);
    const right2 = p2.clone().addScaledVector(normal, -halfRoad);

    // Counter-clockwise triangles (normal = 0 1 0)
    roadPositions.push(
      left1.x, 0, left1.y,  left2.x, 0, left2.y,  right1.x, 0, right1.y,
      right1.x, 0, right1.y,  left2.x, 0, left2.y,  right2.x, 0, right2.y
    );

    // Left curb (normal = 0 1 0)
    const curbLeftOuter1 = p1.clone().addScaledVector(normal, halfRoad + curbWidth);
    const curbLeftOuter2 = p2.clone().addScaledVector(normal, halfRoad + curbWidth);
    curbPositions.push(
      curbLeftOuter1.x, 0, curbLeftOuter1.y, curbLeftOuter2.x, 0, curbLeftOuter2.y, left1.x, 0, left1.y,
      left1.x, 0, left1.y, curbLeftOuter2.x, 0, curbLeftOuter2.y, left2.x, 0, left2.y
    );

    // Right curb (normal = 0 1 0)
    const curbRightOuter1 = p1.clone().addScaledVector(normal, -(halfRoad + curbWidth));
    const curbRightOuter2 = p2.clone().addScaledVector(normal, -(halfRoad + curbWidth));
    curbPositions.push(
      right1.x, 0, right1.y, right2.x, 0, right2.y, curbRightOuter1.x, 0, curbRightOuter1.y,
      curbRightOuter1.x, 0, curbRightOuter1.y, right2.x, 0, right2.y, curbRightOuter2.x, 0, curbRightOuter2.y
    );

    // Centerline dashes (for roads with width >= 3)
    if (!isPath && width >= 3) {
      const dashLen = 3.0;
      const gapLen = 2.0;
      const cycle = dashLen + gapLen;
      const halfLine = 0.18;
      let d = 0.5;
      while (d + dashLen <= len) {
        const cStart = p1.clone().addScaledVector(dir, d);
        const cEnd = p1.clone().addScaledVector(dir, d + dashLen);
        const cl1 = cStart.clone().addScaledVector(normal, halfLine);
        const cr1 = cStart.clone().addScaledVector(normal, -halfLine);
        const cl2 = cEnd.clone().addScaledVector(normal, halfLine);
        const cr2 = cEnd.clone().addScaledVector(normal, -halfLine);
        linePositions.push(
          cl1.x, 0, cl1.y, cl2.x, 0, cl2.y, cr1.x, 0, cr1.y,
          cr1.x, 0, cr1.y, cl2.x, 0, cl2.y, cr2.x, 0, cr2.y
        );
        d += cycle;
      }
    }
  }

  // Smooth circular joint caps at corners
  const segs = 12;
  for (let i = 0; i < points.length; i++) {
    const cp = points[i];
    // Road joint
    for (let s = 0; s < segs; s++) {
      const th1 = (s / segs) * Math.PI * 2;
      const th2 = ((s + 1) / segs) * Math.PI * 2;
      roadPositions.push(
        cp.x, 0, cp.z,
        cp.x + Math.cos(th2) * halfRoad, 0, cp.z + Math.sin(th2) * halfRoad,
        cp.x + Math.cos(th1) * halfRoad, 0, cp.z + Math.sin(th1) * halfRoad
      );
      // Curb outer ring (normal = 0 1 0)
      curbPositions.push(
        cp.x + Math.cos(th2) * halfRoad, 0, cp.z + Math.sin(th2) * halfRoad,
        cp.x + Math.cos(th2) * (halfRoad + curbWidth), 0, cp.z + Math.sin(th2) * (halfRoad + curbWidth),
        cp.x + Math.cos(th1) * halfRoad, 0, cp.z + Math.sin(th1) * halfRoad,

        cp.x + Math.cos(th1) * halfRoad, 0, cp.z + Math.sin(th1) * halfRoad,
        cp.x + Math.cos(th2) * (halfRoad + curbWidth), 0, cp.z + Math.sin(th2) * (halfRoad + curbWidth),
        cp.x + Math.cos(th1) * (halfRoad + curbWidth), 0, cp.z + Math.sin(th1) * (halfRoad + curbWidth)
      );
    }
  }

  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(roadPositions, 3));
  roadGeo.computeVertexNormals();

  const curbGeo = new THREE.BufferGeometry();
  curbGeo.setAttribute("position", new THREE.Float32BufferAttribute(curbPositions, 3));
  curbGeo.computeVertexNormals();

  let lineGeo: THREE.BufferGeometry | null = null;
  if (linePositions.length > 0) {
    lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
    lineGeo.computeVertexNormals();
  }

  return { roadGeo, curbGeo, lineGeo };
}

export function RoadsLayer({
  roads,
  coverage,
  selectedId,
  theme = "night",
}: {
  roads: Road[];
  coverage: Map<string, number> | null;
  selectedId: string | null;
  theme?: "night" | "sunset" | "daylight";
}) {
  const select = useEditor((s) => s.select);
  // Every edit deep-clones the world, so `roads` is a new array on every slider tick. Rebuild the
  // GPU geometry only when the road SHAPES change, and free the old buffers when they do.
  const shapeSig = useMemo(() => roads.map((r) => `${r.width}|${r.category}|${r.points.map((p) => `${p.x},${p.z}`).join(";")}`).join("#"), [roads]);
  const geos = useMemo(
    () => roads.map((r) => createRoadGeometries(r.points, r.width, r.category === "path")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shapeSig]
  );
  useEffect(
    () => () =>
      geos.forEach((g) => {
        g.roadGeo?.dispose();
        g.curbGeo?.dispose();
        g.lineGeo?.dispose();
      }),
    [geos]
  );
  const geometries = roads.map((road, i) => ({ road, ...(geos[i] ?? { roadGeo: null, curbGeo: null, lineGeo: null }) }));

  return (
    <group>
      {geometries.map(({ road, roadGeo, curbGeo, lineGeo }) => {
        if (!roadGeo) return null;
        const frac = coverage?.get(road.id);
        const isPath = road.category === "path";
        const isSelected = selectedId === road.id;

        // Base theme colors for road asphalt surface
        let roadColor =
          theme === "daylight"
            ? isPath
              ? "#94a3b8"
              : "#3b4a5e"
            : theme === "sunset"
            ? isPath
              ? "#4a3c36"
              : "#332a26"
            : isPath
            ? "#293c54"
            : "#222f42";

        let emissive = "#000000";
        let emissiveIntensity = 0;

        // Coverage heatmap
        if (frac !== undefined) {
          if (frac >= 0.75) {
            roadColor = "#10b981";
            emissive = "#059669";
            emissiveIntensity = 0.35;
          } else if (frac >= 0.35) {
            roadColor = "#f59e0b";
            emissive = "#d97706";
            emissiveIntensity = 0.28;
          } else {
            roadColor = "#f43f5e";
            emissive = "#e11d48";
            emissiveIntensity = 0.4;
          }
        }

        // Curb color
        const curbColor = isSelected
          ? "#38bdf8"
          : theme === "daylight"
          ? "#94a3b8"
          : theme === "sunset"
          ? "#6b5c54"
          : "#3d5270";

        // Centerline color
        const lineColor = isSelected
          ? "#ffffff"
          : theme === "daylight"
          ? "#f8fafc"
          : theme === "sunset"
          ? "#fbbf24"
          : "#ffffff";

        const y = isPath ? 0.075 : 0.065;

        return (
          <group key={road.id}>
            {/* Curbs along road edges */}
            {curbGeo && (
              <mesh geometry={curbGeo} position={[0, y - 0.005, 0]}>
                <meshStandardMaterial
                  color={curbColor}
                  roughness={0.8}
                  emissive={isSelected ? "#0284c7" : "#000000"}
                  emissiveIntensity={isSelected ? 0.3 : 0}
                />
              </mesh>
            )}

            {/* Road surface */}
            <mesh
              geometry={roadGeo}
              position={[0, y, 0]}
              onClick={(e) => {
                e.stopPropagation();
                if (e.delta > 4) return;
                const s = useEditor.getState();
                if (s.tool === "select" && !s.moveMode) {
                  select({ kind: "road", id: road.id });
                } else if (s.tool === "road") {
                  handlePlacementAtPoint({ x: Math.round(e.point.x), z: Math.round(e.point.z) });
                } else {
                  handlePlacementAtPoint({ x: e.point.x, z: e.point.z });
                }
              }}
            >
              <meshStandardMaterial
                color={isSelected ? "#0284c7" : roadColor}
                emissive={isSelected ? "#38bdf8" : emissive}
                emissiveIntensity={isSelected ? 0.4 : emissiveIntensity}
                roughness={0.7}
                side={THREE.DoubleSide}
                polygonOffset
                polygonOffsetFactor={-1}
                polygonOffsetUnits={-2}
                vertexColors={false}
              />
            </mesh>

            {/* Centerline dashes */}
            {lineGeo && (
              <mesh geometry={lineGeo} position={[0, y + 0.015, 0]}>
                <meshBasicMaterial
                  color={lineColor}
                  transparent
                  opacity={isSelected ? 1.0 : theme === "night" ? 0.85 : 0.75}
                  side={THREE.DoubleSide}
                  depthWrite={false}
                />
              </mesh>
            )}

            {/* Selection label */}
            {isSelected && (
              <LabelBadge
                text={road.name ?? `${road.category === "path" ? "Path" : "Road"} (${road.width}m)`}
                position={[road.points[0].x, 3.2, road.points[0].z]}
                height={2.2}
              />
            )}
          </group>
        );
      })}
    </group>
  );
}

function handlePlacementAtPoint(p: { x: number; z: number }) {
  const s = useEditor.getState();
  if (s.moveMode && s.selection) {
    s.moveObject(s.selection, p.x, p.z);
    s.setMoveMode(false);
    return;
  }
  switch (s.tool) {
    case "streetlight":
      s.addStreetlight(p.x, p.z);
      break;
    case "camera":
      s.addCamera(p.x, p.z);
      break;
    case "guard":
      s.guardToolClick(p); // left-click extends the selected guard; right-click drops guards
      break;
    case "building":
      s.addBuilding(p.x, p.z);
      break;
    case "facility":
      s.addFacility(p.x, p.z);
      break;
    case "road":
      s.pushRoadPoint(p);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Buildings                                                           */
/* ------------------------------------------------------------------ */

export { BuildingsLayer } from "./buildings";

/* ------------------------------------------------------------------ */
/* Facilities                                                          */
/* ------------------------------------------------------------------ */

const FACILITY_COLORS: Record<string, string> = {
  bus_stop: "#0284c7",          // Electric Transit Blue
  park: "#16a34a",              // Lush Vibrant Emerald
  community_centre: "#0d9488",  // Civic Teal
  market: "#f59e0b",            // Bright Solar Amber
  school: "#8b5cf6",            // Royal Purple
  clinic: "#ef4444",            // Emergency Medical Crimson
  atm: "#10b981",               // Bright Mint
  place_of_worship: "#d97706",  // Luminous Ochre Gold
  other: "#64748b",             // Modern Slate
};

function hashNum(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function FacilityNode({ f, selected, showLabel }: { f: Facility; selected: boolean; showLabel: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const dragHandlers = useObjectDrag("facility", f.id, f.x, f.z);
  useLivePosition(f.id, ref, f.x, f.z);
  const color = FACILITY_COLORS[f.type] ?? FACILITY_COLORS.other;
  const isPark = f.type === "park";
  const r = f.radius ?? 6;

  const trees = useMemo(() => {
    if (!isPark) return [];
    const h = hashNum(f.id);
    const n = 5 + (h % 5);
    return Array.from({ length: n }, (_, i) => {
      const a = ((h + i * 97) % 360) * (Math.PI / 180);
      const rad = r * (0.3 + (((h >> i) % 100) / 100) * 0.6);
      return { x: Math.cos(a) * rad, z: Math.sin(a) * rad, s: 1.4 + ((h >> (i + 3)) % 10) / 10 };
    });
  }, [f.id, isPark, r]);

  return (
    <group ref={ref} position={[f.x, 0, f.z]}>
      <group
        onPointerDown={dragHandlers.onPointerDown}
        onClick={dragHandlers.onClick}
        onPointerUp={(e) => {
          e.stopPropagation();
          const s = useEditor.getState();
          if (s.dragState) s.endDrag();
        }}
      >
        {isPark ? (
          <>
            {/* Lush grass circle */}
            <mesh position={[0, 0.045, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[r, 36]} />
              <meshStandardMaterial color={selected ? "#22c55e" : "#15803d"} roughness={0.8} />
            </mesh>
            {/* Stone curb border */}
            <mesh position={[0, 0.048, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[r - 0.45, r, 36]} />
              <meshStandardMaterial color="#334155" roughness={0.9} />
            </mesh>
            {trees.map((t, i) => (
              <group key={i} position={[t.x, 0, t.z]}>
                <mesh position={[0, 1.1 * t.s, 0]}>
                  <cylinderGeometry args={[0.12, 0.16, 2.2 * t.s, 5]} />
                  <meshStandardMaterial color="#78350f" roughness={0.85} />
                </mesh>
                <mesh position={[0, 2.8 * t.s, 0]}>
                  <coneGeometry args={[1.5 * t.s, 3 * t.s, 7]} />
                  <meshStandardMaterial
                    color={i % 2 === 0 ? "#22c55e" : "#16a34a"}
                    roughness={0.8}
                    emissive="#15803d"
                    emissiveIntensity={0.12}
                  />
                </mesh>
              </group>
            ))}
          </>
        ) : (
          <>
            {/* Ground pedestal */}
            <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[3.2, 24]} />
              <meshStandardMaterial color="#1e293b" roughness={0.8} />
            </mesh>
            {/* Illuminated color beacon ring */}
            <mesh position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[2.7, 3.2, 24]} />
              <meshBasicMaterial color={color} transparent opacity={0.85} />
            </mesh>
            <mesh position={[0, 1.4, 0]}>
              <boxGeometry args={[3.4, 2.8, 2.6]} />
              <meshStandardMaterial
                color={selected ? "#38bdf8" : color}
                emissive={color}
                emissiveIntensity={0.2}
                roughness={0.65}
              />
            </mesh>
            <mesh position={[0, 3, 0]}>
              <boxGeometry args={[3.8, 0.4, 3]} />
              <meshStandardMaterial color="#0f172a" roughness={0.5} />
            </mesh>
            {f.type === "place_of_worship" && (
              <mesh position={[0, 4.6, 0]}>
                <coneGeometry args={[0.7, 2.4, 6]} />
                <meshStandardMaterial color="#fbbf24" emissive="#d97706" emissiveIntensity={0.3} />
              </mesh>
            )}
          </>
        )}
      </group>
      {showLabel && (
        <LabelBadge
          text={f.name ?? f.type}
          position={[0, isPark ? 7 : 6, 0]}
          height={2.5}
        />
      )}
    </group>
  );
}

export function FacilitiesLayer({
  facilities,
  showLabels,
  selectedId,
}: {
  facilities: Facility[];
  showLabels: boolean;
  selectedId: string | null;
}) {
  return (
    <group>
      {facilities.map((f) => (
        <FacilityNode key={f.id} f={f} selected={selectedId === f.id} showLabel={showLabels} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Streetlights                                                        */
/* ------------------------------------------------------------------ */

function makePoolTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255, 248, 200, 0.85)");
  grad.addColorStop(0.25, "rgba(254, 215, 102, 0.55)");
  grad.addColorStop(0.65, "rgba(245, 158, 11, 0.20)");
  grad.addColorStop(1, "rgba(217, 119, 6, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

let poolTexture: THREE.Texture | null = null;
function getPoolTexture(): THREE.Texture {
  if (!poolTexture) poolTexture = makePoolTexture();
  return poolTexture;
}

function StreetlightNode({ l, selected, showPool }: { l: Streetlight; selected: boolean; showPool: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const dragHandlers = useObjectDrag("streetlight", l.id, l.x, l.z);
  const dragging = useLivePosition(l.id, ref, l.x, l.z);
  const lit = l.on && l.maintenance === "ok";

  return (
    <group ref={ref} position={[l.x, 0, l.z]}>
      <group
        onPointerDown={dragHandlers.onPointerDown}
        onClick={dragHandlers.onClick}
        onPointerUp={(e) => {
          e.stopPropagation();
          const s = useEditor.getState();
          if (s.dragState) s.endDrag();
        }}
      >
        <mesh position={[0, l.height / 2, 0]}>
          <cylinderGeometry args={[0.09, 0.14, l.height, 6]} />
          <meshStandardMaterial color={selected ? "#38bdf8" : "#94a3b8"} roughness={0.6} />
        </mesh>
        <mesh position={[0, l.height + 0.25, 0]}>
          <sphereGeometry args={[0.36, 12, 10]} />
          <meshStandardMaterial
            color={lit ? "#fffbeb" : "#475569"}
            emissive={lit ? "#fde047" : "#000000"}
            emissiveIntensity={lit ? 3.0 : 0}
          />
        </mesh>
        {showPool && lit && !dragging && (
          <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[l.radius, 32]} />
            <meshBasicMaterial
              map={getPoolTexture()}
              transparent
              opacity={0.35 + l.brightness * 0.45}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </mesh>
        )}
        {selected && (
          <mesh position={[0, 0.07, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[1.1, 1.4, 24]} />
            <meshBasicMaterial color="#38bdf8" />
          </mesh>
        )}
      </group>
    </group>
  );
}

export function StreetlightsLayer({
  lights,
  showPools,
  selectedId,
}: {
  lights: Streetlight[];
  showPools: boolean;
  selectedId: string | null;
}) {
  return (
    <group>
      {lights.map((l) => (
        <StreetlightNode key={l.id} l={l} selected={selectedId === l.id} showPool={showPools} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* CCTV cameras                                                        */
/* ------------------------------------------------------------------ */

const deg2rad = (d: number) => (d * Math.PI) / 180;

function CameraNode({ c, selected, showFov }: { c: CctvCamera; selected: boolean; showFov: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const dragHandlers = useObjectDrag("camera", c.id, c.x, c.z);
  useLivePosition(c.id, ref, c.x, c.z);
  const thetaStart = -(deg2rad(c.orientationDeg) + deg2rad(c.fovDeg) / 2);
  const thetaLen = deg2rad(c.fovDeg);

  return (
    <group ref={ref} position={[c.x, 0, c.z]}>
      <group
        onPointerDown={dragHandlers.onPointerDown}
        onClick={dragHandlers.onClick}
        onPointerUp={(e) => {
          e.stopPropagation();
          const s = useEditor.getState();
          if (s.dragState) s.endDrag();
        }}
      >
        <mesh position={[0, c.height / 2, 0]}>
          <cylinderGeometry args={[0.07, 0.1, c.height, 6]} />
          <meshStandardMaterial color="#64748b" />
        </mesh>
        <mesh position={[0, c.height, 0]} rotation={[0, -deg2rad(c.orientationDeg), 0]}>
          <boxGeometry args={[0.9, 0.35, 0.4]} />
          <meshStandardMaterial
            color={c.active ? (selected ? "#38bdf8" : "#0ea5e9") : "#475569"}
            emissive={c.active ? "#06b6d4" : "#000"}
            emissiveIntensity={2.5}
          />
        </mesh>
        {showFov && c.active && (
          <mesh position={[0, 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[c.range, 32, thetaStart, thetaLen]} />
            <meshBasicMaterial color="#06b6d4" transparent opacity={0.16} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        )}
        {selected && (
          <mesh position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[1.1, 1.4, 24]} />
            <meshBasicMaterial color="#06b6d4" />
          </mesh>
        )}
      </group>
    </group>
  );
}

export function CamerasLayer({
  cameras,
  showFov,
  selectedId,
}: {
  cameras: CctvCamera[];
  showFov: boolean;
  selectedId: string | null;
}) {
  return (
    <group>
      {cameras.map((c) => (
        <CameraNode key={c.id} c={c} selected={selectedId === c.id} showFov={showFov} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Guards (editor view — waypoints + route)                            */
/* ------------------------------------------------------------------ */

function GuardNode({ g, selected, showRoute }: { g: Guard; selected: boolean; showRoute: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const home = g.waypoints[0] ?? { x: 0, z: 0 };
  useLivePosition(g.id, ref, home.x, home.z);

  const routePoints = useMemo(
    () => (g.waypoints.length ? [...g.waypoints, g.waypoints[0]].map((w) => [w.x, 0.4, w.z] as [number, number, number]) : []),
    [g.waypoints]
  );

  return (
    <group>
      {routePoints.length > 1 && (
        <DreiLine
          points={routePoints}
          color={selected ? "#fef08a" : "#facc15"}
          lineWidth={selected ? 2.5 : 1.8}
          dashed
          dashSize={2}
          gapSize={1.2}
          visible={showRoute}
        />
      )}
      <group ref={ref} position={[home.x, 0, home.z]}>
        <group
          onClick={(e) => {
            e.stopPropagation();
            if (e.delta > 4) return;
            const s = useEditor.getState();
            if (s.tool !== "select") return;
            s.select({ kind: "guard", id: g.id });
          }}
        >
          <mesh position={[0, 1.05, 0]}>
            <capsuleGeometry args={[0.38, 1.15, 4, 10]} />
            <meshStandardMaterial
              color={selected ? "#fef08a" : "#eab308"}
              emissive="#ca8a04"
              emissiveIntensity={0.25}
              roughness={0.65}
            />
          </mesh>
          <mesh position={[0, 1.85, 0]}>
            <sphereGeometry args={[0.28, 10, 8]} />
            <meshStandardMaterial color="#0f172a" />
          </mesh>
          {selected && (
            <mesh position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[1, 1.3, 24]} />
              <meshBasicMaterial color="#facc15" />
            </mesh>
          )}
        </group>
      </group>
    </group>
  );
}

export function GuardsLayer({ guards, showRoutes, selectedId }: { guards: Guard[]; showRoutes: boolean; selectedId: string | null }) {
  return (
    <group>
      {guards.map((g) => (
        <GuardNode key={g.id} g={g} selected={selectedId === g.id} showRoute={showRoutes} />
      ))}
    </group>
  );
}

