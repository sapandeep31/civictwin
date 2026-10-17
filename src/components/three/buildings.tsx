"use client";

/**
 * Stylized low-poly buildings for the Praesidium 3D scene.
 *
 * Everything is procedural: every building is generated into two merged
 * geometries (one lit "body" mesh with vertex colors, one unlit "glow" mesh
 * for windows / shopfronts / signs). That keeps the whole layer at 2 draw
 * calls + 1 invisible instanced pick mesh, even for 300 imported buildings.
 * Window lighting is seeded by building id, so the look is deterministic.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useEditor, liveMove } from "@/lib/store/editor";
import { armPendingDrag } from "./layers";
import type { Building, Facility } from "@/lib/world/types";

type Theme = "night" | "sunset" | "daylight";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function hashNum(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TONE: Record<Theme, [number, number, number]> = {
  night: [0.42, 0.5, 0.78],
  sunset: [1.0, 0.86, 0.78],
  daylight: [1, 1, 1],
};

/* ------------------------------------------------------------------ */
/* merged geometry builder                                             */
/* ------------------------------------------------------------------ */

type V3 = [number, number, number];

class GeoBuilder {
  pos: number[] = [];
  col: number[] = [];
  base = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private full = new THREE.Matrix4();
  private va = new THREE.Vector3();
  private vb = new THREE.Vector3();
  private vc = new THREE.Vector3();
  private n = new THREE.Vector3();

  setBase(m: THREE.Matrix4) {
    this.base.copy(m);
  }

  /** Set the active local transform (translation + yaw) on top of base. */
  private place(cx: number, cy: number, cz: number, ry: number) {
    this.local.makeRotationY(ry).setPosition(cx, cy, cz);
    this.full.multiplyMatrices(this.base, this.local);
  }

  private tri(a: V3, b: V3, c: V3, color: THREE.Color) {
    this.va.set(a[0], a[1], a[2]).applyMatrix4(this.full);
    this.vb.set(b[0], b[1], b[2]).applyMatrix4(this.full);
    this.vc.set(c[0], c[1], c[2]).applyMatrix4(this.full);
    this.n.subVectors(this.vb, this.va).cross(this.vc.clone().sub(this.va));
    if (this.n.lengthSq() < 1e-10) return;
    this.pos.push(this.va.x, this.va.y, this.va.z, this.vb.x, this.vb.y, this.vb.z, this.vc.x, this.vc.y, this.vc.z);
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
  }

