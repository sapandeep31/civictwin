/**
 * Gemini vision layout: schema, prompt building and OSM merge for the
 * "satellite → 3D twin" import. Pure functions (no network) so they can be
 * unit-tested; the route in /api/ai/vision-layout does the Gemini call.
 *
 * Coordinate exchange with the model uses a normalized image grid u,v ∈ [0,1000]
 * (u → east, v → south, origin top-left = north-west corner of the bbox). Local
 * meters: x = (u/1000 − 0.5)·W, z = (v/1000 − 0.5)·D for world bounds W×D.
 */

import { z } from "zod";
import type { Building, BuildingCategory, Facility, Road, SiteLayers, Vec2, World } from "../world/types";
import { orientedBox, polygonArea } from "./footprint";

const num = z.coerce.number().refine(Number.isFinite);
const uv = z.tuple([num, num]);
const box = z.object({ u: num, v: num, widthM: num.optional(), depthM: num.optional(), rotationDeg: num.optional() });

/**
 * Array that keeps every valid item and drops malformed ones (and caps the
 * length) — one bad or truncated entry from the model must not discard the rest.
 */
function lenient<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((xs) =>
      xs
        .flatMap((x) => {
          const r = item.safeParse(x);
          return r.success ? [r.data as z.infer<T>] : [];
        })
        .slice(0, max)
    );
}

export const VisionLayoutSchema = z.object({
  societyType: z.string().max(60).catch("other"),
  description: z.string().max(800).catch(""),
  boundary: lenient(uv, 80),
  gates: lenient(z.object({ u: num, v: num, kind: z.enum(["main", "service", "pedestrian"]).catch("main"), name: z.string().max(60).optional().catch(undefined) }), 12),
  buildings: lenient(
    box.extend({
      /** 4 roof corners in u,v (preferred — models place points far better than they estimate meters) */
      corners: lenient(uv, 8)
        .optional()
        .transform((c) => (c && c.length >= 3 ? c : undefined)),
      u: num.optional(),
      v: num.optional(),
      floors: num.optional(),
      category: z.enum(["residential", "commercial", "community", "mixed", "other"]).catch("residential"),
      name: z.string().max(60).optional().catch(undefined),
    }).refine((b) => !!b.corners || (b.u !== undefined && b.v !== undefined), "building needs corners or a centre"),
    200
  ),
  roads: lenient(z.object({ points: lenient(uv, 40).refine((p) => p.length >= 2), kind: z.enum(["road", "path"]).catch("road") }), 60),
  openAreas: lenient(box.extend({ name: z.string().max(60).optional().catch(undefined) }), 30),
  parking: lenient(box, 30),
  guardBooths: lenient(z.object({ u: num, v: num, note: z.string().max(140).optional().catch(undefined) }), 12),
  darkZones: lenient(box.extend({ reason: z.string().max(160).optional().catch(undefined) }), 20),
});

export type VisionLayout = z.infer<typeof VisionLayoutSchema>;

export const VISION_SYSTEM = `You are an urban-planning vision analyst helping a Resident Welfare Association (RWA) build a security digital twin of their residential society from a top-down satellite image. Be precise about positions. Only report features you can actually see. Never identify individuals. Output JSON only.`;

