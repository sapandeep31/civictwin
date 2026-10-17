"use client";

/**
 * Site layers for geo/satellite imports: satellite ground texture, compound
 * walls, gates, guard booths, parking lots and likely dark zones. Everything
 * here is optional world data (world.site / source.geo) and renders nothing
 * for demo or blank projects.
 */

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useEditor } from "@/lib/store/editor";
import type { SiteArea, SiteGate, SiteWall, World } from "@/lib/world/types";

const GATE_COLORS: Record<SiteGate["kind"], string> = { main: "#e8a33d", service: "#7aa6d8", pedestrian: "#8fd19e" };

function SatelliteGround({ url, width, depth, night }: { url: string; width: number; depth: number; night: boolean }) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    let alive = true;
    let t: THREE.Texture | null = null;
    new THREE.TextureLoader().load(url, (loaded) => {
      if (!alive) return loaded.dispose();
      loaded.colorSpace = THREE.SRGBColorSpace;
      loaded.anisotropy = 4;
      t = loaded;
      setTex(loaded);
    });
    return () => {
      alive = false;
      t?.dispose();
    };
  }, [url]);
  if (!tex) return null;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]} renderOrder={-1} raycast={() => null}>
      <planeGeometry args={[width, depth]} />
      {/* pushed BACK (positive offset) so roads/paths/areas always win the depth test at oblique angles */}
      <meshBasicMaterial map={tex} color={night ? "#6f7a8c" : "#ffffff"} toneMapped={false} polygonOffset polygonOffsetFactor={2} polygonOffsetUnits={4} />
    </mesh>
  );
}

/** Half-width of the opening a gate cuts into the compound wall. */
function gateHalf(g: SiteGate) {
  return g.kind === "main" ? 4.6 : 2.6;
}

function Wall({ wall, gates }: { wall: SiteWall; gates: SiteGate[] }) {
  const segs = useMemo(() => {
    const pts = wall.closed ? [...wall.points, wall.points[0]] : wall.points;
    const out: { x: number; z: number; len: number; ang: number; pillar: boolean }[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.5) continue;
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      // cut openings where gates sit on this segment
      const cuts: [number, number][] = [];
      for (const g of gates) {
        const t = (g.x - a.x) * ux + (g.z - a.z) * uz;
        const off = Math.abs((g.x - a.x) * uz - (g.z - a.z) * ux);
        if (off < 2 && t > -1 && t < len + 1) cuts.push([t - gateHalf(g), t + gateHalf(g)]);
      }
      cuts.sort((p, q) => p[0] - q[0]);
      let s0 = 0;
      const pieces: [number, number][] = [];
      for (const [c0, c1] of cuts) {
        if (c0 > s0) pieces.push([s0, Math.min(c0, len)]);
        s0 = Math.max(s0, c1);
      }
      if (s0 < len) pieces.push([s0, len]);
      const ang = -Math.atan2(b.z - a.z, b.x - a.x);
      for (const [p0, p1] of pieces) {
        if (p1 - p0 < 0.3) continue;
        const m = (p0 + p1) / 2;
        out.push({ x: a.x + ux * m, z: a.z + uz * m, len: p1 - p0, ang, pillar: false });
      }
      // brick pillars every ~12 m for a believable compound wall
      for (let d = 0; d <= len; d += 12) {
        if (cuts.some(([c0, c1]) => d > c0 - 0.5 && d < c1 + 0.5)) continue;
        out.push({ x: a.x + ux * d, z: a.z + uz * d, len: 0.7, ang, pillar: true });
      }
    }
    return out;
  }, [wall, gates]);
  const h = wall.height;
  return (
    <group raycast={() => null}>
      {segs.map((s, i) =>
        s.pillar ? (
          <mesh key={i} position={[s.x, (h + 0.35) / 2, s.z]} rotation={[0, s.ang, 0]} raycast={() => null}>
            <boxGeometry args={[0.7, h + 0.35, 0.6]} />
            <meshStandardMaterial color="#a7967c" roughness={0.9} />
          </mesh>
        ) : (
          <group key={i} position={[s.x, 0, s.z]} rotation={[0, s.ang, 0]}>
            <mesh position={[0, h / 2, 0]} raycast={() => null}>
              <boxGeometry args={[s.len + 0.05, h, 0.35]} />
              <meshStandardMaterial color="#d8c8a8" roughness={0.92} emissive="#4a4030" emissiveIntensity={0.55} />
            </mesh>
            {/* coping + a strand of barbed wire on top */}
            <mesh position={[0, h + 0.05, 0]} raycast={() => null}>
              <boxGeometry args={[s.len + 0.1, 0.1, 0.45]} />
              <meshStandardMaterial color="#8f8470" roughness={0.9} />
            </mesh>
            <mesh position={[0, h + 0.4, 0]} raycast={() => null}>
              <boxGeometry args={[s.len, 0.04, 0.04]} />
              <meshStandardMaterial color="#5b5f66" metalness={0.6} roughness={0.5} />
            </mesh>
          </group>
        )
      )}
    </group>
  );
}