  private quad(a: V3, b: V3, c: V3, d: V3, color: THREE.Color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  /** Axis-aligned (in local frame) box. y0 = bottom. */
  box(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color, ry = 0, bottom = false) {
    this.frustum(cx, y0, cz, sx, sz, sx, sz, sy, color, ry, bottom);
  }

  /** Box tapering from (bx,bz) at bottom to (tx,tz) at top, centered. */
  frustum(cx: number, y0: number, cz: number, bx: number, bz: number, tx: number, tz: number, h: number, color: THREE.Color, ry = 0, bottom = false) {
    this.place(cx, y0, cz, ry);
    const B: V3[] = [
      [-bx / 2, 0, bz / 2],
      [bx / 2, 0, bz / 2],
      [bx / 2, 0, -bz / 2],
      [-bx / 2, 0, -bz / 2],
    ];
    const T: V3[] = [
      [-tx / 2, h, tz / 2],
      [tx / 2, h, tz / 2],
      [tx / 2, h, -tz / 2],
      [-tx / 2, h, -tz / 2],
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(B[i], B[j], T[j], T[i], color);
    }
    this.quad(T[0], T[1], T[2], T[3], color);
    if (bottom) this.quad(B[3], B[2], B[1], B[0], color);
  }

  /** Gable roof, ridge along local x. */
  prism(cx: number, y0: number, cz: number, sx: number, sz: number, rise: number, color: THREE.Color, ry = 0, color2?: THREE.Color) {
    this.place(cx, y0, cz, ry);
    const B: V3[] = [
      [-sx / 2, 0, sz / 2],
      [sx / 2, 0, sz / 2],
      [sx / 2, 0, -sz / 2],
      [-sx / 2, 0, -sz / 2],
    ];
    const R0: V3 = [-sx / 2, rise, 0];
    const R1: V3 = [sx / 2, rise, 0];
    this.quad(B[0], B[1], R1, R0, color);
    this.quad(B[2], B[3], R0, R1, color);
    const c2 = color2 ?? color;
    this.tri(B[1], B[2], R1, c2);
    this.tri(B[3], B[0], R0, c2);
  }

  /** Surface of revolution around local Y. profile = [radius, y][] bottom to top. */
  lathe(cx: number, y0: number, cz: number, profile: [number, number][], seg: number, color: THREE.Color) {
    this.place(cx, y0, cz, 0);
    for (let k = 0; k + 1 < profile.length; k++) {
      const [r0, h0] = profile[k];
      const [r1, h1] = profile[k + 1];
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2;
        const a1 = ((s + 1) / seg) * Math.PI * 2;
        this.quad(
          [r0 * Math.cos(a0), h0, r0 * Math.sin(a0)],
          [r0 * Math.cos(a1), h0, r0 * Math.sin(a1)],
          [r1 * Math.cos(a1), h1, r1 * Math.sin(a1)],
          [r1 * Math.cos(a0), h1, r1 * Math.sin(a0)],
          color
        );
      }
    }
    // top cap
    const last = profile[profile.length - 1];
    if (last[0] > 0.01) {
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2;
        const a1 = ((s + 1) / seg) * Math.PI * 2;
        this.tri([0, last[1], 0], [last[0] * Math.cos(a1), last[1], last[0] * Math.sin(a1)], [last[0] * Math.cos(a0), last[1], last[0] * Math.sin(a0)], color);
      }
    }
  }

  /** Free quad in the local (building) frame. */
  freeQuad(a: V3, b: V3, c: V3, d: V3, color: THREE.Color) {
    this.place(0, 0, 0, 0);
    this.quad(a, b, c, d, color);
  }

  freeTri(a: V3, b: V3, c: V3, color: THREE.Color) {
    this.place(0, 0, 0, 0);
    this.tri(a, b, c, color);
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals(); // non-indexed => flat shading
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* classification                                                      */
/* ------------------------------------------------------------------ */

export type BuildingKind =
  | "apartment"
  | "house"
  | "shop"
  | "mall"
  | "school"
  | "hospital"
  | "clinic"
  | "mandir"
  | "masjid"
  | "church"
  | "worship"
  | "community"
  | "mixed"
  | "office";

const KEYWORDS: [RegExp, BuildingKind][] = [
  [/hospital|medical college|nursing home/, "hospital"],
  [/clinic|dispensary|health cent|pharmacy|diagnostic/, "clinic"],
  [/school|vidyalaya|academy|college|institute|nursery|kindergarten|playschool/, "school"],
  [/mandir|temple|gurdwara|gurudwara/, "mandir"],
  [/masjid|mosque|dargah|idgah/, "masjid"],
  [/church|chapel|cathedral/, "church"],
  [/mall|plaza|supermarket|complex|hypermarket/, "mall"],
  [/market|bazaar|bazar|shop|store|showroom|bakery|restaurant|cafe|hotel|bank|petrol/, "shop"],
  [/community|clubhouse|club house|library|anganwadi/, "community"],
];

const FACILITY_KIND: Partial<Record<Facility["type"], BuildingKind>> = {
  school: "school",
  clinic: "clinic",
  place_of_worship: "worship",
  community_centre: "community",
  market: "shop",
};

const FACILITY_RADIUS = 25;

function classifyAll(buildings: Building[], facilities: Facility[]): Map<string, BuildingKind> {
  const out = new Map<string, BuildingKind>();
  // facility -> nearest eligible building (so one facility restyles one building)
  const fromFacility = new Map<string, BuildingKind>();
  for (const f of facilities) {
    const kind = FACILITY_KIND[f.type];
    if (!kind) continue;
    let best: Building | null = null;
    let bestD = FACILITY_RADIUS;
    for (const b of buildings) {
      if (b.category === "residential" && b.floors >= 4) continue;
      const d = Math.hypot(b.x - f.x, b.z - f.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best && !fromFacility.has(best.id)) fromFacility.set(best.id, kind);
  }

  for (const b of buildings) {
    const name = (b.name ?? "").toLowerCase();
    let kind: BuildingKind | null = null;
    const roadish = / · |\b(road|street|lane|avenue|marg|cross|main|nagar|layout)\b/.test(name);
    for (const [re, k] of roadish ? [] : KEYWORDS) {
      if (re.test(name)) {
        kind = k;
        break;
      }
    }
    if (!kind) kind = fromFacility.get(b.id) ?? null;
    if (kind === "worship") {
      // pick a distinct silhouette deterministically when the faith is unknown
      const r = hashNum(b.id) % 3;
      kind = r === 0 ? "mandir" : r === 1 ? "masjid" : "worship";
    }
    if (kind === "shop" && b.width * b.depth > 450) kind = "mall";
    if (!kind) {
      switch (b.category) {
        case "residential":
          kind = b.floors >= 4 ? "apartment" : "house";
          break;
        case "commercial":
          kind = b.width * b.depth > 450 || b.floors >= 4 ? (b.floors >= 4 ? "office" : "mall") : "shop";
          break;
        case "community":
          kind = "community";
          break;
        case "mixed":
          kind = "mixed";
          break;
        default:
          kind = b.floors >= 4 ? "apartment" : b.floors <= 2 && b.width * b.depth < 140 ? "house" : "office";
      }
    }
    out.set(b.id, kind);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* per-building generation                                             */
/* ------------------------------------------------------------------ */

interface Ctx {
  g: GeoBuilder; // lit body
  w: GeoBuilder; // unlit glow
  theme: Theme;
  rnd: () => void | number;
  W: number;
  D: number;
  H: number;
  floors: number;
  fh: number;
  c: (hex: string) => THREE.Color;
  r: () => number;
  roof: THREE.Color;
  litBias: number;
}

const WALLS: Record<Theme, string[]> = {
  night: ["#8fa3bd", "#9aa5c4", "#86a8b8", "#b0a4bd", "#8ab3a6", "#b5a58e"],
  sunset: ["#f0c3a4", "#e7b49a", "#d9b2a8", "#efcf9f", "#d7b9a2", "#e6a98f"],
  daylight: ["#f3c9a2", "#eaa99a", "#9cc8e4", "#f4d77f", "#aad4a0", "#d3b0e2"],
};
const ROOF_TOPS = ["#7f93aa", "#b08d6e", "#8b9c7f", "#a1798d", "#6f8f9a"];
const ROOFS = ["#c0583f", "#a8483a", "#9a5a3e", "#7b4a3a"];
const BANDS = ["#2563eb", "#0d9488", "#dc2626", "#7c3aed", "#ea580c"];
const SIGNS = ["#ff4d6d", "#ffb703", "#3ddc97", "#4cc9f0", "#ff7b00", "#c77dff"];

function glassColor(ctx: Ctx, kind: "win" | "shop"): THREE.Color {
  const { theme, r, c, litBias } = ctx;
  if (kind === "shop") {
    if (theme === "daylight") return c("#9fd3ec");
    if (theme === "sunset") return c("#ffcc88");
    return c(r() < 0.5 ? "#ffc36b" : "#ffe3a1");
  }
  const lit = r() < litBias;
  if (theme === "daylight") return c(r() < 0.5 ? "#7fb2d6" : "#93bfdc");
  if (lit) {
    const k = r();
    const col = k < 0.62 ? "#ffd27a" : k < 0.84 ? "#ffb85c" : k < 0.94 ? "#fff1c4" : "#bfe3ff";
    return c(col);
  }
  return theme === "night" ? c(r() < 0.5 ? "#223452" : "#1a2740") : c(r() < 0.5 ? "#7d5a66" : "#6b4c5c");
}

// Raw (not tone-mapped by theme) color for glow elements.
function glowRaw(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

function facadeFrame(side: number, W: number, D: number) {
  // side 0:+z 1:+x 2:-z 3:-x
  const nx = side === 1 ? 1 : side === 3 ? -1 : 0;
  const nz = side === 0 ? 1 : side === 2 ? -1 : 0;
  return { nx, nz, ux: nz, uz: -nx, L: side % 2 === 0 ? W : D, half: side % 2 === 0 ? D / 2 : W / 2 };
}

function windowQuad(ctx: Ctx, side: number, t: number, yc: number, ww: number, wh: number, color: THREE.Color, off = 0.05) {
  const { nx, nz, ux, uz, half } = facadeFrame(side, ctx.W, ctx.D);
  const cx = nx * (half + off) + ux * t;
  const cz = nz * (half + off) + uz * t;
  const a: V3 = [cx - ux * (ww / 2), yc - wh / 2, cz - uz * (ww / 2)];
  const b: V3 = [cx + ux * (ww / 2), yc - wh / 2, cz + uz * (ww / 2)];
  const cc: V3 = [cx + ux * (ww / 2), yc + wh / 2, cz + uz * (ww / 2)];
  const d: V3 = [cx - ux * (ww / 2), yc + wh / 2, cz - uz * (ww / 2)];
  ctx.w.freeQuad(a, b, cc, d, color);
}

function windowGrid(ctx: Ctx, fromFloor: number, toFloor: number, sides: number[], spacing = 3, frontDoorGap = false) {
  const { W, D, fh, r } = ctx;
  for (const s of sides) {
    const L = s % 2 === 0 ? W : D;
    if (L < 2.4) continue;
    const cols = Math.max(1, Math.round(L / spacing));
    const sp = L / cols;
    const ww = Math.min(1.5, sp * 0.52);
    const wh = Math.min(1.5, fh * 0.5);
    for (let f = fromFloor; f < toFloor; f++) {
      for (let i = 0; i < cols; i++) {
        if (frontDoorGap && f === 0 && s === 0 && cols % 2 === 1 && i === (cols - 1) / 2) continue;
        const t = -L / 2 + sp * (i + 0.5);
        windowQuad(ctx, s, t, f * fh + fh * 0.58, ww, wh, glassColor(ctx, "win"));
      }
    }
    void r;
  }
}

function parapet(ctx: Ctx, topY: number, color: THREE.Color, thick = 0.3, h = 0.7, grow = 0.08) {
  const { g, W, D } = ctx;
  const w = W + grow * 2;
  const d = D + grow * 2;
  g.box(0, topY, d / 2 - thick / 2, w, h, thick, color);
  g.box(0, topY, -d / 2 + thick / 2, w, h, thick, color);
  g.box(w / 2 - thick / 2, topY, 0, thick, h, d - thick * 2, color);
  g.box(-w / 2 + thick / 2, topY, 0, thick, h, d - thick * 2, color);
}

function roofSlab(ctx: Ctx, topY: number, color: THREE.Color, grow = 0.08) {
  ctx.g.box(0, topY - 0.05, 0, ctx.W + grow * 2, 0.1, ctx.D + grow * 2, color);
}

function waterTank(ctx: Ctx, topY: number) {
  const { g, c, W, D, r } = ctx;
  if (W * D < 40) return;
  const sx = (r() < 0.5 ? -1 : 1) * Math.max(0, W / 2 - 1.6);
  const sz = (r() < 0.5 ? -1 : 1) * Math.max(0, D / 2 - 1.6);
  const legC = c("#7b8794");
  for (const [dx, dz] of [[-0.55, -0.55], [0.55, -0.55], [0.55, 0.55], [-0.55, 0.55]]) g.box(sx + dx, topY, sz + dz, 0.12, 0.7, 0.12, legC);
  g.lathe(sx, topY + 0.7, sz, [[0.95, 0], [1.05, 0.15], [1.05, 1.15], [0.8, 1.4], [0.45, 1.5]], 8, c("#2c3644"));
  g.lathe(sx, topY + 2.2, sz, [[0.3, 0], [0.25, 0.18]], 6, c("#556270"));
  // lift machine room
  if (r() < 0.75) g.box(-sx * 0.4, topY, -sz * 0.4, 2.6, 1.8, 2.2, c("#c9ccd2"));
}

function acUnits(ctx: Ctx, topY: number) {
  const { g, c, W, D, r } = ctx;
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    g.box((r() - 0.5) * (W - 3), topY, (r() - 0.5) * (D - 3), 1.4, 0.8, 0.9, c("#aeb6c1"));
  }
}

function balconies(ctx: Ctx, fromFloor: number, step: number, sides: number[], slabC: THREE.Color, railC: THREE.Color) {
  const { g, W, D, fh, floors } = ctx;
  for (const s of sides) {
    const f = facadeFrame(s, W, D);
    if (f.L < 5) continue;
    const len = f.L * 0.78;
    const out = 0.95;
    const ry = Math.atan2(f.nx, f.nz);
    for (let fl = fromFloor; fl < floors; fl += step) {
      const y = fl * fh;
      const cx = f.nx * (f.half + out / 2 - 0.05);
      const cz = f.nz * (f.half + out / 2 - 0.05);
      g.box(cx, y, cz, len, 0.18, out, slabC, ry);
      g.box(f.nx * (f.half + out - 0.08), y + 0.18, f.nz * (f.half + out - 0.08), len, 0.55, 0.08, railC, ry);
    }
  }
}

function awning(ctx: Ctx, y: number, colors: THREE.Color[], widthFrac = 0.9) {
  const { g, W, D } = ctx;
  const len = W * widthFrac;
  const segN = Math.max(2, Math.round(len / 1.2));
  const seg = len / segN;
  const z0 = D / 2;
  for (let i = 0; i < segN; i++) {
    const x0 = -len / 2 + i * seg;
    const x1 = x0 + seg;
    const col = colors[i % colors.length];
    g.freeQuad([x0, y - 0.55, z0 + 1.3], [x1, y - 0.55, z0 + 1.3], [x1, y, z0 + 0.05], [x0, y, z0 + 0.05], col);
    g.freeTri([x0, y, z0 + 0.05], [x0, y - 0.55, z0 + 1.3], [x0, y - 0.6, z0 + 0.05], col);
    g.freeQuad([x0, y - 0.6, z0 + 1.3], [x1, y - 0.6, z0 + 1.3], [x1, y - 0.55, z0 + 1.3], [x0, y - 0.55, z0 + 1.3], col);
  }
}

function shopfront(ctx: Ctx, h = 2.5, widthFrac = 0.88) {
  const { w, c, W, D, r } = ctx;
  const len = W * widthFrac;
  const doorSlots = Math.max(1, Math.round(len / 2.6));
  const sp = len / doorSlots;
  for (let i = 0; i < doorSlots; i++) {
    const col = glassColor(ctx, "shop");
    const x0 = -len / 2 + i * sp + 0.12;
    const x1 = -len / 2 + (i + 1) * sp - 0.12;
    w.freeQuad([x0, 0.35, D / 2 + 0.06], [x1, 0.35, D / 2 + 0.06], [x1, 0.35 + h, D / 2 + 0.06], [x0, 0.35 + h, D / 2 + 0.06], col);
  }
  void c;
  void r;
}

function signboard(ctx: Ctx, y: number, widthFrac = 0.62, h = 0.85) {
  const { g, w, c, W, D, r } = ctx;
  const sw = W * widthFrac;
  g.box(0, y, D / 2 + 0.12, sw + 0.3, h + 0.3, 0.24, c("#2b2f3a"));
  const base = SIGNS[Math.floor(r() * SIGNS.length)];
  const col = ctx.theme === "daylight" ? glowRaw(base).multiplyScalar(0.9) : glowRaw(base);
  w.freeQuad([-sw / 2, y + 0.15, D / 2 + 0.26], [sw / 2, y + 0.15, D / 2 + 0.26], [sw / 2, y + 0.15 + h, D / 2 + 0.26], [-sw / 2, y + 0.15 + h, D / 2 + 0.26], col);
  // lettering hint
  const lt = glowRaw("#ffffff").multiplyScalar(0.92);
  const nLet = Math.max(2, Math.floor(sw / 0.9));
  for (let i = 0; i < nLet; i++) {
    const x0 = -sw / 2 + 0.25 + (i * (sw - 0.5)) / nLet;
    w.freeQuad([x0, y + 0.15 + h * 0.3, D / 2 + 0.27], [x0 + (sw - 0.5) / nLet * 0.6, y + 0.15 + h * 0.3, D / 2 + 0.27], [x0 + (sw - 0.5) / nLet * 0.6, y + 0.15 + h * 0.7, D / 2 + 0.27], [x0, y + 0.15 + h * 0.7, D / 2 + 0.27], lt);
  }
}

function door(ctx: Ctx, wd = 1.1, hd = 2.1, color = "#5a3b2e") {
  const { g, w, c, D, theme } = ctx;
  g.box(0, 0, D / 2 + 0.05, wd, hd, 0.12, c(color));
  if (theme !== "daylight") {
    w.freeQuad([-0.35, hd + 0.2, D / 2 + 0.08], [0.35, hd + 0.2, D / 2 + 0.08], [0.35, hd + 0.5, D / 2 + 0.08], [-0.35, hd + 0.5, D / 2 + 0.08], glowRaw("#ffe0a0"));
  }
}

function flag(ctx: Ctx, x: number, y: number, z: number, h = 3.2) {
  const { g, c } = ctx;
  g.box(x, y, z, 0.1, h, 0.1, c("#d6dbe3"));
  const fw = 1.1;
  const fl = 0.28;
  g.box(x + fw / 2 + 0.05, y + h - fl, z, fw, fl, 0.05, glowRaw("#ff9933"));
  g.box(x + fw / 2 + 0.05, y + h - 2 * fl, z, fw, fl, 0.05, c("#f8f8f8"));
  g.box(x + fw / 2 + 0.05, y + h - 3 * fl, z, fw, fl, 0.05, glowRaw("#138808"));
}

function cross(ctx: Ctx, cx: number, y: number, cz: number, size: number, color: string, facing: "up" | "front") {
  const { w } = ctx;
  const col = glowRaw(color);
  const arm = size * 0.34;
  const half = size / 2;
  const pts = (x0: number, x1: number, y0: number, y1: number) => {
    if (facing === "up") {
      w.freeQuad([cx + x0, y, cz + y1], [cx + x1, y, cz + y1], [cx + x1, y, cz + y0], [cx + x0, y, cz + y0], col);
    } else {
      w.freeQuad([cx + x0, y + y0, cz], [cx + x1, y + y0, cz], [cx + x1, y + y1, cz], [cx + x0, y + y1, cz], col);
    }
  };
  pts(-half, half, -arm / 2, arm / 2);
  pts(-arm / 2, arm / 2, -half, half);
}

/* ------------------------------ kinds ------------------------------ */

function buildApartment(ctx: Ctx) {
  const { g, c, W, D, H, fh, floors, r } = ctx;
  const wall = c(WALLS[ctx.theme][Math.floor(r() * 6)]);
  const trim = c("#e8e6e1");
  const dark = c("#3f4654");
  g.box(0, 0, 0, W, H, D, wall);
  g.box(0, 0, 0, W + 0.14, fh * 0.55, D + 0.14, dark); // plinth
  // accent stair-core
  if (r() < 0.8) {
    const sx = r() < 0.5 ? -1 : 1;
    g.box(sx * (W / 2 - 0.9), 0, D / 2 + 0.2, 1.8, H + 0.4, 0.5, c(WALLS[ctx.theme][Math.floor(r() * 6)]));
  }
  windowGrid(ctx, 0, floors, [0, 1, 2, 3], 3, true);
  balconies(ctx, 1, 2, [0, 2], trim, c("#9aa3b2"));
  g.box(0, H, 0, W + 0.4, 0.45, D + 0.4, ctx.roof); // crown
  parapet(ctx, H + 0.45, wall, 0.25, 0.55, 0.15);
  waterTank(ctx, H + 0.45);
  // entrance
  g.box(0, 0, D / 2 + 0.05, 1.8, 2.3, 0.14, c("#4b5563"));
  if (ctx.theme !== "daylight") ctx.w.freeQuad([-0.8, 2.4, D / 2 + 0.1], [0.8, 2.4, D / 2 + 0.1], [0.8, 2.7, D / 2 + 0.1], [-0.8, 2.7, D / 2 + 0.1], glowRaw("#ffe6b0"));
}

function buildHouse(ctx: Ctx) {
  const { g, c, W, D, H, floors, r } = ctx;
  const wall = c(WALLS[ctx.theme][Math.floor(r() * 6)]);
  const roofHex = ROOFS[Math.floor(r() * ROOFS.length)];
  const gable = r() < 0.62;
  const rise = gable ? Math.min(2.2, Math.min(W, D) * 0.32) : 0;
  const bodyH = Math.max(2.4, H - rise);
  ctx.fh = bodyH / floors;
  g.box(0, 0, 0, W, bodyH, D, wall);
  g.box(0, 0, 0, W + 0.1, 0.5, D + 0.1, c("#8a8f99")); // plinth
  windowGrid(ctx, 0, floors, [0, 1, 2, 3], 2.7, true);
  door(ctx);
  g.box(0, 0, D / 2 + 0.6, 2.4, 0.2, 1.2, c("#9ca3af")); // porch step
  if (gable) {
    const alongX = W >= D;
    const sx = alongX ? W : D;
    const sz = alongX ? D : W;
    g.prism(0, bodyH, 0, sx + 0.7, sz + 0.7, rise, c(roofHex), alongX ? 0 : Math.PI / 2, wall);
    g.box((r() - 0.5) * W * 0.4, bodyH + rise * 0.6, (r() - 0.5) * D * 0.3, 0.55, rise * 0.7 + 0.5, 0.55, c("#8b5e4b"));
  } else {
    roofSlab(ctx, bodyH, ctx.roof, 0.1);
    parapet(ctx, bodyH, wall, 0.22, 0.55, 0.1);
    if (r() < 0.6) g.lathe((r() - 0.5) * (W - 3), bodyH, (r() - 0.5) * (D - 3), [[0.6, 0], [0.65, 0.1], [0.65, 0.85], [0.4, 1.0]], 7, c("#2c3644"));
  }
}

function buildShop(ctx: Ctx, mall = false) {
  const { g, c, W, D, H, floors, fh, r } = ctx;
  const wall = c(mall ? "#d9dde4" : WALLS[ctx.theme][Math.floor(r() * 6)]);
  g.box(0, 0, 0, W, H, D, wall);
  const awnCols = r() < 0.5 ? [c("#e11d48"), c("#f8f8f8")] : r() < 0.5 ? [c("#0ea5e9"), c("#f8f8f8")] : [c("#f59e0b"), c("#fff7e0")];
  shopfront(ctx, Math.min(2.6, fh * 0.75));
  awning(ctx, Math.min(3.1, fh * 0.9 + 0.2), awnCols);
  if (floors > 1) windowGrid(ctx, 1, floors, [0, 1, 2, 3], 3);
  windowGrid(ctx, 0, 1, [1, 2, 3], 3.2);
  signboard(ctx, Math.min(3.35, fh + 0.2), mall ? 0.45 : 0.62);
  roofSlab(ctx, H, ctx.roof, 0.1);
  parapet(ctx, H, wall, 0.25, 0.6, 0.1);
  if (mall) {
    // tall rooftop sign + glass atrium
    g.box(0, H, 0, W * 0.4, 2.4, 0.6, c("#2b2f3a"));
    ctx.w.freeQuad([-W * 0.18, H + 0.3, 0.32], [W * 0.18, H + 0.3, 0.32], [W * 0.18, H + 2.1, 0.32], [-W * 0.18, H + 2.1, 0.32], glowRaw("#ff4d6d"));
    ctx.w.freeQuad([-W * 0.18, H + 0.3, -0.32], [W * 0.18, H + 0.3, -0.32], [W * 0.18, H + 2.1, -0.32], [-W * 0.18, H + 2.1, -0.32], glowRaw("#ff4d6d"));
  }
  acUnits(ctx, H);
}

function buildMixed(ctx: Ctx) {
  const { g, c, W, D, H, floors, fh, r } = ctx;
  const wall = c(WALLS[ctx.theme][Math.floor(r() * 6)]);
  g.box(0, 0, 0, W, H, D, wall);
  g.box(0, fh * 0.98, 0, W + 0.18, 0.22, D + 0.18, c("#e8e6e1")); // ground-floor cornice
  shopfront(ctx, Math.min(2.6, fh * 0.75));
  awning(ctx, Math.min(3.1, fh * 0.9 + 0.2), [c("#f59e0b"), c("#fff7e0")]);
  windowGrid(ctx, 0, 1, [1, 2, 3], 3.2);
  if (floors > 1) windowGrid(ctx, 1, floors, [0, 1, 2, 3], 3);
  balconies(ctx, 1, 1, [0], c("#e8e6e1"), c("#9aa3b2"));
  signboard(ctx, Math.min(3.35, fh + 0.2));
  g.box(0, H, 0, W + 0.3, 0.35, D + 0.3, ctx.roof);
  parapet(ctx, H + 0.35, wall, 0.22, 0.5, 0.12);
  if (floors >= 3) waterTank(ctx, H + 0.35);
  else acUnits(ctx, H + 0.35);
}

function buildOffice(ctx: Ctx) {
  const { g, c, W, D, H, floors, r } = ctx;
  const wall = c(r() < 0.5 ? "#c6ced9" : "#b9c4d2");
  g.box(0, 0, 0, W, H, D, wall);
  windowGrid(ctx, 0, floors, [0, 1, 2, 3], 2.4, true);
  g.box(0, H, 0, W + 0.3, 0.4, D + 0.3, c("#6b7280"));
  acUnits(ctx, H + 0.4);
  door(ctx, 1.6, 2.4, "#3f4654");
}

function buildSchool(ctx: Ctx) {
  const { g, w, c, W, D, H, floors, fh, r } = ctx;
  const wall = c(r() < 0.5 ? "#f4e2b0" : "#f1d6b0");
  const band = c(BANDS[Math.floor(r() * BANDS.length)]);
  // ground / yard
  g.box(0, 0.06, 0, W + 2, 0.06, D + 2, c(ctx.theme === "daylight" ? "#cfd8c0" : "#8a9a82"));
  g.box(0, 0.08, 0, W, H, D, wall);
  const y0 = 0.1;
  // band under roof + ground band
  g.box(0, y0 + H - 0.95, 0, W + 0.12, 0.8, D + 0.12, band);
  g.box(0, y0, 0, W + 0.1, 0.5, D + 0.1, band);
  windowGrid(ctx, 0, floors, [0, 1, 2, 3], 2.6, true);
  // entrance block
  const eb = Math.min(W * 0.3, 6);
  g.box(0, y0, D / 2 + 0.7, eb, H + 0.8, 1.4, c("#fff3c9"));
  g.prism(0, y0 + H + 0.8, D / 2 + 0.7, eb + 0.3, 1.7, 1.1, band, 0);
  g.box(0, y0, D / 2 + 1.42, 1.6, 2.4, 0.12, c("#3f4654"));
  if (ctx.theme !== "daylight") w.freeQuad([-0.6, 2.8, D / 2 + 1.5], [0.6, 2.8, D / 2 + 1.5], [0.6, 3.2, D / 2 + 1.5], [-0.6, 3.2, D / 2 + 1.5], glowRaw("#ffe6b0"));
  roofSlab(ctx, y0 + H, ctx.roof, 0.1);
  parapet(ctx, y0 + H, wall, 0.22, 0.5, 0.1);
  flag(ctx, W / 2 - 1.2, y0 + H, -D / 2 + 1.2, 3.4);
  void fh;
}

function buildHospital(ctx: Ctx, clinic: boolean) {
  const { g, w, c, W, D, H, floors, r } = ctx;
  const wall = c("#f3f6f8");
  const accentHex = clinic ? "#16a34a" : "#e11d48";
  const accent = c(accentHex);
  g.box(0, 0, 0, W, H, D, wall);
  g.box(0, H * 0.55, 0, W + 0.1, 0.35, D + 0.1, accent); // accent stripe
  windowGrid(ctx, 0, floors, [0, 1, 2, 3], 2.8, true);
  g.box(0, H, 0, W + 0.3, 0.4, D + 0.3, c("#dfe5ea"));
  parapet(ctx, H + 0.4, wall, 0.22, 0.45, 0.12);
  // facade sign panel + roof cross
  const sz = Math.min(3, Math.max(1.8, Math.min(W, D) * 0.4));
  g.box(0, Math.max(H - sz - 0.6, 2.6), D / 2 + 0.05, sz + 0.4, sz + 0.4, 0.18, c("#ffffff"));
  cross(ctx, 0, Math.max(H - sz - 0.4, 2.8), D / 2 + 0.18, sz, accentHex, "front");
  cross(ctx, 0, H + 0.43, 0, Math.min(W, D) * 0.45, accentHex, "up");
  // ambulance bay canopy
  g.box(0, 3.0, D / 2 + 1.6, 4.4, 0.25, 3.2, accent);
  g.box(-1.9, 0, D / 2 + 2.9, 0.18, 3.0, 0.18, c("#cbd5e1"));
  g.box(1.9, 0, D / 2 + 2.9, 0.18, 3.0, 0.18, c("#cbd5e1"));
  if (ctx.theme !== "daylight") w.freeQuad([-2, 2.9, D / 2 + 3.2], [2, 2.9, D / 2 + 3.2], [2, 3.0, D / 2 + 3.2], [-2, 3.0, D / 2 + 3.2], glowRaw("#ffffff"));
  void r;
}

/**
 * Stylised Nagara-style mandir: stepped jagati (plinth) with front steps, an
 * open pillared mandapa with a stepped pyramidal roof, the garbhagriha under a
 * curved, banded shikhara with corner urushringas, amalaka + golden kalash, a
 * saffron dhvaja, and diyas / a deepastambha that glow warmly at night.
 */
function buildMandir(ctx: Ctx) {
  const { g, w, W, D, H, theme } = ctx;
  const night = theme !== "daylight";
  // keep the sandstone warm at night (lamp-lit) instead of the cool moonlight tone
  const warmTone = theme === "night" ? [0.78, 0.6, 0.48] : theme === "sunset" ? [1, 0.86, 0.76] : [1, 1, 1];
  const c = (hex: string) => {
    const col = new THREE.Color(hex);
    col.r *= warmTone[0];
    col.g *= warmTone[1];
    col.b *= warmTone[2];
    return col;
  };
  const stone = c("#f2d3a8"); // light sandstone
  const sand = c("#e3b27a");
  const deep = c("#c98a52");
  const saffron = c("#ef7d1a");
  const red = c("#b8432a");
  const gold = c("#e0a72a");
  const goldGlow = glowRaw(night ? "#ffc845" : "#e6b33a");
  const flame = glowRaw(night ? "#fff0b0" : "#f4d48a");

  /* jagati — two-tier plinth */
  g.box(0, 0, 0, W, 0.55, D, deep, 0, true);
  g.box(0, 0.55, -0.2, W * 0.9, 0.5, D * 0.9, stone);
  const floorY = 1.05;
  // front steps (descending toward +z)
  for (let i = 0; i < 4; i++) {
    const sy = floorY - (i + 1) * (floorY / 4);
    g.box(0, 0, D * 0.45 - 0.2 + i * 0.38, 3.4 + i * 0.25, sy + floorY / 4, 0.4, i % 2 ? stone : sand);
  }
  // decorative band around the plinth
  g.box(0, 0.4, 0, W + 0.06, 0.12, D + 0.06, red);

  /* garbhagriha + shikhara (rear) */
  const sz = -D * 0.2; // sanctum centre z
  const sw = Math.min(W * 0.62, D * 0.5);
  const sanctumH = 3.4;
  g.box(0, floorY, sz, sw, sanctumH, sw, sand);
  // offsets (ratha projections) on the three outer faces
  g.box(0, floorY, sz, sw * 0.42, sanctumH, sw + 0.5, stone);
  g.box(0, floorY, sz, sw + 0.5, sanctumH, sw * 0.42, stone);
  g.box(0, floorY + sanctumH - 0.25, sz, sw + 0.7, 0.3, sw + 0.7, red); // cornice
  // curved shikhara: stacked bands whose width follows a convex curve
  const shH = Math.max(5.5, H - floorY - sanctumH - 2.4);
  const bands = 9;
  let y = floorY + sanctumH + 0.05;
  const rAt = (t: number) => sw * (1.02 - 0.72 * Math.pow(t, 1.7));
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands;
    const t1 = (i + 1) / bands;
    const h = shH / bands;
    const b0 = rAt(t0);
    const b1 = rAt(t1);
    g.frustum(0, y, sz, b0, b0, b1, b1, h * 0.86, i % 3 === 2 ? deep : stone);
    // thin horizontal lip (bhumi-amalaka line)
    g.frustum(0, y + h * 0.86, sz, b1 * 1.04, b1 * 1.04, b1, b1, h * 0.14, sand);
    // central vertical rib (latas) on each face
    g.frustum(0, y, sz, b0 * 0.34, b0 + 0.18, b1 * 0.34, b1 + 0.18, h, sand);
    g.frustum(0, y, sz, b0 + 0.18, b0 * 0.34, b1 + 0.18, b1 * 0.34, h, sand);
    y += h;
  }
  // corner urushringas (miniature shikharas)
  const us = sw * 0.3;
  for (const sx of [-1, 1]) for (const szz of [-1, 1]) {
    let uy = floorY + sanctumH + 0.05;
    let uw = us;
    for (let i = 0; i < 4; i++) {
      const nw = uw * 0.78;
      g.frustum(sx * (sw / 2 - us / 2), uy, sz + szz * (sw / 2 - us / 2), uw, uw, nw, nw, 0.55, i % 2 ? sand : stone);
      uy += 0.55;
      uw = nw;
    }
    g.lathe(sx * (sw / 2 - us / 2), uy, sz + szz * (sw / 2 - us / 2), [[uw * 0.6, 0], [uw * 0.7, 0.12], [uw * 0.6, 0.25], [0.05, 0.4]], 8, gold);
  }
  // amalaka (ribbed disc) + kalash + dhvaja
  const top = rAt(1);
  g.lathe(0, y, sz, [[top * 0.35, 0], [top * 0.62, 0.18], [top * 0.66, 0.38], [top * 0.62, 0.58], [top * 0.3, 0.75]], 14, stone);
  y += 0.75;
  g.lathe(0, y, sz, [[0.18, 0], [0.42, 0.25], [0.45, 0.45], [0.22, 0.7], [0.14, 0.85], [0.28, 0.95], [0.02, 1.35]], 10, gold);
  w.freeQuad([-0.12, y + 1.0, sz + 0.3], [0.12, y + 1.0, sz + 0.3], [0.12, y + 1.35, sz + 0.3], [-0.12, y + 1.35, sz + 0.3], goldGlow);
  // flag pole + saffron pennant
  const poleX = top * 0.25;
  g.box(poleX, y, sz, 0.08, 3.2, 0.08, c("#d6dbe3"));
  const fy = y + 3.2;
  g.freeTri([poleX, fy, sz], [poleX, fy - 1.0, sz], [poleX + 1.9, fy - 0.35, sz], night ? glowRaw("#ff8a1f").multiplyScalar(0.85) : saffron);
  g.freeTri([poleX, fy - 1.0, sz], [poleX, fy, sz], [poleX + 1.9, fy - 0.35, sz], night ? glowRaw("#ff8a1f").multiplyScalar(0.85) : saffron);
  // sanctum door + warm deity lamp (seen through the mandapa)
  g.box(0, floorY, sz + sw / 2 + 0.26, 1.4, 2.3, 0.12, red);
  w.freeQuad([-0.5, floorY + 0.15, sz + sw / 2 + 0.34], [0.5, floorY + 0.15, sz + sw / 2 + 0.34], [0.5, floorY + 1.95, sz + sw / 2 + 0.34], [-0.5, floorY + 1.95, sz + sw / 2 + 0.34], glowRaw(night ? "#ffcf6b" : "#c9873e"));

  /* mandapa (front): open pillared hall with stepped roof */
  const mz0 = sz + sw / 2 + 0.3; // back of hall
  const mz1 = D / 2 - 1.5; // front of hall
  const mw = W * 0.82;
  const md = mz1 - mz0;
  const mzc = (mz0 + mz1) / 2;
  const pillarH = 2.7;
  const cols = 4;
  for (let i = 0; i < cols; i++) {
    const px = -mw / 2 + 0.3 + (i * (mw - 0.6)) / (cols - 1);
    for (const pz of [mz0 + 0.35, mzc, mz1 - 0.3]) {
      if (pz === mzc && i > 0 && i < cols - 1) continue; // open centre aisle
      g.box(px, floorY, pz, 0.42, 0.3, 0.42, sand); // base
      g.box(px, floorY + 0.3, pz, 0.3, pillarH - 0.6, 0.3, stone);
      g.box(px, floorY + pillarH - 0.3, pz, 0.5, 0.3, 0.5, sand); // bracket capital
    }
  }
  // lamp-lit floor of the hall
  if (night) {
    const fl = glowRaw("#7a4a1c");
    w.freeQuad([-mw / 2, floorY + 0.02, mz1], [mw / 2, floorY + 0.02, mz1], [mw / 2, floorY + 0.02, mz0], [-mw / 2, floorY + 0.02, mz0], fl);
  }
  const roofY = floorY + pillarH;
  g.box(0, roofY, mzc, mw + 0.5, 0.35, md + 0.5, deep); // chhajja (eave)
  g.box(0, roofY + 0.35, mzc, mw * 0.92, 0.5, md * 0.9, stone);
  // phamsana: stepped pyramid of slabs
  let ry = roofY + 0.85;
  let rw = mw * 0.9;
  let rd = md * 0.88;
  for (let i = 0; i < 4; i++) {
    g.frustum(0, ry, mzc, rw, rd, rw * 0.8, rd * 0.8, 0.5, i % 2 ? sand : stone);
    g.box(0, ry + 0.5, mzc, rw * 0.84, 0.1, rd * 0.84, red);
    ry += 0.6;
    rw *= 0.76;
    rd *= 0.76;
  }
  g.lathe(0, ry, mzc, [[rw * 0.5, 0], [rw * 0.55, 0.2], [0.2, 0.45], [0.18, 0.6], [0.02, 0.95]], 10, gold);
  // toran (garland) over the front pillars
  g.box(0, roofY - 0.25, mz1 + 0.02, mw * 0.9, 0.12, 0.08, saffron);

  /* diyas along the plinth edge + deepastambha in the forecourt */
  const diyaY = floorY + 0.02;
  for (let i = 0; i < 9; i++) {
    const x = -W * 0.42 + (i * W * 0.84) / 8;
    if (Math.abs(x) < 1.9) continue; // keep the steps clear
    const z = D * 0.45 - 0.35;
    g.box(x, diyaY, z, 0.24, 0.1, 0.24, c("#8a4b2a"));
    w.freeQuad([x - 0.06, diyaY + 0.1, z], [x + 0.06, diyaY + 0.1, z], [x, diyaY + 0.42, z], [x, diyaY + 0.42, z], flame);
    w.freeQuad([x, diyaY + 0.1, z - 0.06], [x, diyaY + 0.1, z + 0.06], [x, diyaY + 0.42, z], [x, diyaY + 0.42, z], flame);
  }
  for (const sx of [-1, 1]) {
    // side diyas along the sanctum
    for (let k = 0; k < 3; k++) {
      const x = sx * (W * 0.45 - 0.2);
      const z = -D * 0.38 + k * (D * 0.25);
      w.freeQuad([x, diyaY + 0.1, z - 0.06], [x, diyaY + 0.1, z + 0.06], [x, diyaY + 0.42, z], [x, diyaY + 0.42, z], flame);
    }
  }
  // deepastambha (lamp pillar) beside the steps
  const dx = W * 0.5 + 0.9;
  const dz = D / 2 + 0.6;
  g.box(dx, 0, dz, 0.8, 0.3, 0.8, deep);
  g.box(dx, 0.3, dz, 0.3, 3.2, 0.3, stone);
  for (let k = 0; k < 4; k++) {
    const ly = 0.9 + k * 0.7;
    const lw = 0.9 - k * 0.12;
    g.box(dx, ly, dz, lw, 0.08, lw, sand);
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const lx = dx + ox * lw * 0.45;
      const lz = dz + oz * lw * 0.45;
      w.freeQuad([lx - 0.05, ly + 0.08, lz], [lx + 0.05, ly + 0.08, lz], [lx, ly + 0.3, lz], [lx, ly + 0.3, lz], flame);
    }
  }
  w.freeQuad([dx - 0.08, 3.5, dz], [dx + 0.08, 3.5, dz], [dx, 3.95, dz], [dx, 3.95, dz], flame);
  // bell arch at the foot of the steps
  g.box(-2.1, 0, D / 2 + 0.9, 0.18, 2.6, 0.18, gold);
  g.box(2.1, 0, D / 2 + 0.9, 0.18, 2.6, 0.18, gold);
  g.box(0, 2.6, D / 2 + 0.9, 4.4, 0.18, 0.18, gold);
  g.lathe(0, 2.05, D / 2 + 0.9, [[0.05, 0.55], [0.22, 0.25], [0.26, 0]].reverse() as [number, number][], 8, gold);
}

function buildMasjid(ctx: Ctx) {
  const { g, w, c, W, D, H, r } = ctx;
  const white = c("#f4efe3");
  const green = c("#1f9d6b");
  const s = Math.min(W, D);
  const hallH = Math.max(4, H * 0.6);
  g.box(0, 0, 0, W, 0.5, D, c("#c9c1b0"));
  g.box(0, 0.5, 0, W * 0.9, hallH, D * 0.9, white);
  g.box(0, 0.5 + hallH, 0, W * 0.94, 0.3, D * 0.94, green);
  // dome
  const dr = s * 0.3;
  const top = 0.8 + hallH;
  g.box(0, top, 0, dr * 1.7, 0.9, dr * 1.7, white);
  g.lathe(0, top + 0.9, 0, [[dr * 0.85, 0], [dr * 0.98, dr * 0.3], [dr * 0.88, dr * 0.65], [dr * 0.6, dr * 0.92], [dr * 0.3, dr * 1.12], [0.05, dr * 1.25]], 10, green);
  w.freeQuad([-0.2, top + 0.9 + dr * 1.25, 0], [0.2, top + 0.9 + dr * 1.25, 0], [0.2, top + 0.9 + dr * 1.25 + 0.9, 0], [-0.2, top + 0.9 + dr * 1.25 + 0.9, 0], glowRaw("#ffd34d"));
  // minarets
  const mh = Math.max(H * 1.5, hallH + 4);
  for (const [sx, sz] of [[-1, 1], [1, 1]]) {
    const x = sx * (W * 0.45);
    const z = sz * (D * 0.45);
    g.lathe(x, 0.5, z, [[0.55, 0], [0.45, mh * 0.6], [0.55, mh * 0.62], [0.4, mh]], 8, white);
    g.lathe(x, 0.5 + mh, z, [[0.6, 0], [0.5, 0.35], [0.28, 0.9], [0.05, 1.5]], 8, green);
    w.freeQuad([x - 0.3, 0.5 + mh * 0.62, z + 0.5], [x + 0.3, 0.5 + mh * 0.62, z + 0.5], [x + 0.3, 0.5 + mh * 0.66, z + 0.5], [x - 0.3, 0.5 + mh * 0.66, z + 0.5], glowRaw("#ffd9a0"));
  }
  // arched door glow
  w.freeQuad([-1, 0.6, D * 0.45 + 0.06], [1, 0.6, D * 0.45 + 0.06], [1, 3.2, D * 0.45 + 0.06], [-1, 3.2, D * 0.45 + 0.06], glowRaw(ctx.theme === "daylight" ? "#9fd3ec" : "#ffd9a0"));
  void r;
}

function buildChurch(ctx: Ctx) {
  const { g, w, c, W, D, H, r } = ctx;
  const wall = c("#f0ece4");
  const slate = c("#5b6676");
  const wallH = Math.max(3.5, H * 0.55);
  g.box(0, 0, 0, W, wallH, D, wall);
  const alongX = W >= D;
  g.prism(0, wallH, 0, (alongX ? W : D) + 0.6, (alongX ? D : W) + 0.6, Math.min(3.2, Math.min(W, D) * 0.4), slate, alongX ? 0 : Math.PI / 2, wall);
  // bell tower at front
  const tw = Math.min(W, D) * 0.34;
  const th = H * 1.35 + 2;
  g.box(0, 0, D / 2 - tw / 2 + 0.3, tw, th, tw, wall);
  g.frustum(0, th, D / 2 - tw / 2 + 0.3, tw * 1.08, tw * 1.08, 0.05, 0.05, tw * 1.5, slate);
  w.freeQuad([-0.5, th - 2, D / 2 + 0.31], [0.5, th - 2, D / 2 + 0.31], [0.5, th - 0.6, D / 2 + 0.31], [-0.5, th - 0.6, D / 2 + 0.31], glowRaw("#ffd9a0"));
  g.box(0, th + tw * 1.5, D / 2 - tw / 2 + 0.3, 0.12, 1.2, 0.12, c("#e8d28a"));
  g.box(0, th + tw * 1.5 + 0.6, D / 2 - tw / 2 + 0.3, 0.7, 0.12, 0.12, c("#e8d28a"));
  // stained-glass side windows
  windowGrid(ctx, 0, 1, [1, 3], 3.2);
  g.box(0, 0, D / 2 + 0.2, 1.8, 2.6, 0.12, c("#5a3b2e"));
  void r;
}

function buildDomeHall(ctx: Ctx) {
  // generic place of worship: hall with golden dome and corner turrets
  const { g, c, W, D, H } = ctx;
  const wall = c("#f1e5cf");
  const hallH = Math.max(3.5, H * 0.65);
  g.box(0, 0, 0, W, 0.5, D, c("#cdbfa7"));
  g.box(0, 0.5, 0, W * 0.92, hallH, D * 0.92, wall);
  const dr = Math.min(W, D) * 0.3;
  g.lathe(0, 0.5 + hallH, 0, [[dr, 0], [dr * 1.05, dr * 0.35], [dr * 0.8, dr * 0.8], [dr * 0.35, dr * 1.1], [0.05, dr * 1.3]], 10, c("#d9a441"));
  ctx.w.freeQuad([-0.2, 0.5 + hallH + dr * 1.3, 0], [0.2, 0.5 + hallH + dr * 1.3, 0], [0.2, 0.5 + hallH + dr * 1.3 + 1, 0], [-0.2, 0.5 + hallH + dr * 1.3 + 1, 0], glowRaw("#ffd34d"));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.lathe(sx * W * 0.42, 0.5 + hallH, sz * D * 0.42, [[0.6, 0], [0.55, 1.0], [0.3, 1.8], [0.05, 2.4]], 6, c("#d9a441"));
  }
  windowGrid(ctx, 0, 1, [0, 1, 2, 3], 3.2);
}

function buildCommunity(ctx: Ctx) {
  const { g, w, c, W, D, H, floors, r } = ctx;
  const wall = c(r() < 0.5 ? "#b9e3dc" : "#e6dcc0");
  const roof = c("#0f766e");
  const bodyH = Math.max(3.4, H);
  g.box(0, 0, 0, W, bodyH, D, wall);
  g.box(0, 0, 0, W + 0.1, 0.5, D + 0.1, c("#6b7a80"));
  windowGrid(ctx, 0, Math.max(1, floors), [0, 1, 2, 3], 3, true);
  // hip roof
  g.frustum(0, bodyH, 0, W + 0.8, D + 0.8, Math.max(0.6, W * 0.4), Math.max(0.6, D * 0.35), Math.min(2.8, Math.min(W, D) * 0.3), roof);
  // portico
  const pw = Math.min(W * 0.55, 7);
  g.box(0, 3.1, D / 2 + 1.2, pw + 0.4, 0.3, 2.4, c("#0f766e"));
  for (const sx of [-1, 1]) g.box(sx * (pw / 2 - 0.1), 0, D / 2 + 2.1, 0.3, 3.1, 0.3, c("#f4f1ea"));
  g.box(0, 0, D / 2 + 0.05, 1.8, 2.5, 0.12, c("#3f4654"));
  if (ctx.theme !== "daylight") w.freeQuad([-1.2, 2.5, D / 2 + 0.3], [1.2, 2.5, D / 2 + 0.3], [1.2, 3.0, D / 2 + 0.3], [-1.2, 3.0, D / 2 + 0.3], glowRaw("#9ff3e4"));
}

/* ------------------------------------------------------------------ */
/* assembly                                                            */
/* ------------------------------------------------------------------ */

function buildAll(buildings: Building[], kinds: Map<string, BuildingKind>, theme: Theme) {
  const g = new GeoBuilder();
  const w = new GeoBuilder();
  const tone = TONE[theme];
  const m = new THREE.Matrix4();
  const mr = new THREE.Matrix4();
  const me = new THREE.Matrix4();

  for (const b of buildings) {
    const kind = kinds.get(b.id) ?? "apartment";
    const rng = mulberry32(hashNum(b.id));
    // choose front side from entrance, snapped to the nearest face
    let extra = 0;
    if (b.entrance) {
      const dx = b.entrance.x - b.x;
      const dz = b.entrance.z - b.z;
      const c = Math.cos(-b.rotation);
      const s = Math.sin(-b.rotation);
      const lx = dx * c + dz * s;
      const lz = -dx * s + dz * c;
      const nx = lx / Math.max(b.width, 1);
      const nz = lz / Math.max(b.depth, 1);
      if (Math.hypot(nx, nz) > 0.05) {
        if (Math.abs(nz) >= Math.abs(nx)) extra = nz >= 0 ? 0 : Math.PI;
        else extra = nx >= 0 ? Math.PI / 2 : -Math.PI / 2;
      }
    }
    const swap = Math.abs(Math.sin(extra)) > 0.5;
    const W = Math.max(2, swap ? b.depth : b.width);
    const D = Math.max(2, swap ? b.width : b.depth);
    const H = Math.max(3, b.height);
    const floors = Math.max(1, Math.round(b.floors || H / 3));
    m.makeRotationY(b.rotation).setPosition(b.x, 0, b.z);
    mr.makeRotationY(extra);
    me.multiplyMatrices(m, mr);
    g.setBase(me);
    w.setBase(me);

    const ctx: Ctx = {
      g,
      w,
      theme,
      rnd: rng,
      W,
      D,
      H,
      floors,
      fh: H / floors,
      c: (hex: string) => {
        const col = new THREE.Color(hex);
        col.r *= tone[0];
        col.g *= tone[1];
        col.b *= tone[2];
        return col;
      },
      r: rng,
      roof: new THREE.Color(ROOF_TOPS[Math.floor(rng() * ROOF_TOPS.length)]).multiply(new THREE.Color(tone[0], tone[1], tone[2])),
      litBias: (theme === "night" ? 0.28 + rng() * 0.5 : theme === "sunset" ? 0.08 + rng() * 0.22 : 0),
    };

    switch (kind) {
      case "apartment":
        buildApartment(ctx);
        break;
      case "house":
        buildHouse(ctx);
        break;
      case "shop":
        buildShop(ctx);
        break;
      case "mall":
        buildShop(ctx, true);
        break;
      case "mixed":
        buildMixed(ctx);
        break;
      case "office":
        buildOffice(ctx);
        break;
      case "school":
        buildSchool(ctx);
        break;
      case "hospital":
        buildHospital(ctx, false);
        break;
      case "clinic":
        buildHospital(ctx, true);
        break;
      case "mandir":
        buildMandir(ctx);
        break;
      case "masjid":
        buildMasjid(ctx);
        break;
      case "church":
        buildChurch(ctx);
        break;
      case "worship":
        buildDomeHall(ctx);
        break;
      case "community":
        buildCommunity(ctx);
        break;
    }
  }
  return { body: g.toGeometry(), glow: w.toGeometry() };
}

/* ------------------------------------------------------------------ */
/* React layer                                                         */
/* ------------------------------------------------------------------ */

function placeAt(x: number, z: number) {
  const s = useEditor.getState();
  if (s.moveMode && s.selection) {
    s.moveObject(s.selection, x, z);
    s.setMoveMode(false);
    return;
  }
  switch (s.tool) {
    case "streetlight":
      s.addStreetlight(x, z);
      break;
    case "camera":
      s.addCamera(x, z);
      break;
    case "guard":
      s.guardToolClick({ x, z }); // left-click extends the selected guard; right-click drops guards
      break;
    case "building":
      s.addBuilding(x, z);
      break;
    case "facility":
      s.addFacility(x, z);
      break;
    case "road":
      s.pushRoadPoint({ x, z });
      break;
  }
}

const EMPTY_FACILITIES: Facility[] = [];

/**
 * Selection outline. While the building is being dragged it follows the pointer
 * (liveMove, no re-render) with a translucent body, so the move is visible before
 * the merged city mesh is rebuilt on drop.
 */
function SelectedBuilding({ b, edges }: { b: Building; edges: THREE.BufferGeometry }) {
  const ref = useRef<THREE.Group>(null);
  const dragging = useEditor((s) => s.dragState?.id === b.id && s.dragState.moved);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    if (liveMove.id === b.id) g.position.set(liveMove.x, 0, liveMove.z);
    else g.position.set(b.x, 0, b.z);
  });
  return (
    <group ref={ref} position={[b.x, 0, b.z]} rotation={[0, b.rotation, 0]}>
      <lineSegments position={[0, b.height / 2, 0]} geometry={edges} raycast={() => null}>
        <lineBasicMaterial color="#38bdf8" />
      </lineSegments>
      {dragging && (
        <>
          <mesh position={[0, b.height / 2, 0]} raycast={() => null}>
            <boxGeometry args={[b.width, b.height, b.depth]} />
            <meshBasicMaterial color="#38bdf8" transparent opacity={0.28} depthWrite={false} />
          </mesh>
          {/* footprint on the ground so the drop spot is obvious */}
          <mesh position={[0, 0.15, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
            <planeGeometry args={[b.width, b.depth]} />
            <meshBasicMaterial color="#38bdf8" transparent opacity={0.35} depthWrite={false} />
          </mesh>
        </>
      )}
    </group>
  );
}

export function BuildingsLayer({
  buildings,
  selectedId,
  theme = "night",
}: {
  buildings: Building[];
  selectedId: string | null;
  theme?: Theme;
}) {
  const pickRef = useRef<THREE.InstancedMesh>(null);
  const select = useEditor((s) => s.select);
  const facilities = useEditor((s) => s.project?.world.facilities) ?? EMPTY_FACILITIES;

  // Every edit deep-clones the world: rebuild the merged city mesh only when something that
  // affects its look changed (not e.g. on a streetlight slider tick).
  const sig = useMemo(
    () =>
      buildings.map((b) => `${b.id}|${b.x}|${b.z}|${b.width}|${b.depth}|${b.rotation}|${b.height}|${b.category}|${b.name ?? ""}`).join("#") +
      "~" +
      facilities.map((f) => `${f.type}|${f.x}|${f.z}|${f.name ?? ""}`).join("#"),
    [buildings, facilities]
  );
  /* eslint-disable react-hooks/exhaustive-deps */
  const kinds = useMemo(() => classifyAll(buildings, facilities), [sig]);
  const { body, glow } = useMemo(() => buildAll(buildings, kinds, theme), [kinds, theme]);
  /* eslint-enable react-hooks/exhaustive-deps */
  useEffect(
    () => () => {
      body.dispose();
      glow.dispose();
    },
    [body, glow]
  );

  const count = buildings.length;
  useEffect(() => {
    const mesh = pickRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const s = new THREE.Matrix4();
    buildings.forEach((b, i) => {
      m.makeRotationY(b.rotation);
      m.setPosition(b.x, b.height / 2, b.z);
      s.makeScale(b.width, b.height, b.depth);
      m.multiply(s);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = count;
    mesh.computeBoundingSphere();
  }, [buildings, count]);

  const selected = buildings.find((b) => b.id === selectedId);
  const sw = selected?.width;
  const sh = selected?.height;
  const sd = selected?.depth;
  const selEdges = useMemo(() => {
    if (sw === undefined || sh === undefined || sd === undefined) return null;
    const box = new THREE.BoxGeometry(sw, sh, sd);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose(); // only needed to derive the edges
    return edges;
  }, [sw, sh, sd]);
  useEffect(() => () => selEdges?.dispose(), [selEdges]);

  const nightish = theme !== "daylight";
  return (
    <group>
      <mesh geometry={body} raycast={() => null}>
        <meshStandardMaterial
          vertexColors
          side={THREE.DoubleSide}
          roughness={theme === "daylight" ? 0.8 : 0.85}
          metalness={0.04}
          emissive={theme === "night" ? "#1b2a44" : theme === "sunset" ? "#5a2c1c" : "#000000"}
          emissiveIntensity={nightish ? 0.22 : 0}
        />
      </mesh>
      <mesh geometry={glow} raycast={() => null}>
        <meshBasicMaterial vertexColors side={THREE.DoubleSide} toneMapped={false} />
      </mesh>

      {/* invisible, cheap pick proxies (one box per building) */}
      <instancedMesh
        ref={pickRef}
        args={[undefined, undefined, Math.max(count, 1)]}
        frustumCulled={false}
        onPointerDown={(e) => {
          // edit mode + select tool: press-and-drag moves the building (same gesture as lights/cameras)
          const s = useEditor.getState();
          if (e.nativeEvent.button !== 0 || s.tool !== "select" || s.mode !== "edit" || s.activeRun !== null) return;
          const b = e.instanceId !== undefined ? buildings[e.instanceId] : undefined;
          if (!b) return;
          e.stopPropagation();
          select({ kind: "building", id: b.id });
          armPendingDrag(e, "building", b.id, b.x - e.point.x, b.z - e.point.z);
        }}
        onClick={(e) => {
          const s = useEditor.getState();
          if (s.tool === "road") return; // let the ground take it
          e.stopPropagation();
          if (e.delta > 4) return; // camera drag, not a click
          const iid = e.instanceId ?? null;
          if (iid === null) return;
          const b = buildings[iid];
          if (!b) return;
          if (s.tool !== "select") placeAt(b.x, b.z);
          else select({ kind: "building", id: b.id });
        }}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </instancedMesh>

      {selected && selEdges && <SelectedBuilding b={selected} edges={selEdges} />}
    </group>
  );
}


