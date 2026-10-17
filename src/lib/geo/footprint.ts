/**
 * Footprint fitting for imported building outlines (local meters, x east / z south).
 *
 * The world model draws buildings as rotated boxes. A naive axis-aligned
 * bounding box of a mapped outline badly inflates tilted blocks (a 45° block
 * doubles in area) and turns L / U / cross-shaped towers into one giant slab.
 * Instead:
 *   1. fit the minimum-area oriented rectangle (rotating calipers on the hull);
 *   2. when the outline fills that rectangle poorly (non-convex shapes), split it
 *      into up to `maxParts` rectangles by greedy maximal-rectangle cover of a
 *      raster of the outline in the rectangle's own frame.
 * Pure + deterministic (unit tested).
 */

export interface Pt {
  x: number;
  z: number;
}

/** A rotated box: centre, size along its own axes, and three.js Y rotation (radians). */
export interface FitBox {
  x: number;
  z: number;
  width: number;
  depth: number;
  rotation: number;
}

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].z - poly[i].z);
  return Math.abs(a / 2);
}

export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Frame of a box: axis angle θ (radians, in the x/z plane) and extents. */
interface Frame {
  theta: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

const toU = (p: Pt, c: number, s: number) => p.x * c + p.z * s;
const toV = (p: Pt, c: number, s: number) => -p.x * s + p.z * c;

/** Minimum-area enclosing rectangle frame (edges of the convex hull are candidate axes). */
function minAreaFrame(pts: Pt[]): Frame {
  const hull = convexHull(pts);
  let best: Frame | null = null;
  let bestArea = Infinity;
  const n = hull.length;
  for (let i = 0; i < Math.max(1, n); i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n] ?? a;
    const theta = Math.atan2(b.z - a.z, b.x - a.x);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of hull) {
      const u = toU(p, c, s);
      const v = toV(p, c, s);
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      best = { theta, u0, u1, v0, v1 };
    }
  }
  return best!;
}

/** Normalise so width is the long side and the rotation stays in (-π/2, π/2]. */
function frameBox(theta: number, u0: number, u1: number, v0: number, v1: number): FitBox {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  let w = u1 - u0;
  let d = v1 - v0;
  let th = theta;
  if (d > w) {
    [w, d] = [d, w];
    th += Math.PI / 2;
  }
  while (th > Math.PI / 2) th -= Math.PI;
  while (th <= -Math.PI / 2) th += Math.PI;
  // three.js Y rotation r maps local +x to world (cos r, −sin r) → r = −θ
  return { x: uc * c - vc * s, z: uc * s + vc * c, width: w, depth: d, rotation: Math.abs(th) < 1e-9 ? 0 : -th };
}

export function orientedBox(poly: Pt[]): FitBox {
  const f = minAreaFrame(poly);
  return frameBox(f.theta, f.u0, f.u1, f.v0, f.v1);
}

function pip(u: number, v: number, poly: { u: number; v: number }[]) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.v > v !== b.v > v && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) ins = !ins;
  }
  return ins;
}

/** Largest all-true rectangle in a boolean grid (histogram method). */
function largestRect(g: boolean[][]): { r0: number; c0: number; r1: number; c1: number; area: number } | null {
  const rows = g.length;
  const cols = g[0]?.length ?? 0;
  const h = new Array<number>(cols).fill(0);
  let best: { r0: number; c0: number; r1: number; c1: number; area: number } | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) h[c] = g[r][c] ? h[c] + 1 : 0;
    const st: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const hc = c < cols ? h[c] : 0;
      while (st.length && h[st[st.length - 1]] >= hc) {
        const top = st.pop()!;
        const height = h[top];
        const left = st.length ? st[st.length - 1] + 1 : 0;
        const area = height * (c - left);
        if (height > 0 && (!best || area > best.area)) best = { r0: r - height + 1, c0: left, r1: r, c1: c - 1, area };
      }
      st.push(c);
    }
  }
  return best;
}

export interface FitResult {
  parts: FitBox[];
  /** outline area / oriented-rectangle area (1 = perfect rectangle) */
  fill: number;
  area: number;
}

/**
 * Fit an outline with 1..maxParts rotated boxes. Rectangles (fill ≥ 0.8) or
 * small outlines stay a single oriented box.
 */
export function fitFootprint(poly: Pt[], opts: { maxParts?: number; minFill?: number } = {}): FitResult {
  const maxParts = opts.maxParts ?? 4;
  const pts = poly.length > 1 && poly[0].x === poly[poly.length - 1].x && poly[0].z === poly[poly.length - 1].z ? poly.slice(0, -1) : poly;
  const area = polygonArea(pts);
  const f = minAreaFrame(pts);
  const boxArea = (f.u1 - f.u0) * (f.v1 - f.v0) || 1;
  const fill = Math.min(1, area / boxArea);
  const single = frameBox(f.theta, f.u0, f.u1, f.v0, f.v1);
  if (pts.length < 5 || fill >= (opts.minFill ?? 0.8) || area < 250 || maxParts <= 1) return { parts: [single], fill, area };

  const c = Math.cos(f.theta);
  const s = Math.sin(f.theta);
  const local = pts.map((p) => ({ u: toU(p, c, s), v: toV(p, c, s) }));
  const W = f.u1 - f.u0;
  const D = f.v1 - f.v0;
  const cell = Math.min(2.5, Math.max(0.75, Math.min(W, D) / 24));
  const cols = Math.max(1, Math.ceil(W / cell));
  const rows = Math.max(1, Math.ceil(D / cell));
  const inside: boolean[][] = [];
  let total = 0;
  for (let r = 0; r < rows; r++) {
    inside.push([]);
    for (let k = 0; k < cols; k++) {
      const ok = pip(f.u0 + (k + 0.5) * cell, f.v0 + (r + 0.5) * cell, local);
      inside[r].push(ok);
      if (ok) total++;
    }
  }
  if (!total) return { parts: [single], fill, area };
  const free = inside.map((row) => row.slice());
  const parts: FitBox[] = [];
  let covered = 0;
  const minCells = Math.max(30 / (cell * cell), total * 0.06);
  while (parts.length < maxParts) {
    const r = largestRect(free);
    if (!r || r.area < minCells) break;
    for (let i = r.r0; i <= r.r1; i++) for (let k = r.c0; k <= r.c1; k++) free[i][k] = false;
    covered += r.area;
    parts.push(frameBox(f.theta, f.u0 + r.c0 * cell, f.u0 + (r.c1 + 1) * cell, f.v0 + r.r0 * cell, f.v0 + (r.r1 + 1) * cell));
    if (covered / total >= 0.9) break;
  }
  return parts.length ? { parts, fill, area } : { parts: [single], fill, area };
}