function Gate({ gate }: { gate: SiteGate }) {
  const c = GATE_COLORS[gate.kind];
  const half = gateHalf(gate);
  const main = gate.kind === "main";
  // the gate line runs along x; walls here are axis-aligned — rotate for gates on east/west walls
  const site = useEditor((s) => s.project?.world.site);
  const wall = site?.walls.find((w) => w.closed);
  let rot = 0;
  if (wall) {
    const xs = wall.points.map((p) => p.x);
    if (Math.min(...xs.map((x) => Math.abs(x - gate.x))) < 2) rot = Math.PI / 2;
  }
  const pillarH = main ? 4.2 : 3;
  return (
    <group position={[gate.x, 0, gate.z]} rotation={[0, rot, 0]} raycast={() => null}>
      {[-half - 0.5, half + 0.5].map((dx) => (
        <group key={dx}>
          <mesh position={[dx, pillarH / 2, 0]} raycast={() => null}>
            <boxGeometry args={[1, pillarH, 1]} />
            <meshStandardMaterial color="#e3d8c4" roughness={0.8} />
          </mesh>
          <mesh position={[dx, pillarH + 0.25, 0]} raycast={() => null}>
            <boxGeometry args={[1.3, 0.5, 1.3]} />
            <meshStandardMaterial color="#b08d5b" />
          </mesh>
          {main && (
            <mesh position={[dx, pillarH + 0.75, 0]} raycast={() => null}>
              <sphereGeometry args={[0.32, 12, 8]} />
              <meshBasicMaterial color="#fff1c4" toneMapped={false} />
            </mesh>
          )}
        </group>
      ))}
      {main ? (
        <>
          {/* name arch with a warm-lit signboard */}
          <mesh position={[0, pillarH + 0.6, 0]} raycast={() => null}>
            <boxGeometry args={[2 * half + 2, 0.9, 0.5]} />
            <meshStandardMaterial color="#7a4b2a" />
          </mesh>
          <mesh position={[0, pillarH + 0.6, 0.27]} raycast={() => null}>
            <planeGeometry args={[2 * half, 0.6]} />
            <meshBasicMaterial color="#ffcf7a" toneMapped={false} />
          </mesh>
          <mesh position={[0, pillarH + 0.6, -0.27]} rotation={[0, Math.PI, 0]} raycast={() => null}>
            <planeGeometry args={[2 * half, 0.6]} />
            <meshBasicMaterial color="#ffcf7a" toneMapped={false} />
          </mesh>
          {/* sliding iron gate, pulled half open */}
          <mesh position={[-half * 0.75, 0.95, 0.6]} raycast={() => null}>
            <boxGeometry args={[half * 1.1, 1.7, 0.1]} />
            <meshStandardMaterial color="#2f3540" metalness={0.5} roughness={0.5} />
          </mesh>
          {/* boom barrier */}
          <mesh position={[half * 0.1, 1.05, -1.2]} raycast={() => null}>
            <boxGeometry args={[half * 1.7, 0.14, 0.14]} />
            <meshStandardMaterial color="#e5e7eb" emissive="#ef4444" emissiveIntensity={0.25} />
          </mesh>
        </>
      ) : (
        <>
          {/* closed grille gate + padlock */}
          <mesh position={[0, 1.1, 0]} raycast={() => null}>
            <boxGeometry args={[2 * half, 2.2, 0.1]} />
            <meshStandardMaterial color="#3a3f48" metalness={0.5} roughness={0.55} />
          </mesh>
          <mesh position={[0.3, 1.1, 0.12]} raycast={() => null}>
            <boxGeometry args={[0.25, 0.3, 0.12]} />
            <meshStandardMaterial color="#c9a227" metalness={0.7} roughness={0.3} />
          </mesh>
        </>
      )}
      {gate.inferred && (
        <>
          <mesh position={[0, 7, 0]} raycast={() => null}>
            <octahedronGeometry args={[1.1]} />
            <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.9} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]} raycast={() => null}>
            <ringGeometry args={[4.2, 5, 32]} />
            <meshBasicMaterial color={c} transparent opacity={0.7} />
          </mesh>
        </>
      )}
    </group>
  );
}

function Area({ area }: { area: SiteArea }) {
  if (area.kind === "open") return null;
  const dark = area.kind === "dark";
  return (
    <mesh position={[area.x, dark ? 0.07 : 0.05, area.z]} rotation={[-Math.PI / 2, 0, area.rotation]} raycast={() => null}>
      <planeGeometry args={[area.width, area.depth]} />
      <meshBasicMaterial color={dark ? "#3b1f5c" : "#8b93a1"} transparent opacity={dark ? 0.45 : 0.35} depthWrite={false} />
    </mesh>
  );
}

