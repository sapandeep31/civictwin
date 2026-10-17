"use client";

/**
 * Flies the main camera to a planner change (apply / "show on map") and drops
 * a pulsing marker there so the user sees exactly where it landed.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useFocus, type FocusRequest } from "@/lib/store/focus";
import { useEditor } from "@/lib/store/editor";
import { chooseView } from "@/components/editor/replayCamera";

const FLY_MS = 950;
const MARKER_MS = 6000;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Fly {
  t0: number;
  from: { target: THREE.Vector3; sph: THREE.Spherical; zoom: number };
  to: { target: THREE.Vector3; theta: number; phi: number; zoom: number };
}

export function FocusFlyer() {
  const request = useFocus((s) => s.request);
  const controls = useThree((s) => s.controls) as unknown as
    | (THREE.EventDispatcher & { target: THREE.Vector3; update: () => void })
    | null;
  const get = useThree((s) => s.get);
  const fly = useRef<Fly | null>(null);

  useEffect(() => {
    if (!controls) return;
    const stop = () => {
      fly.current = null; // user grabbed the camera
    };
    (controls as any).addEventListener("start", stop);
    return () => (controls as any).removeEventListener("start", stop);
  }, [controls]);

  useEffect(() => {
    if (!request || !controls) return;
    const pts = request.points;
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const spanX = Math.max(...xs) - Math.min(...xs) + 50;
    const spanZ = Math.max(...zs) - Math.min(...zs) + 50;
    const { camera, size, gl } = get();
    // how much of THIS canvas the right-hand panel actually covers
    const rect = gl.domElement.getBoundingClientRect();
    const hidden = THREE.MathUtils.clamp(rect.right - (window.innerWidth - request.insetRight), 0, size.width - 240);
    const visW = size.width - hidden;
    const zoom = THREE.MathUtils.clamp(Math.min(visW / spanX, size.height / spanZ) * 0.75, 0.6, 7.5);

    const buildings = useEditor.getState().project?.world.buildings ?? [];
    const v = chooseView(buildings, pts.map((p) => ({ p, w: 1 })));
    const theta = v.az;
    const phi = Math.min(0.75, Math.PI / 2 - v.el);
    // shift the target right so the spot sits centred in the part of the canvas NOT under the panel
    const shift = hidden / 2 / zoom;
    const target = new THREE.Vector3(cx + Math.cos(theta) * shift, 0, cz - Math.sin(theta) * shift);

    const off = camera.position.clone().sub(controls.target);
    fly.current = {
      t0: performance.now(),
      from: { target: controls.target.clone(), sph: new THREE.Spherical().setFromVector3(off), zoom: camera.zoom },
      to: { target, theta, phi, zoom },
    };
  }, [request, controls, get]);

  useFrame((state) => {
    const f = fly.current;
    if (!f || !controls) return;
    const camera = state.camera;
    const raw = Math.min(1, (performance.now() - f.t0) / FLY_MS);
    const k = ease(raw);
    controls.target.lerpVectors(f.from.target, f.to.target, k);
    const dTheta = Math.atan2(Math.sin(f.to.theta - f.from.sph.theta), Math.cos(f.to.theta - f.from.sph.theta));
    const sph = new THREE.Spherical(f.from.sph.radius, f.from.sph.phi + (f.to.phi - f.from.sph.phi) * k, f.from.sph.theta + dTheta * k);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
    camera.zoom = f.from.zoom + (f.to.zoom - f.from.zoom) * k;
    camera.updateProjectionMatrix();
    controls.update();
    if (raw >= 1) fly.current = null;
  });

  return request ? <FocusMarkers key={request.seq} request={request} /> : null;
}

function FocusMarkers({ request }: { request: FocusRequest }) {
  const [alive, setAlive] = useState(true);
  const t0 = useRef(performance.now());
  const rings = useRef<(THREE.Mesh | null)[]>([]);
  const color = request.tone === "added" ? "#14b8a6" : "#f59e0b";

  useEffect(() => {
    const id = setTimeout(() => setAlive(false), MARKER_MS);
    return () => clearTimeout(id);
  }, []);

  useFrame(() => {
    const t = (performance.now() - t0.current) / 1000;
    const fade = Math.max(0, 1 - Math.max(0, t * 1000 - (MARKER_MS - 1200)) / 1200);
    rings.current.forEach((m, i) => {
      if (!m) return;
      const phase = ((t + i * 0.5) % 1.5) / 1.5;
      m.scale.setScalar(2 + phase * 9);
      (m.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.85 * fade;
    });
  });

  if (!alive) return null;
  const n = request.points.length;
  const mid = { x: request.points.reduce((s, p) => s + p.x, 0) / n, z: request.points.reduce((s, p) => s + p.z, 0) / n };
  return (
    <group raycast={() => null}>
      {request.points.map((p, i) => (
        <group key={i} position={[p.x, 0.15, p.z]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} ref={(m) => { rings.current[i * 2] = m; }}>
            <ringGeometry args={[0.8, 1, 40]} />
            <meshBasicMaterial color={color} transparent depthWrite={false} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} ref={(m) => { rings.current[i * 2 + 1] = m; }}>
            <ringGeometry args={[0.8, 1, 40]} />
            <meshBasicMaterial color={color} transparent depthWrite={false} />
          </mesh>
          <mesh position={[0, 6, 0]}>
            <cylinderGeometry args={[0.18, 0.18, 12, 8]} />
            <meshBasicMaterial color={color} transparent opacity={0.45} depthWrite={false} />
          </mesh>
        </group>
      ))}
      {request.label && (
        <Html position={[mid.x, 13, mid.z]} center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
          <div
            className="whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold text-white shadow-lg"
            style={{ background: request.tone === "added" ? "#0f766e" : "#b45309" }}
          >
            {request.tone === "added" ? "✓ " : ""}
            {request.label}
          </div>
        </Html>
      )}
    </group>
  );
}