export function buildVisionPrompt(args: {
  widthM: number;
  depthM: number;
  placeName?: string;
  world?: World | null;
  /** A street-map render of the same bbox is attached as the second image. */
  hasStreetMap?: boolean;
  /** User-drawn selection outline in the u,v grid (rotated rectangle or polygon). */
  selection?: [number, number][] | null;
}): string {
  const { widthM: W, depthM: D } = args;
  const toU = (x: number) => Math.round((x / W + 0.5) * 1000);
  const toV = (zz: number) => Math.round((zz / D + 0.5) * 1000);
  const w = args.world;
  const osmB = (w?.buildings ?? []).slice(0, 120).map((b) => `[${toU(b.x)},${toV(b.z)} ${Math.round(b.width)}x${Math.round(b.depth)}m${b.floors ? ` ${b.floors}fl` : ""}]`);
  const osmR = (w?.roads ?? []).slice(0, 60).map((r) => `${r.category}${r.name ? ` "${r.name}"` : ""}: ${r.points.filter((_, i, a) => i === 0 || i === a.length - 1 || i % 3 === 0).map((p) => `${toU(p.x)},${toV(p.z)}`).join(" ")}`);
  const osmP = (w?.facilities ?? []).filter((f) => f.type === "park").slice(0, 20).map((f) => `${f.name ?? "park"} @${toU(f.x)},${toV(f.z)}`);
  const sel = args.selection && args.selection.length >= 3 ? args.selection : null;
  const imagesNote = args.hasStreetMap
    ? `You get TWO images of exactly the same area, north up, pixel-aligned (same u,v grid):
 IMAGE 1 = satellite photo — the source of truth for what physically exists: compound walls, gates, guard booths, building footprints, tree cover, parking, unlit/secluded spots.
 IMAGE 2 = street map render — use it to NAME roads and gates (e.g. "Gate on 5th Main Rd"), to tell public roads from internal driveways, and to locate landmarks. Its building/road shapes are approximate; never add a building that is only on the map and not visible in the satellite photo.`
    : `The image is a satellite photo (north up).`;
  const selNote = sel
    ? `\nSELECTION: the user outlined the society with this polygon (u,v): ${sel.map(([u, v]) => `${u},${v}`).join(" ")}. Analyse ONLY what lies inside it (gates/walls may sit on its edge); ignore everything outside. The compound boundary usually follows this outline closely.\n`
    : "";
  return `${imagesNote}
Place: ${args.placeName ? `"${args.placeName}"` : "a residential area in India"}. The area covers ${Math.round(W)} m (east-west) × ${Math.round(D)} m (north-south), ≈${(W / 1000).toFixed(3)} m per grid unit horizontally.

COORDINATES: use a normalized grid u,v in 0..1000 — u = left→right (west→east), v = top→bottom (north→south). Sizes (widthM, depthM) are in METERS; rotationDeg is the clockwise rotation of the footprint's long axis from east.
${selNote}
ALREADY MAPPED in OpenStreetMap (do NOT repeat these; add only what OSM is missing):
Buildings (${w?.buildings.length ?? 0}): ${osmB.join(" ") || "none"}
Roads (${w?.roads.length ?? 0}):
${osmR.join("\n") || "none"}
Parks: ${osmP.join("; ") || "none"}

TASK — analyse the society / gated community that occupies most of the image and return JSON:
{
 "societyType": one of "gated_highrise" | "gated_lowrise" | "plotted_colony" | "villa_enclave" | "mixed_street" | "commercial" | "other",
 "description": 2-3 sentences: layout, density, approximate tower/house count, how it is entered, notable security-relevant traits (perimeter, open edges, vegetation),
 "boundary": [[u,v],...] polyline of the compound wall / society perimeter (clockwise, 4-40 points; [] if not a walled compound),
 "gates": [{"u","v","kind":"main"|"service"|"pedestrian","name"?}] — entry points on the boundary where internal roads meet outside roads${args.hasStreetMap ? " (name them after the outside road from IMAGE 2 when legible)" : ""},
 "buildings": [{"corners":[[u,v],[u,v],[u,v],[u,v]],"floors","category"}] — buildings visible but NOT in the OSM list above. "corners" = the 4 corners of the building's roof outline in order (for an L/U-shaped block, list each rectangular wing as its own building). Trace each building separately, never one box around several. Estimate floors from shadow length/roof type: towers 10-30, apartments 4-8, houses 1-3,
 "roads": [{"points":[[u,v],...],"kind":"road"|"path"}] — internal roads/driveways/footpaths missing from OSM,
 "openAreas": [{"u","v","widthM","depthM","name"?}] — parks, lawns, playgrounds, clubhouse grounds,
 "parking": [{"u","v","widthM","depthM","rotationDeg"}] — surface parking lots,
 "guardBooths": [{"u","v","note"}] — likely or recommended guard booth spots (usually beside gates),
 "darkZones": [{"u","v","widthM","depthM","reason"}] — likely dark or secluded zones at night (behind towers, along back walls, dense tree cover, service lanes, empty plots).
Keep lists concise (max ~40 buildings). Return JSON only.`;
}