/**
 * Orthographic zoom that fits the current world bounds in the viewport.
 * Geo imports only (demo/blank keep the default 2.2) — clamped to [0.6, 2.2].
 */
/** Default ortho zoom for non-geo (demo/blank) worlds — framed close so people are legible. */
export const DEFAULT_ZOOM = 4.5;

export function fitZoom(cam: THREE.Camera): number {
  const p = useEditor.getState().project;
  const o = cam as THREE.OrthographicCamera;
  if (!p?.source.geo || !o.isOrthographicCamera) {
    // walled (non-geo) sites such as the demo society: frame the whole compound
    const wall = p?.world.site?.walls.find((w) => w.closed && w.points.length >= 3);
    if (!wall || !o.isOrthographicCamera) return DEFAULT_ZOOM;
    const xs = wall.points.map((q) => q.x);
    const zs = wall.points.map((q) => q.z);
    const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    const byW = (o.right - o.left) / (ext * 1.35);
    const byH = (o.top - o.bottom) / (ext * 0.95);
    return Math.max(1.5, Math.min(DEFAULT_ZOOM, byW, byH));
  }
  const e = contentExtent(p.world);
  const span = (e.width + e.depth) * 0.72; // footprint diagonal as seen from the iso/top views
  const z = Math.min((o.right - o.left) / span, (o.top - o.bottom) / (span * 0.62)) * 0.92;
  return Math.max(0.6, Math.min(DEFAULT_ZOOM, z));
}

/**
 * Extent of what was actually built: the compound wall when there is one, else
 * the buildings. The captured bounds are the selection's north-up box, which for
 * a tilted or irregular society is mostly empty — framing it leaves the twin tiny
 * and off-centre.
 */
export function contentExtent(w: World): { cx: number; cz: number; width: number; depth: number } {
  const wall = w.site?.walls.find((x) => x.closed && x.points.length >= 3);
  const pts = wall ? wall.points : w.buildings.flatMap((b) => [{ x: b.x - b.width / 2, z: b.z - b.depth / 2 }, { x: b.x + b.width / 2, z: b.z + b.depth / 2 }]);
  if (pts.length < 2) return { cx: 0, cz: 0, width: w.bounds.width, depth: w.bounds.depth };
  const xs = pts.map((q) => q.x);
  const zs = pts.map((q) => q.z);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, width: Math.max(60, x1 - x0), depth: Math.max(60, z1 - z0) };
}

function FitGeoCamera() {
  const projectId = useEditor((s) => s.project?.projectId);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const size = useThree((s) => s.size);
  useEffect(() => {
    const pr = useEditor.getState().project;
    if (!pr?.source.geo && !pr?.world.site?.walls.some((w) => w.closed)) return;
    const o = camera as THREE.OrthographicCamera;
    if (pr.source.geo && controls) {
      // re-centre on the society, keeping the current viewing angle
      const e = contentExtent(pr.world);
      const off = o.position.clone().sub(controls.target);
      controls.target.set(e.cx, 0, e.cz);
      o.position.copy(controls.target).add(off);
      controls.update();
    }
    o.zoom = fitZoom(o);
    o.updateProjectionMatrix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, camera, controls, size.width > 0]);
  return null;
}

export function SiteLayers() {
  const site = useEditor((s) => s.project?.world.site);
  const geo = useEditor((s) => s.project?.source.geo);
  const bounds = useEditor((s) => s.project?.world.bounds);
  const layers = useEditor((s) => s.layers);
  const night = (useEditor((s) => s.sceneTheme) ?? "night") === "night";
  if (!bounds) return null;
  return (
    <group>
      <FitGeoCamera />
      {geo?.satelliteImage && layers.satellite !== false && (
        <SatelliteGround url={geo.satelliteImage} width={bounds.width} depth={bounds.depth} night={night} />
      )}
      {site && layers.site !== false && (
        <>
          {site.walls.map((w) => (
            <Wall key={w.id} wall={w} gates={site.gates} />
          ))}
          {site.gates.map((g) => (
            <Gate key={g.id} gate={g} />
          ))}
          {site.areas.map((a) => (
            <Area key={a.id} area={a} />
          ))}
          {site.booths.map((b) => (
            <group key={b.id} position={[b.x, 0, b.z]} raycast={() => null}>
              <mesh position={[0, 1.3, 0]} raycast={() => null}>
                <boxGeometry args={[2.2, 2.6, 2.2]} />
                <meshStandardMaterial color="#e9e2d2" />
              </mesh>
              <mesh position={[0, 2.75, 0]} raycast={() => null}>
                <boxGeometry args={[2.8, 0.3, 2.8]} />
                <meshStandardMaterial color="#e8a33d" emissive="#e8a33d" emissiveIntensity={0.4} />
              </mesh>
            </group>
          ))}
        </>
      )}
    </group>
  );
}

