"use client";

/**
 * Procedural, instanced, rigged-ish humanoid characters.
 *
 * Every actor (pedestrian, guard, perpetrator) is a fixed "slot" in a set of
 * InstancedMeshes, one per body part (torso, head, hair/cap/hood, 2 legs,
 * 2 arms, pack/vest, torch, light cone, ground ring). Each frame the pose
 * (walk / run / sneak / crouch / punch / panic / sit / surrender) is turned
 * into per-part matrices on the CPU: ~270 actors x 11 parts = 3 k matrices,
 * 12 draw calls total.
 *
 * Positions come from precomputed sim frames (lerped); facing comes from the
 * movement direction. Drama fields (perpPos, perpState, agentDrama,
 * guardCondition) are optional — when absent, no perpetrators render.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useSceneClock, useScenePlay, useSceneRun } from "./sceneSource";
import { AGENT_STATE, GUARD_STATE, type Frame } from "@/lib/sim/engine";
import {
  GUARD_CONDITION,
  PERP_STATE,
  VICTIM_STATE,
  type DramaFrame,
} from "@/lib/sim/incidents";

/** Characters are drawn at "gameplay scale" so they read from the iso camera. */
export const CHAR_SCALE = 3.4;

type F = Frame & Partial<DramaFrame>;

/* ------------------------------------------------------------------ */
/* Kits                                                                */
/* ------------------------------------------------------------------ */

const KIT = { RESIDENT: 0, COMMUTER: 1, RIDER: 2, GUARD: 3, PERP: 4 } as const;

const SKIN = ["#f1c6a0", "#d9a074", "#b9794f", "#8d5a3a", "#6b4129", "#e8b894"];
const HAIR = ["#1b1410", "#2c1d12", "#4a3320", "#0e0e10", "#6b6b70", "#8a5a2b"];
const RES_TOPS = ["#e2e8f0", "#f59e0b", "#34d399", "#f472b6", "#a78bfa", "#fb7185", "#60a5fa", "#fde68a"];
const RES_BOTTOMS = ["#1e293b", "#334155", "#3b2f2f", "#1f3b4d", "#2a2a35"];
const COM_TOPS = ["#38bdf8", "#22d3ee", "#7dd3fc", "#94a3b8", "#818cf8", "#2dd4bf"];
const PERP_HOOD = ["#15151b", "#1c1822", "#101418", "#1b1414", "#14181a"];

function hash(i: number): number {
  let h = (i + 1) * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967295;
}
function pick<T>(arr: T[], i: number, salt: number): T {
  return arr[Math.floor(hash(i * 7 + salt) * arr.length) % arr.length];
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const LEG_LEN = 0.9;

function buildGeometries() {
  const leg = new THREE.CapsuleGeometry(0.085, 0.72, 3, 6).translate(0, -0.46, 0);
  const arm = new THREE.CapsuleGeometry(0.06, 0.46, 3, 6).translate(0, -0.3, 0);
  const torso = new THREE.CapsuleGeometry(0.2, 0.3, 4, 8).scale(1, 1, 0.62).translate(0, 0.36, 0);
  const head = new THREE.SphereGeometry(0.14, 10, 8);
  const hair = new THREE.SphereGeometry(0.155, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.58).translate(0, 0.01, 0);
  const brim = new THREE.BoxGeometry(0.2, 0.02, 0.13).translate(0, 0, 0.07);
  const pack = new THREE.BoxGeometry(0.3, 0.4, 0.14);
  const skirt = new THREE.CylinderGeometry(0.2, 0.3, 0.62, 12, 1, true).translate(0, -0.27, 0);
  const torch = new THREE.CylinderGeometry(0.03, 0.042, 0.24, 6).rotateX(Math.PI / 2);
  const CONE_H = 5;
  const cone = new THREE.ConeGeometry(2.1, CONE_H, 20, 1, true).translate(0, -CONE_H / 2, 0).rotateX(-Math.PI / 2);
  const ring = new THREE.RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2);
  return { leg, arm, torso, head, hair, brim, pack, skirt, torch, cone, ring };
}

function makeBodyMaterial() {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.04, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 aRim;\nvarying vec3 vRim;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRim = aRim;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRim;")
      .replace(
        "#include <opaque_fragment>",
        `float rimF = pow(1.0 - saturate(abs(dot(normalize(normal), normalize(vViewPosition)))), 2.0);
         outgoingLight += vRim * (0.18 + rimF * 1.5);
         #include <opaque_fragment>`
      );
  };
  m.customProgramCacheKey = () => "praesidium-body-rim";
  return m;
}