export interface MergeResult {
  world: World;
  /** `rejected`: model buildings dropped as implausible or duplicating mapped ones */
  added: { buildings: number; roads: number; parks: number; walls: number; gates: number; areas: number; booths: number; rejected: number };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function distToSeg(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

type Box = Pick<Building, "x" | "z" | "width" | "depth" | "rotation">;

function insideBox(b: Box, p: Vec2, shrink = 0) {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const dx = p.x - b.x;
  const dz = p.z - b.z;
  return Math.abs(dx * c - dz * s) <= b.width / 2 - shrink && Math.abs(dx * s + dz * c) <= b.depth / 2 - shrink;
}

/** Sample points across a rotated box (local grid → world). */
function boxSamples(b: Box, n = 8): Vec2[] {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const lx = ((i + 0.5) / n - 0.5) * b.width;
      const lz = ((j + 0.5) / n - 0.5) * b.depth;
      out.push({ x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c });
    }
  return out;
}

/** Rotation-aware: does `c` overlap any listed building by > 25 % of the smaller footprint? */
function overlapsBuilding(c: Box, list: Building[]) {
  const cs = boxSamples(c);
  return list.some((b) => {
    if (Math.hypot(c.x - b.x, c.z - b.z) > (Math.hypot(c.width, c.depth) + Math.hypot(b.width, b.depth)) / 2) return false;
    const inB = cs.filter((p) => insideBox(b, p)).length / cs.length;
    const bs = boxSamples(b);
    const inC = bs.filter((p) => insideBox(c, p)).length / bs.length;
    return Math.max(inB, inC) > 0.25;
  });
}

/** Metres of mapped (non-path) road centreline running through the box interior. */
function roadLengthInside(c: Box, roads: Road[]) {
  let len = 0;
  for (const r of roads) {
    if (r.category === "path") continue;
    for (let k = 1; k < r.points.length; k++) {
      const a = r.points[k - 1];
      const b = r.points[k];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      for (let t = 1; t < L; t += 2) if (insideBox(c, { x: a.x + ((b.x - a.x) * t) / L, z: a.z + ((b.z - a.z) * t) / L }, 1)) len += 2;
    }
  }
  return len;
}

/** Merge a validated Gemini layout into an (OSM) world. OSM geometry wins; Gemini fills gaps. */
export function mergeVisionLayout(base: World, layout: VisionLayout): MergeResult {
  const W = base.bounds.width;
  const D = base.bounds.depth;
  const hx = W / 2 - 1;
  const hz = D / 2 - 1;
  const pt = (u: number, v: number): Vec2 => ({ x: clamp((u / 1000 - 0.5) * W, -hx, hx), z: clamp((v / 1000 - 0.5) * D, -hz, hz) });
  const size = (m: number | undefined, def: number, max: number) => clamp(Number.isFinite(m) && m! > 0 ? m! : def, 2, max);
  // model gives clockwise-from-east (screen); world rotation is three.js Y (counter-clockwise from above)
  const rot = (deg: number | undefined) => (-(Number.isFinite(deg) ? deg! : 0) * Math.PI) / 180;

  const world: World = {
    ...base,
    roads: [...base.roads],
    buildings: [...base.buildings],
    facilities: [...base.facilities],
    site: base.site ? { ...base.site } : { walls: [], gates: [], areas: [], booths: [] },
  };
  const site = world.site as SiteLayers;
  const added = { buildings: 0, roads: 0, parks: 0, walls: 0, gates: 0, areas: 0, booths: 0, rejected: 0 };

  let rejected = 0;
  layout.buildings.forEach((b, i) => {
    let fit: Box | null = null;
    if (b.corners && b.corners.length >= 3) {
      const o = orientedBox(b.corners.map(([u, v]) => pt(u, v)));
      fit = { ...o, width: clamp(o.width, 2, 150), depth: clamp(o.depth, 2, 150) };
    } else if (b.u !== undefined && b.v !== undefined) {
      // legacy centre + size: the long side follows rotationDeg whichever field the model put it in
      const c = pt(b.u, b.v);
      const a = size(b.widthM, 14, 120);
      const d = size(b.depthM, 14, 120);
      fit = { ...c, width: Math.max(a, d), depth: Math.min(a, d), rotation: rot(b.rotationDeg) };
    }
    if (!fit) return;
    // implausible boxes: sliver, giant slab, or one box swallowing a road
    const plausible =
      fit.width * fit.depth >= 12 &&
      fit.width / Math.max(1, fit.depth) <= 9 &&
      fit.width * fit.depth <= 9000 &&
      roadLengthInside(fit, base.roads) < 8;
    // model placement is noisy (~30 % precision in our benchmark vs OSM): only fill true gaps —
    // no mapped building (OSM / ML footprints) within ~12 m of this one (0.7·half-diagonal ≈ box extent)
    const half = (b: Box) => 0.7 * Math.hypot(b.width, b.depth) / 2;
    const f = fit;
    const inGap = !base.buildings.some((o) => Math.hypot(o.x - f.x, o.z - f.z) < half(f) + half(o) + 12);
    if (!plausible || !inGap || overlapsBuilding(fit, world.buildings)) {
      rejected += 1;
      return;
    }
    const { width, depth } = fit;
    const floors = Math.round(clamp(b.floors ?? 3, 1, 45));
    world.buildings.push({
      id: `bd_ai_${i}`,
      name: b.name,
      x: fit.x,
      z: fit.z,
      width,
      depth,
      rotation: fit.rotation,
      height: floors * 3,
      floors,
      category: b.category as BuildingCategory,
      occupancy: Math.max(2, Math.round(((width * depth) / 55) * Math.min(floors, 20) * 0.6) * 2),
      inferred: true,
    });
    added.buildings += 1;
  });

  layout.roads.forEach((r, i) => {
    const points = r.points.map(([u, v]) => pt(u, v));
    const mid = points[Math.floor(points.length / 2)];
    const covered = base.roads.some((o) => o.points.some((p, k) => k > 0 && distToSeg(mid, o.points[k - 1], p) < 6));
    if (covered) return;
    world.roads.push({ id: `rd_ai_${i}`, points, width: r.kind === "path" ? 2 : 5, category: r.kind, pedestrian: true, inferred: true } satisfies Road);
    added.roads += 1;
  });

  layout.openAreas.forEach((a, i) => {
    const c = pt(a.u, a.v);
    if (base.facilities.some((f) => f.type === "park" && Math.hypot(f.x - c.x, f.z - c.z) < 20)) return;
    const radius = clamp(Math.max(a.widthM ?? 20, a.depthM ?? 20) / 2, 5, 90);
    world.facilities.push({ id: `fc_ai_${i}`, name: a.name ?? "Open area", type: "park", x: c.x, z: c.z, radius, inferred: true } satisfies Facility);
    added.parks += 1;
  });

  added.rejected = rejected;
  // a "boundary" covering a sliver of the image is a misread, not the compound wall
  const boundaryPts = layout.boundary.map(([u, v]) => pt(u, v));
  if (layout.boundary.length >= 3 && polygonArea(boundaryPts) >= 0.04 * W * D) {
    site.walls = [...site.walls, { id: "wl_ai_boundary", points: boundaryPts, closed: true, height: 2.4, inferred: true }];
    added.walls += 1;
  }
  site.gates = [
    ...site.gates,
    ...layout.gates.map((g, i) => ({ id: `gt_ai_${i}`, name: g.name ?? (g.kind === "main" ? "Main gate" : g.kind === "service" ? "Service gate" : "Pedestrian gate"), kind: g.kind, ...pt(g.u, g.v), inferred: true })),
  ];
  added.gates = layout.gates.length;
  const areas = [
    ...layout.parking.map((a, i) => ({ id: `ar_ai_p${i}`, kind: "parking" as const, name: "Parking", ...pt(a.u, a.v), width: size(a.widthM, 20, 150), depth: size(a.depthM, 12, 150), rotation: rot(a.rotationDeg), inferred: true })),
    ...layout.darkZones.map((a, i) => ({ id: `ar_ai_d${i}`, kind: "dark" as const, name: "Likely dark zone", note: a.reason, ...pt(a.u, a.v), width: size(a.widthM, 25, 150), depth: size(a.depthM, 25, 150), rotation: rot(a.rotationDeg), inferred: true })),
  ];
  site.areas = [...site.areas, ...areas];
  added.areas = areas.length;
  site.booths = [...site.booths, ...layout.guardBooths.map((b, i) => ({ id: `bt_ai_${i}`, note: b.note, ...pt(b.u, b.v), inferred: true }))];
  added.booths = layout.guardBooths.length;

  return { world, added };
}