interface Rig {
  n: number;
  meshes: THREE.InstancedMesh[];
  body: THREE.InstancedMesh[]; // those with aRim
  torso: THREE.InstancedMesh;
  head: THREE.InstancedMesh;
  hair: THREE.InstancedMesh;
  brim: THREE.InstancedMesh;
  legL: THREE.InstancedMesh;
  legR: THREE.InstancedMesh;
  armL: THREE.InstancedMesh;
  armR: THREE.InstancedMesh;
  pack: THREE.InstancedMesh;
  skirt: THREE.InstancedMesh;
  torch: THREE.InstancedMesh;
  cone: THREE.InstancedMesh;
  ring: THREE.InstancedMesh;
  xray: THREE.InstancedMesh[];
  dispose: () => void;
}

const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

function buildRig(n: number): Rig {
  const g = buildGeometries();
  const mat = makeBodyMaterial();
  const torchMat = new THREE.MeshBasicMaterial({ color: "#fff7c2", toneMapped: false });
  const coneMat = new THREE.MeshBasicMaterial({
    color: "#fde68a",
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const ringMat = new THREE.MeshBasicMaterial({
    color: "#ffffff",
    depthTest: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mk = (geo: THREE.BufferGeometry, m: THREE.Material, rim: boolean) => {
    const im = new THREE.InstancedMesh(geo, m, n);
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) im.setMatrixAt(i, HIDE);
    if (rim) geo.setAttribute("aRim", new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    // instance colours default to white
    for (let i = 0; i < n; i++) im.setColorAt(i, new THREE.Color("#ffffff"));
    return im;
  };
  const torso = mk(g.torso, mat, true);
  const head = mk(g.head, mat, true);
  const hair = mk(g.hair, mat, true);
  const brim = mk(g.brim, mat, false);
  const legL = mk(g.leg, mat, true);
  const legR = mk(g.leg.clone(), mat, true);
  const armL = mk(g.arm, mat, true);
  const armR = mk(g.arm.clone(), mat, true);
  const pack = mk(g.pack, mat, true);
  const skirt = mk(g.skirt, mat, true);
  const torch = mk(g.torch, torchMat, false);
  const cone = mk(g.cone, coneMat, false);
  const ring = mk(g.ring, ringMat, false);
  ring.renderOrder = 10;
  // brim has no aRim attr but uses the rim material → give it one
  brim.geometry.setAttribute("aRim", new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
  const meshes = [torso, head, hair, brim, legL, legR, armL, armR, pack, skirt, torch, cone, ring];
  const body = [torso, head, hair, brim, legL, legR, armL, armR, pack, skirt];
  // x-ray silhouettes: same geometry + SHARED instance matrices, drawn only where occluded
  const xmat = new THREE.MeshBasicMaterial({
    color: "#ffffff", transparent: true, opacity: 0.55, depthWrite: false, depthFunc: THREE.GreaterDepth, toneMapped: false,
  });
  const xray = [torso, head, legL, legR, armL, armR].map((src) => {
    const xm = new THREE.InstancedMesh(src.geometry, xmat, n);
    xm.instanceMatrix = src.instanceMatrix;
    xm.frustumCulled = false;
    xm.renderOrder = 11;
    for (let i = 0; i < n; i++) xm.setColorAt(i, new THREE.Color("#ffffff"));
    return xm;
  });
  return {
    xray, n, meshes, body, torso, head, hair, brim, legL, legR, armL, armR, pack, skirt, torch, cone, ring,
    dispose: () => {
      meshes.forEach((m) => {
        m.geometry.dispose();
        m.dispose();
      });
      xmat.dispose();
      mat.dispose();
      torchMat.dispose();
      coneMat.dispose();
      ringMat.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Pose                                                                */
/* ------------------------------------------------------------------ */

type Mode = "idle" | "walk" | "run" | "sneak" | "crouch" | "punch" | "panic" | "sit" | "surrender";

interface Pose {
  hipY: number;
  legScale: number;
  lean: number;
  twist: number;
  legL: number;
  legR: number;
  armL: number;
  armR: number;
  rollL: number;
  rollR: number;
  headPitch: number;
  headYaw: number;
  bob: number;
  shakeX: number;
  shakeZ: number;
}

const P: Pose = {
  hipY: 0.9, legScale: 1, lean: 0, twist: 0, legL: 0, legR: 0, armL: 0, armR: 0,
  rollL: 0.07, rollR: -0.07, headPitch: 0, headYaw: 0, bob: 0, shakeX: 0, shakeZ: 0,
};

function resetPose() {
  P.hipY = 0.9; P.legScale = 1; P.lean = 0; P.twist = 0; P.legL = 0; P.legR = 0;
  P.armL = 0; P.armR = 0; P.rollL = 0.07; P.rollR = -0.07; P.headPitch = 0; P.headYaw = 0;
  P.bob = 0; P.shakeX = 0; P.shakeZ = 0;
}

/** gait = walking clock (sim-playing time), wall = always-on clock, ph = per-actor phase offset. */
function computePose(mode: Mode, gait: number, wall: number, ph: number, slow: number) {
  resetPose();
  const idleSway = Math.sin(wall * 1.7 + ph) * 0.03;
  switch (mode) {
    case "idle": {
      P.armL = idleSway;
      P.armR = -idleSway;
      P.lean = 0.02 + idleSway * 0.5;
      P.hipY = 0.9 + Math.sin(wall * 1.7 + ph) * 0.004;
      P.headYaw = Math.sin(wall * 0.6 + ph * 3) * 0.35;
      break;
    }
    case "walk": {
      const s = Math.sin(gait * 10 * slow + ph);
      const amp = 0.55;
      P.legL = s * amp; P.legR = -s * amp;
      P.armL = -s * amp * 0.75; P.armR = s * amp * 0.75;
      P.lean = 0.07; P.twist = s * 0.1;
      P.hipY = 0.885 + Math.abs(Math.cos(gait * 10 * slow + ph)) * 0.035;
      break;
    }
    case "run": {
      const w = gait * 15 + ph;
      const s = Math.sin(w);
      P.legL = s * 1.0; P.legR = -s * 1.0;
      P.armL = -s * 0.95 + 0.5; P.armR = s * 0.95 + 0.5;
      P.lean = 0.3; P.twist = s * 0.16;
      P.hipY = 0.84 + Math.abs(Math.cos(w)) * 0.09;
      P.headPitch = -0.18;
      break;
    }
    case "sneak": {
      const w = gait * 6.5 + ph;
      const s = Math.sin(w);
      P.hipY = 0.68; P.legScale = 0.78;
      P.legL = s * 0.4 + 0.3; P.legR = -s * 0.4 + 0.3;
      P.armL = 0.55 - s * 0.2; P.armR = 0.55 + s * 0.2;
      P.lean = 0.5; P.headPitch = -0.38; P.twist = s * 0.08;
      P.headYaw = Math.sin(wall * 1.3 + ph) * 0.5;
      break;
    }
    case "crouch": {
      P.hipY = 0.5; P.legScale = 0.56;
      P.legL = 0.75; P.legR = 0.55;
      P.armL = 0.4 + Math.sin(wall * 2 + ph) * 0.05; P.armR = 0.3;
      P.lean = 0.6; P.headPitch = -0.45;
      P.headYaw = Math.sin(wall * 0.8 + ph) * 0.85;
      P.hipY += Math.sin(wall * 2.4 + ph) * 0.01;
      break;
    }
    case "punch": {
      const w = wall * 8 + ph;
      const p = (Math.sin(w) + 1) / 2;
      P.hipY = 0.8; P.legScale = 0.9;
      P.legL = 0.35; P.legR = -0.35;
      P.lean = 0.22; P.twist = (p - 0.5) * 0.9; P.headPitch = -0.1;
      P.armR = 0.6 + p * 1.0; P.rollR = -0.2;
      P.armL = 1.4 - p * 0.6; P.rollL = 0.3;
      P.shakeZ = p * 0.06;
      break;
    }
    case "panic": {
      const w = wall * 14 + ph;
      P.hipY = 0.78; P.legScale = 0.88;
      P.legL = Math.sin(w) * 0.3; P.legR = -Math.sin(w) * 0.3;
      P.armL = 2.55 + Math.sin(w * 1.1) * 0.35; P.armR = 2.55 + Math.cos(w * 0.9) * 0.35;
      P.rollL = 0.45; P.rollR = -0.45;
      P.lean = -0.28; P.headPitch = -0.2; P.headYaw = Math.sin(w * 0.8) * 0.5;
      P.shakeX = Math.sin(w * 1.7) * 0.03;
      break;
    }
    case "sit": {
      P.hipY = 0.46; P.legScale = 0.9;
      P.legL = 1.5; P.legR = 1.5;
      P.armL = 0.9; P.armR = 0.9;
      const nod = Math.sin(wall * 0.9 + ph) * 0.08;
      P.lean = -0.12 + nod * 0.3;
      P.headPitch = 0.55 + nod;
      P.hipY += Math.sin(wall * 1.1 + ph) * 0.008;
      break;
    }
    case "surrender": {
      P.hipY = 0.58; P.legScale = 0.68;
      P.legL = 0.95; P.legR = 0.8;
      P.armL = 2.9; P.armR = 2.9;
      P.rollL = 0.2; P.rollR = -0.2;
      P.headPitch = 0.28; P.lean = 0.05;
      P.shakeX = Math.sin(wall * 18 + ph) * 0.006;
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const _e = new THREE.Euler(0, 0, 0, "ZXY");
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const mRoot = new THREE.Matrix4();
const mTorso = new THREE.Matrix4();
const mHead = new THREE.Matrix4();
const mArm = new THREE.Matrix4();
const mA = new THREE.Matrix4();
const mB = new THREE.Matrix4();
const _c = new THREE.Color();

function local(out: THREE.Matrix4, px: number, py: number, pz: number, rx: number, ry: number, rz: number, sx = 1, sy = 1, sz = 1) {
  _p.set(px, py, pz);
  _e.set(rx, ry, rz, "ZXY");
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

/* ------------------------------------------------------------------ */
/* Layer                                                               */
/* ------------------------------------------------------------------ */

function angleLerp(a: number, b: number, t: number) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function makeZzzTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(10,16,30,0.0)";
  g.fillRect(0, 0, 128, 128);
  g.font = "bold 54px system-ui, sans-serif";
  g.fillStyle = "#bfdbfe";
  g.shadowColor = "#60a5fa";
  g.shadowBlur = 14;
  g.fillText("Z", 8, 104);
  g.font = "bold 44px system-ui, sans-serif";
  g.fillText("z", 56, 70);
  g.font = "bold 32px system-ui, sans-serif";
  g.fillText("z", 92, 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function CharactersLayer() {
  const activeRun = useSceneRun();
  const clock = useSceneClock();
  const play = useScenePlay();

  const counts = useMemo(() => {
    if (!activeRun) return { nA: 0, nG: 0, nP: 0 };
    const fr = activeRun.frames;
    const f0 = fr[0] as F | undefined;
    let nP = 0;
    for (const f of [fr[0], fr[Math.floor(fr.length / 2)], fr[fr.length - 1]] as (F | undefined)[]) {
      if (f?.perpPos && f.perpPos.length / 2 > nP) nP = f.perpPos.length / 2;
    }
    return { nA: (f0?.agentPos.length ?? 0) / 2, nG: (f0?.guardPos.length ?? 0) / 2, nP };
  }, [activeRun]);

  const { nA, nG, nP } = counts;
  const N = nA + nG + nP;

  const rig = useMemo(() => (N > 0 ? buildRig(N) : null), [N]);
  useEffect(() => () => rig?.dispose(), [rig]);

  const zzzTex = useMemo(() => (typeof document !== "undefined" ? makeZzzTexture() : null), []);
  useEffect(() => () => zzzTex?.dispose(), [zzzTex]);
  const zzzSprites = useMemo(() => {
    if (!zzzTex) return [];
    return Array.from({ length: nG }, () => {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: zzzTex, transparent: true, depthWrite: false, toneMapped: false })
      );
      s.visible = false;
      s.scale.set(3.4, 3.4, 1);
      return s;
    });
  }, [zzzTex, nG]);
  useEffect(() => () => zzzSprites.forEach((s) => s.material.dispose()), [zzzSprites]);

  // static per-actor look (kit + colours)
  const kits = useMemo(() => new Uint8Array(N), [N]);
  const scales = useMemo(() => new Float32Array(N).fill(1), [N]);
  const yaws = useMemo(() => new Float32Array(N), [N]);
  const lastPerpState = useMemo(() => new Uint8Array(N), [N]);
  const fem = useMemo(() => new Uint8Array(N), [N]);
  const elder = useMemo(() => new Uint8Array(N), [N]);

  useEffect(() => {
    if (!rig || !activeRun) return;
    const f0 = activeRun.frames[0] as F;
    const set = (mesh: THREE.InstancedMesh, i: number, hex: string) => {
      _c.set(hex);
      mesh.setColorAt(i, _c);
    };
    for (let i = 0; i < N; i++) {
      let kit: number = KIT.RESIDENT;
      let top: string, bottom: string, skin: string, hair: string, pack: string = "#000", brim: string = "#000";
      skin = pick(SKIN, i, 1);
      hair = pick(HAIR, i, 2);
      let sc = 0.92 + hash(i * 3 + 5) * 0.18;
      if (i < nA) {
        const commuter = f0.agentCat?.[i] === 1;
        if (!commuter) {
          kit = KIT.RESIDENT;
          top = pick(RES_TOPS, i, 3);
          bottom = pick(RES_BOTTOMS, i, 4);
          if (hash(i * 13 + 1) < 0.45) {
            fem[i] = 1; // kurta / saree silhouette
            bottom = pick(["#be185d", "#7c3aed", "#0f766e", "#b45309", "#1d4ed8", "#9f1239"], i, 12);
          }
          if (hash(i * 17 + 3) < 0.16) {
            elder[i] = 1;
            hair = "#d4d7dc";
            sc *= 0.93;
          }
        } else if (i % 4 === 0) {
          kit = KIT.RIDER;
          top = i % 8 === 0 ? "#fb923c" : "#14b8a6";
          bottom = "#1e293b";
          hair = top; // helmet
          pack = i % 8 === 0 ? "#f97316" : "#0d9488";
        } else {
          kit = KIT.COMMUTER;
          top = pick(COM_TOPS, i, 3);
          bottom = "#1f2937";
          pack = pick(["#475569", "#7c3aed", "#0369a1", "#9a3412"], i, 6);
        }
      } else if (i < nA + nG) {
        kit = KIT.GUARD;
        top = "#233a63"; bottom = "#18233a"; hair = "#1b2a4a"; brim = "#0f1a30";
        pack = "#d9f24a"; // hi-vis vest
        sc = 1.08;
        skin = pick(SKIN, i, 9);
      } else {
        kit = KIT.PERP;
        const j = i - nA - nG;
        top = pick(PERP_HOOD, j, 3);
        bottom = "#0d0f13";
        hair = top;
        skin = pick(SKIN, j, 8);
        sc = 1.0 + hash(j + 11) * 0.06;
      }
      kits[i] = kit;
      scales[i] = sc;
      set(rig.torso, i, top);
      set(rig.armL, i, top);
      set(rig.armR, i, top);
      set(rig.legL, i, bottom);
      set(rig.legR, i, bottom);
      set(rig.head, i, skin);
      set(rig.hair, i, hair);
      set(rig.brim, i, brim);
      set(rig.pack, i, pack);
      const role = kit === KIT.GUARD ? "#60a5fa" : kit === KIT.PERP ? "#ff3355" : kit === KIT.RIDER ? "#fb923c" : kit === KIT.COMMUTER ? "#38bdf8" : "#ffd166";
      for (const xm of rig.xray) xm.setColorAt(i, _c.set(role));
    }
    rig.xray.forEach((m) => { if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    [rig.torso, rig.armL, rig.armR, rig.legL, rig.legR, rig.head, rig.hair, rig.brim, rig.pack].forEach((m) => {
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });
  }, [rig, activeRun, N, nA, nG, kits, scales, fem, elder]);

  const wallRef = useRef(0);
  const gaitRef = useRef(0);

  useFrame(({ camera }, delta) => {
    if (!rig || !activeRun) return;
    wallRef.current += delta;
    if (play.isPlaying()) gaitRef.current += delta * Math.min(play.speed(), 2.5);
    const wall = wallRef.current;
    const gait = gaitRef.current;
    const t = clock.t;
    const frames = activeRun.frames;
    const last = frames.length - 1;
    const i0 = Math.max(0, Math.min(Math.floor(t), last));
    const i1 = Math.min(i0 + 1, last);
    const frac = Math.min(1, Math.max(0, t - i0));
    const f0 = frames[i0] as F;
    const f1 = frames[i1] as F;
    const fp = frames[Math.max(0, i0 - 1)] as F;
    const moving = i1 > i0;
    const yawK = 1 - Math.exp(-delta * 10);
    // readability when zoomed out: grow characters as the ortho camera zooms out
    const zoom = (camera as THREE.OrthographicCamera).zoom || 2.2;
    const boost = Math.min(2.4, Math.max(1, Math.pow(2.2 / zoom, 0.65) * 1.45));

    // attacking perps (for victim/attacker mutual facing)
    const attackers: number[] = [];
    if (f0.perpState && f0.perpPos) {
      for (let j = 0; j < nP; j++) if (f0.perpState[j] === PERP_STATE.ATTACKING) attackers.push(j);
    }

    const rimArr = rig.body.map((m) => (m.geometry.getAttribute("aRim") as THREE.InstancedBufferAttribute).array as Float32Array);
    const pulse = 0.5 + 0.5 * Math.sin(wall * 7);

    // ring bookkeeping
    const setRing = (slot: number, x: number, z: number, radius: number, r: number, g: number, b: number, a: number) => {
      if (a <= 0.01) {
        rig.ring.setMatrixAt(slot, HIDE);
        return;
      }
      local(mA, x, 0.09, z, 0, 0, 0, radius, 1, radius);
      rig.ring.setMatrixAt(slot, mA);
      _c.setRGB(r * a, g * a, b * a);
      rig.ring.setColorAt(slot, _c);
    };

    const hideSlot = (slot: number) => {
      for (const m of rig.meshes) m.setMatrixAt(slot, HIDE);
      for (const a of rimArr) a[slot * 3] = a[slot * 3 + 1] = a[slot * 3 + 2] = 0;
    };

    const draw = (
      slot: number, x: number, z: number, yaw: number, kit: number,
      rim: [number, number, number], torchOn: boolean, ph: number
    ) => {
      const sc = scales[slot] * CHAR_SCALE * boost;
      local(mRoot, x + P.shakeX * sc, 0, z + P.shakeZ * sc, 0, yaw, 0, sc, sc, sc);
      const hipY = P.hipY + P.bob;
      // torso
      local(mA, 0, hipY, 0, P.lean, P.twist, 0);
      mTorso.multiplyMatrices(mRoot, mA);
      rig.torso.setMatrixAt(slot, mTorso);
      // legs
      local(mA, -0.105, hipY, 0, -P.legL, 0, 0, 1, P.legScale, 1);
      rig.legL.setMatrixAt(slot, mB.multiplyMatrices(mRoot, mA));
      local(mA, 0.105, hipY, 0, -P.legR, 0, 0, 1, P.legScale, 1);
      rig.legR.setMatrixAt(slot, mB.multiplyMatrices(mRoot, mA));
      // arms
      local(mA, -0.27, 0.62, 0, -P.armL, 0, -P.rollL);
      rig.armL.setMatrixAt(slot, mB.multiplyMatrices(mTorso, mA));
      local(mA, 0.27, 0.62, 0, -P.armR, 0, -P.rollR);
      mArm.multiplyMatrices(mTorso, mA);
      rig.armR.setMatrixAt(slot, mArm);
      // head
      local(mA, 0, 0.71, 0, P.headPitch + P.lean * -0.6, P.headYaw, 0);
      mHead.multiplyMatrices(mTorso, mA);
      mHead.multiply(local(mA, 0, 0.17, 0, 0, 0, 0));
      rig.head.setMatrixAt(slot, mHead);
      // hair / cap / hood / helmet
      if (kit === KIT.PERP) {
        rig.hair.setMatrixAt(slot, mB.multiplyMatrices(mHead, local(mA, 0, -0.02, -0.035, 0.1, 0, 0, 1.2, 1.35, 1.25)));
      } else if (kit === KIT.RIDER) {
        rig.hair.setMatrixAt(slot, mB.multiplyMatrices(mHead, local(mA, 0, 0.0, -0.01, 0, 0, 0, 1.1, 1.15, 1.1)));
      } else {
        rig.hair.setMatrixAt(slot, mB.multiplyMatrices(mHead, local(mA, 0, 0.0, -0.01, 0, 0, 0, 1, 1, 1)));
      }
      if (fem[slot] && kit === KIT.RESIDENT) {
        local(mA, 0, hipY + 0.04, 0, P.lean * 0.4, P.twist * 0.5, 0, 1, Math.max(0.55, P.legScale), 1);
        rig.skirt.setMatrixAt(slot, mB.multiplyMatrices(mRoot, mA));
        rig.hair.setMatrixAt(slot, mB.multiplyMatrices(mHead, local(mA, 0, -0.04, -0.03, 0.15, 0, 0, 1.08, 1.45, 1.12)));
      } else rig.skirt.setMatrixAt(slot, HIDE);
      // brim: guards + riders
      if (kit === KIT.GUARD || kit === KIT.RIDER) {
        rig.brim.setMatrixAt(slot, mB.multiplyMatrices(mHead, local(mA, 0, 0.075, 0.1, 0.18, 0, 0)));
      } else rig.brim.setMatrixAt(slot, HIDE);
      // pack: backpack (commuter), delivery box (rider), vest (guard)
      if (kit === KIT.COMMUTER) {
        rig.pack.setMatrixAt(slot, mB.multiplyMatrices(mTorso, local(mA, 0, 0.38, -0.17, 0, 0, 0)));
      } else if (kit === KIT.RIDER) {
        rig.pack.setMatrixAt(slot, mB.multiplyMatrices(mTorso, local(mA, 0, 0.42, -0.24, 0, 0, 0, 1.45, 1.25, 2.2)));
      } else if (kit === KIT.GUARD) {
        rig.pack.setMatrixAt(slot, mB.multiplyMatrices(mTorso, local(mA, 0, 0.36, 0, 0, 0, 0, 1.42, 0.8, 1.95)));
      } else rig.pack.setMatrixAt(slot, HIDE);
      // torch + cone
      if (kit === KIT.GUARD) {
        rig.torch.setMatrixAt(slot, mB.multiplyMatrices(mArm, local(mA, 0, -0.52, 0.05, 0, 0, 0)));
        if (torchOn) {
          // cone from torch toward facing, tilted down
          rig.cone.setMatrixAt(slot, mB.multiplyMatrices(mRoot, local(mA, 0.12, hipY + 0.52, 0.2, 0.2, 0, 0, 1 / sc * 1.7, 1 / sc * 1.7, 1 / sc * 1.7)));
        } else rig.cone.setMatrixAt(slot, HIDE);
      } else {
        rig.torch.setMatrixAt(slot, HIDE);
        rig.cone.setMatrixAt(slot, HIDE);
      }
      for (const a of rimArr) {
        a[slot * 3] = rim[0]; a[slot * 3 + 1] = rim[1]; a[slot * 3 + 2] = rim[2];
      }
      void ph;
    };

    /* ---------------- pedestrians ---------------- */
    for (let i = 0; i < nA; i++) {
      const state = f0.agentState[i];
      const drama = f0.agentDrama?.[i] ?? VICTIM_STATE.NORMAL;
      const started = f0.agentStarted?.[i];
      const hidden =
        state === AGENT_STATE.CANCELLED ||
        (state === AGENT_STATE.WAITING && !started) ||
        (state === AGENT_STATE.ARRIVED && drama === VICTIM_STATE.NORMAL);
      rig.ring.setMatrixAt(i, HIDE);
      if (hidden) { hideSlot(i); continue; }
      const x = f0.agentPos[i * 2] + (f1.agentPos[i * 2] - f0.agentPos[i * 2]) * frac;
      const z = f0.agentPos[i * 2 + 1] + (f1.agentPos[i * 2 + 1] - f0.agentPos[i * 2 + 1]) * frac;
      const a = moving ? f0 : fp;
      const b = moving ? f1 : f0;
      const dx = b.agentPos[i * 2] - a.agentPos[i * 2];
      const dz = b.agentPos[i * 2 + 1] - a.agentPos[i * 2 + 1];
      const spd = Math.hypot(dx, dz);
      const going = state === AGENT_STATE.WALKING && spd > 0.15 && spd < 9;
      if (going) yaws[i] = angleLerp(yaws[i], Math.atan2(dx, dz), yawK);
      let mode: Mode = going ? (spd > 2.6 ? "run" : "walk") : "idle";
      let rim: [number, number, number] = [0, 0, 0];
      if (drama === VICTIM_STATE.VICTIM) {
        mode = "panic";
        rim = [1.0 * (0.6 + pulse * 0.6), 0.1, 0.12];
        if (attackers.length) {
          let best = 1e9, bx = 0, bz = 0;
          for (const j of attackers) {
            const px = f0.perpPos![j * 2], pz = f0.perpPos![j * 2 + 1];
            const d = (px - x) ** 2 + (pz - z) ** 2;
            if (d < best) { best = d; bx = px; bz = pz; }
          }
          yaws[i] = angleLerp(yaws[i], Math.atan2(bx - x, bz - z), yawK);
        }
        const rp = ((wall * 1.3) % 1);
        setRing(i, x, z, CHAR_SCALE * (1.3 + rp * 2.2), 1, 0.15, 0.2, (1 - rp) * 0.9);
      } else if (drama === VICTIM_STATE.FLEEING) {
        mode = "run";
        P.armL = 2.4;
        rim = [0.9, 0.3, 0.1];
      } else if (drama === VICTIM_STATE.TARGETED) {
        rim = [0.5, 0.32, 0.02];
      }
      computePose(mode, gait, wall, i * 1.7, elder[i] ? 0.7 : 1);
      if (elder[i]) { P.lean += 0.22; P.headPitch += 0.15; }
      if (drama === VICTIM_STATE.FLEEING) { P.armL = 2.4; P.armR = 2.2; P.rollL = 0.3; P.rollR = -0.3; }
      draw(i, x, z, yaws[i], kits[i], rim, false, i);
      if (kits[i] === KIT.RIDER && drama === VICTIM_STATE.NORMAL) setRing(i, x, z, CHAR_SCALE * boost * 0.85, 1, 0.55, 0.1, 0.45);
      else if (kits[i] === KIT.COMMUTER && drama === VICTIM_STATE.NORMAL) setRing(i, x, z, CHAR_SCALE * boost * 0.7, 0.2, 0.7, 0.9, 0.3);
    }

    /* ---------------- guards ---------------- */
    for (let g = 0; g < nG; g++) {
      const slot = nA + g;
      const sprite = zzzSprites[g];
      if (sprite) sprite.visible = false;
      rig.ring.setMatrixAt(slot, HIDE);
      const state = f0.guardState[g];
      if (state === GUARD_STATE.UNAVAILABLE) { hideSlot(slot); continue; }
      const x = f0.guardPos[g * 2] + (f1.guardPos[g * 2] - f0.guardPos[g * 2]) * frac;
      const z = f0.guardPos[g * 2 + 1] + (f1.guardPos[g * 2 + 1] - f0.guardPos[g * 2 + 1]) * frac;
      const a = moving ? f0 : fp;
      const b = moving ? f1 : f0;
      const dx = b.guardPos[g * 2] - a.guardPos[g * 2];
      const dz = b.guardPos[g * 2 + 1] - a.guardPos[g * 2 + 1];
      const spd = Math.hypot(dx, dz);
      const going = spd > 0.15 && spd < 12;
      if (going) yaws[slot] = angleLerp(yaws[slot], Math.atan2(dx, dz), yawK);
      const cond = f0.guardCondition?.[g] ?? GUARD_CONDITION.ALERT;
      let mode: Mode = going ? (state === GUARD_STATE.RESPONDING || spd > 2.6 ? "run" : "walk") : "idle";
      let torchOn = true;
      if (cond === GUARD_CONDITION.ASLEEP) { mode = "sit"; torchOn = false; }
      computePose(mode, gait, wall, slot * 1.7, state === GUARD_STATE.PATROLLING ? 0.85 : 1);
      if (cond === GUARD_CONDITION.DROWSY) { P.headPitch += 0.4; P.lean += 0.1; }
      if (mode === "idle" && cond !== GUARD_CONDITION.ASLEEP) {
        P.headYaw = Math.sin(wall * 0.9 + g) * 0.7; // scanning with torch
        P.armR = 0.7; // torch arm held forward
      } else if (mode === "walk") P.armR = 0.55;
      draw(slot, x, z, yaws[slot], KIT.GUARD, [0, 0, 0], torchOn, g);
      setRing(slot, x, z, CHAR_SCALE * boost * 0.95, 0.25, 0.5, 1, 0.5);
      if (state === GUARD_STATE.ON_SCENE || state === GUARD_STATE.RESPONDING) {
        const rp = (wall * 0.8) % 1;
        setRing(slot, x, z, CHAR_SCALE * (1.4 + rp * 0.4), 0.3, 0.55, 1, state === GUARD_STATE.ON_SCENE ? 0.5 : 0.25);
      }
      if (cond === GUARD_CONDITION.ASLEEP && sprite) {
        sprite.visible = true;
        const k = (wall * 0.5 + g * 0.37) % 1;
        sprite.position.set(x + 0.8, (1.9 + k * 1.4) * CHAR_SCALE * 0.9, z);
        sprite.material.opacity = Math.sin(k * Math.PI);
        const s = 2.6 + k * 1.2;
        sprite.scale.set(s, s, 1);
      }
    }

    /* ---------------- perpetrators ---------------- */
    for (let j = 0; j < nP; j++) {
      const slot = nA + nG + j;
      rig.ring.setMatrixAt(slot, HIDE);
      const ps = f0.perpState?.[j] ?? PERP_STATE.INACTIVE;
      if (!f0.perpPos || ps === PERP_STATE.INACTIVE || ps === PERP_STATE.ESCAPED) { hideSlot(slot); continue; }
      const x = f0.perpPos[j * 2] + ((f1.perpPos?.[j * 2] ?? f0.perpPos[j * 2]) - f0.perpPos[j * 2]) * frac;
      const z = f0.perpPos[j * 2 + 1] + ((f1.perpPos?.[j * 2 + 1] ?? f0.perpPos[j * 2 + 1]) - f0.perpPos[j * 2 + 1]) * frac;
      const a = moving ? f0 : fp;
      const b = moving ? f1 : f0;
      const dx = (b.perpPos?.[j * 2] ?? 0) - (a.perpPos?.[j * 2] ?? 0);
      const dz = (b.perpPos?.[j * 2 + 1] ?? 0) - (a.perpPos?.[j * 2 + 1] ?? 0);
      const spd = Math.hypot(dx, dz);
      const going = spd > 0.1 && spd < 12;
      if (going) yaws[slot] = angleLerp(yaws[slot], Math.atan2(dx, dz), yawK);
      let mode: Mode = "idle";
      let rimK = 0.7;
      if (ps === PERP_STATE.LURKING) { mode = "crouch"; rimK = 0.6; }
      else if (ps === PERP_STATE.STALKING) { mode = going ? "sneak" : "crouch"; rimK = 0.75; }
      else if (ps === PERP_STATE.ATTACKING) {
        mode = "punch";
        rimK = 1.0 + pulse * 0.8;
        // face nearest victim
        let best = 1e9, bx = x, bz = z;
        for (let i = 0; i < nA; i++) {
          if ((f0.agentDrama?.[i] ?? 0) !== VICTIM_STATE.VICTIM) continue;
          const d = (f0.agentPos[i * 2] - x) ** 2 + (f0.agentPos[i * 2 + 1] - z) ** 2;
          if (d < best) { best = d; bx = f0.agentPos[i * 2]; bz = f0.agentPos[i * 2 + 1]; }
        }
        if (best < 1e8 && best > 0.01) yaws[slot] = angleLerp(yaws[slot], Math.atan2(bx - x, bz - z), yawK);
        const rp = (wall * 1.6) % 1;
        setRing(slot, x, z, CHAR_SCALE * (1.0 + rp * 3.2), 1, 0.1, 0.12, (1 - rp) * 1.0);
      } else if (ps === PERP_STATE.FLEEING) { mode = "run"; rimK = 0.9; }
      else if (ps === PERP_STATE.CAUGHT) { mode = "surrender"; rimK = 0.5; }
      computePose(mode, gait, wall, slot * 1.9, 1);
      draw(slot, x, z, yaws[slot], KIT.PERP, [0.95 * rimK, 0.08 * rimK, 0.14 * rimK], false, j);
      lastPerpState[slot] = ps;
    }

    for (const m of rig.meshes) m.instanceMatrix.needsUpdate = true;
    rig.ring.instanceColor!.needsUpdate = true;
    for (const m of rig.body) (m.geometry.getAttribute("aRim") as THREE.InstancedBufferAttribute).needsUpdate = true;
  });

  if (!activeRun || !rig) return null;

  return (
    <group>
      {rig.meshes.map((m, i) => (
        <primitive key={`${N}-${i}`} object={m} />
      ))}
      {rig.xray.map((m, i) => (
        <primitive key={`${N}-x${i}`} object={m} />
      ))}
      {zzzSprites.map((s, i) => (
        <primitive key={`zzz-${i}`} object={s} />
      ))}
    </group>
  );
}
