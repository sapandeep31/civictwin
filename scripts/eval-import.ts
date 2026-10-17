/**
 * "Build society from map" evaluation harness.
 *
 *   bun scripts/eval-import.ts fetch   — geocode + OSM + satellite + street map + Gemini (real calls), cached per society
 *   bun scripts/eval-import.ts render  — convert + merge + prepare from the cache, print quality metrics, draw overlays
 *
 * Output: $EVAL_DIR (default ./.eval-import)/<slug>/{bundle.json,sat.jpg,street.jpg,layout.json,overlay.png}
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { geocode, fetchOsmFeatures, searchPlaces, type OsmFeatureBundle } from "@/lib/geo/osm";
import { locateCompound } from "@/lib/geo/compound";
import { dedupeAgainst, fetchOvertureBuildings } from "@/lib/geo/overture";
import { clipWorldToPolygon, ringBbox, ringToLocal, ringToUV } from "@/lib/geo/selection";
import { convertOsmToWorld } from "@/lib/geo/convert";
import { captureSatellite, captureStreetMap, downscaleJpeg } from "@/lib/geo/satellite";
import { buildVisionPrompt, mergeVisionLayout, VISION_SYSTEM, VisionLayoutSchema } from "@/lib/geo/visionLayout";
import { callGeminiJson, type GeminiPart } from "@/lib/ai/gemini";
import { prepareImportedWorld } from "@/lib/geo/siteSetup";
import type { Building, World } from "@/lib/world/types";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const OUT = process.env.EVAL_DIR || path.join(process.cwd(), process.env.FLOW === "v2" ? ".eval-import-v2" : ".eval-import");

export const SOCIETIES: { slug: string; q: string }[] = [
  { slug: "prestige-shantiniketan", q: "Prestige Shantiniketan, Whitefield, Bengaluru" },
  { slug: "dlf-the-crest", q: "DLF The Crest, Gurugram" },
  { slug: "adarsh-palm-retreat", q: "Adarsh Palm Retreat, Bengaluru" },
  { slug: "raheja-vihar", q: "Raheja Vihar, Powai, Mumbai" },
  { slug: "amrapali-sapphire", q: "Amrapali Sapphire, Noida" },
  { slug: "brigade-metropolis", q: "Brigade Metropolis, Bengaluru" },
  { slug: "sector-15a-noida", q: "Sector 15A, Noida" },
  { slug: "my-home-jewel", q: "My Home Jewel, Madinaguda, Hyderabad" },
  { slug: "lodha-splendora", q: "Lodha Splendora, Thane" },
  { slug: "rohan-jharoka", q: "Rohan Jharoka, Yemalur, Bengaluru" },
];

type Bbox = [number, number, number, number];
const spanM = (b: Bbox) => ({ w: (b[3] - b[2]) * Math.cos((((b[0] + b[1]) / 2) * Math.PI) / 180) * 111320, d: (b[1] - b[0]) * 111320 });
/** Same as ImportDialog.societyBox. */
function societyBox(r: { lat: number; lon: number; boundingbox: Bbox }): Bbox {
  const [s, n, w, e] = r.boundingbox;
  const lat = (s + n) / 2 || r.lat;
  const lon = (w + e) / 2 || r.lon;
  const sp = spanM([s, n, w, e]);
  const half = (m: number) => Math.max(200, Math.min(600, m * 1.15)) / 2;
  const hl = half(sp.d) / 111320;
  const hw = half(sp.w) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat - hl, lat + hl, lon - hw, lon + hw];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = (slug: string) => path.join(OUT, slug);
const has = (slug: string, f: string) => fs.existsSync(path.join(dir(slug), f));

type Meta = { bbox: Bbox; displayName: string; W: number; D: number; ring?: [number, number][]; compound?: string };
const V2 = process.env.FLOW === "v2";

async function fetchOne(s: { slug: string; q: string }) {
  fs.mkdirSync(dir(s.slug), { recursive: true });
  const metaP = path.join(dir(s.slug), "meta.json");
  let meta: Meta;
  if (fs.existsSync(metaP)) meta = JSON.parse(fs.readFileSync(metaP, "utf8"));
  else if (V2) {
    // new flow: Places + Nominatim search → compound outline → polygon selection
    const res = await searchPlaces(s.q);
    if (!res.length) throw new Error("search: no result");
    const r = res[0];
    const t0 = Date.now();
    const c = await locateCompound({ lat: r.lat, lon: r.lon, query: s.q, outline: r.outline ?? null });
    const compound = c ? `${c.source} ${c.areaHa} ha${c.name ? ` "${c.name}"` : ""}${c.note ? ` (${c.note})` : ""} ${Date.now() - t0} ms` : "none";
    const bbox = c ? padBbox(ringBbox(c.ring)) : societyBox(r);
    const sp = spanM(bbox);
    meta = { bbox, displayName: r.displayName, W: sp.w, D: sp.d, ring: c?.ring, compound };
    fs.writeFileSync(metaP, JSON.stringify(meta, null, 1));
    await sleep(1100);
  } else {
    const res = await geocode(s.q);
    if (!res.length) throw new Error("geocode: no result");
    const bbox = societyBox(res[0]);
    const sp = spanM(bbox);
    meta = { bbox, displayName: res[0].displayName, W: sp.w, D: sp.d };
    fs.writeFileSync(metaP, JSON.stringify(meta, null, 1));
    await sleep(1100); // Nominatim: 1 req/s
  }
  const [so, no, we, ea] = meta.bbox;
  if (!has(s.slug, "bundle.json")) {
    const b = await fetchOsmFeatures(so, no, we, ea);
    fs.writeFileSync(path.join(dir(s.slug), "bundle.json"), JSON.stringify(b));
  }
  if (V2 && !has(s.slug, "overture.json")) {
    const t0 = Date.now();
    const ov = await fetchOvertureBuildings(so, no, we, ea).catch((e) => (console.warn(`  overture: ${(e as Error).message}`), []));
    fs.writeFileSync(path.join(dir(s.slug), "overture.json"), JSON.stringify(ov));
    console.log(`  ${s.slug}: overture ${ov.length} footprints in ${Date.now() - t0} ms`);
  }
  if (!has(s.slug, "sat.jpg")) {
    const cap = await captureSatellite(so, no, we, ea);
    fs.writeFileSync(path.join(dir(s.slug), "sat.jpg"), cap.jpeg);
    const st = await captureStreetMap(so, no, we, ea, cap.width, cap.height).catch(() => null);
    if (st) fs.writeFileSync(path.join(dir(s.slug), "street.jpg"), st.jpeg);
  }
  const variant = process.env.VARIANT || "layout";
  if (!has(s.slug, `${variant}.json`)) {
    const t0 = Date.now();
    const raw = await visionCall(s.slug, meta);
    fs.writeFileSync(path.join(dir(s.slug), `${variant}.json`), JSON.stringify({ ...raw, ms: Date.now() - t0 }, null, 1));
  }
  return meta;
}

/** OSM bundle + (v2) deduped Overture footprints — same merge as /api/geo/import. */
function loadBundle(slug: string): OsmFeatureBundle {
  const b: OsmFeatureBundle = JSON.parse(fs.readFileSync(path.join(dir(slug), "bundle.json"), "utf8"));
  if (process.env.OVT === "0" || !has(slug, "overture.json")) return b;
  const extra = dedupeAgainst(b.buildings, JSON.parse(fs.readFileSync(path.join(dir(slug), "overture.json"), "utf8")));
  return { ...b, buildings: [...b.buildings, ...extra.map((x) => ({ id: x.id, polygon: x.polygon, height: x.height, levels: x.levels, source: x.source }))] };
}

/** Ensure each side ≥ 100 m (ImportDialog's minimum) around a compound bbox. */
function padBbox(b: Bbox): Bbox {
  const sp = spanM(b);
  const lat = (b[0] + b[1]) / 2;
  const dLat = Math.max(0, (100 - sp.d) / 2) / 111320;
  const dLon = Math.max(0, (100 - sp.w) / 2) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [b[0] - dLat, b[1] + dLat, b[2] - dLon, b[3] + dLon];
}

/** Mirrors /api/ai/vision-layout (prompt + model chain), but returns the raw layout. */
async function visionCall(slug: string, meta: Meta) {
  const bundle = loadBundle(slug);
  const [so, no, we, ea] = (JSON.parse(fs.readFileSync(path.join(dir(slug), "meta.json"), "utf8")) as { bbox: Bbox }).bbox;
  const { world } = convertOsmToWorld(bundle, { origin: { lat: (so + no) / 2, lon: (we + ea) / 2 }, bounds: { width: meta.W, depth: meta.D } });
  const sat = fs.readFileSync(path.join(dir(slug), "sat.jpg"));
  const street = has(slug, "street.jpg") ? fs.readFileSync(path.join(dir(slug), "street.jpg")) : null;
  const small = (await downscaleJpeg(sat, 768)).toString("base64");
  const streetSmall = street ? (await downscaleJpeg(street, 768)).toString("base64") : null;
  const selection = meta.ring ? ringToUV(meta.ring, meta.bbox) : null;
  const prompt = buildVisionPrompt({ widthM: meta.W, depthM: meta.D, placeName: meta.displayName.split(",")[0], world, hasStreetMap: !!streetSmall, selection });
  const parts: GeminiPart[] = [{ text: "IMAGE 1 (satellite):" }, { inlineData: { mimeType: "image/jpeg", data: small } }];
  if (streetSmall) parts.push({ text: "IMAGE 2 (street map, same area):" }, { inlineData: { mimeType: "image/jpeg", data: streetSmall } });
  parts.push({ text: prompt });
  const attempt = (models: string[], thinkingLevel?: "low") =>
    callGeminiJson<unknown>({ system: VISION_SYSTEM, parts, json: true, temperature: 0.2, maxOutputTokens: 8192, timeoutMs: 60000, models, thinkingLevel });
  try {
    return await attempt(["gemini-3.8-flash"], "low");
  } catch (e) {
    console.warn(`  ${slug}: 3.8-flash failed (${(e as Error).message.slice(0, 120)})`);
    try {
      return await attempt(["gemini-3.5-flash"], "low");
    } catch {
      return await attempt(["gemini-3-flash-preview", "gemini-3.1-flash-lite"]);
    }
  }
}

/* ------------------------------------------------------------------ */
/* geometry helpers for metrics                                        */
/* ------------------------------------------------------------------ */

export function corners(b: Pick<Building, "x" | "z" | "width" | "depth" | "rotation">) {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([i, j]) => {
    const lx = (i * b.width) / 2;
    const lz = (j * b.depth) / 2;
    return { x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c };
  });
}
function inside(b: Building, p: { x: number; z: number }) {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const dx = p.x - b.x;
  const dz = p.z - b.z;
  return Math.abs(dx * c - dz * s) <= b.width / 2 && Math.abs(dx * s + dz * c) <= b.depth / 2;
}
/** fraction of a's footprint covered by b (grid sampling) */
function coverFrac(a: Building, b: Building) {
  if (Math.hypot(a.x - b.x, a.z - b.z) > (Math.hypot(a.width, a.depth) + Math.hypot(b.width, b.depth)) / 2) return 0;
  let n = 0;
  let hit = 0;
  for (let i = 0.05; i < 1; i += 0.1)
    for (let j = 0.05; j < 1; j += 0.1) {
      const lx = (i - 0.5) * a.width;
      const lz = (j - 0.5) * a.depth;
      const c = Math.cos(a.rotation);
      const s = Math.sin(a.rotation);
      n++;
      if (inside(b, { x: a.x + lx * c + lz * s, z: a.z - lx * s + lz * c })) hit++;
    }
  return hit / n;
}
function pip(p: { x: number; z: number }, poly: { x: number; z: number }[]) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) ins = !ins;
  }
  return ins;
}

export function metrics(world: World) {
  const B = world.buildings;
  const ai = B.filter((b) => b.id.startsWith("bd_ai"));
  const big = B.filter((b) => Math.max(b.width, b.depth) > 75 || b.width * b.depth > 3500);
  let overlaps = 0;
  for (let i = 0; i < B.length; i++) for (let k = i + 1; k < B.length; k++) if (Math.max(coverFrac(B[i], B[k]), coverFrac(B[k], B[i])) > 0.2) overlaps++;
  const roads = world.roads.filter((r) => r.category === "road" && !r.inferred);
  let onRoad = 0;
  for (const b of B) {
    let hit = false;
    for (const r of roads) {
      for (let k = 1; k < r.points.length && !hit; k++) {
        const a = r.points[k - 1];
        const c = r.points[k];
        const L = Math.hypot(c.x - a.x, c.z - a.z);
        for (let t = 0; t <= L && !hit; t += 2) if (inside({ ...b, width: b.width - 2, depth: b.depth - 2 }, { x: a.x + ((c.x - a.x) * t) / L, z: a.z + ((c.z - a.z) * t) / L })) hit = true;
      }
      if (hit) break;
    }
    if (hit) onRoad++;
  }
  const wall = world.site?.walls.find((w) => w.closed && w.points.length >= 3);
  const aiOutside = wall ? ai.filter((b) => !pip(b, wall.points)).length : 0;
  const connectors = world.roads.filter((r) => /^rd_(link|snap|ent|fac)_/.test(r.id));
  const connLen = connectors.reduce((s, r) => s + Math.hypot(r.points[1].x - r.points[0].x, r.points[1].z - r.points[0].z), 0);
  return {
    buildings: B.length,
    ovt: B.filter((b) => b.id.startsWith("bd_ovt_")).length,
    ai: ai.length,
    big: big.length,
    overlaps,
    onRoad,
    aiOutside,
    roads: world.roads.length - connectors.length,
    connectors: connectors.length,
    connLenM: Math.round(connLen),
    walls: world.site?.walls.length ?? 0,
    gates: world.site?.gates.length ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* overlay renderer                                                    */
/* ------------------------------------------------------------------ */

async function overlay(slug: string, world: World, file: string, title: string, sel?: { x: number; z: number }[]) {
  const sat = fs.readFileSync(path.join(dir(slug), "sat.jpg"));
  const { width: IW, height: IH } = await sharp(sat).metadata();
  const W = world.bounds.width;
  const D = world.bounds.depth;
  const P = (p: { x: number; z: number }) => `${(((p.x / W + 0.5) * IW) | 0)},${(((p.z / D + 0.5) * IH) | 0)}`;
  const el: string[] = [];
  // colours: cyan = OSM, green = Overture ML footprint, orange = Gemini
  for (const a of world.site?.areas ?? []) {
    const pts = corners({ x: a.x, z: a.z, width: a.width, depth: a.depth, rotation: a.rotation }).map(P).join(" ");
    el.push(`<polygon points="${pts}" fill="${a.kind === "dark" ? "#7c3aed" : "#64748b"}" fill-opacity="0.25" stroke="none"/>`);
  }
  for (const r of world.roads) {
    const conn = /^rd_(link|snap|ent|fac)_/.test(r.id);
    el.push(`<polyline points="${r.points.map(P).join(" ")}" fill="none" stroke="${conn ? "#ff00ff" : r.inferred ? "#fde047" : "#ffffff"}" stroke-width="${conn ? 1.5 : r.category === "road" ? 3 : 1.5}" ${conn ? 'stroke-dasharray="4 3"' : ""} opacity="0.85"/>`);
  }
  for (const w of world.site?.walls ?? []) el.push(`<polyline points="${[...w.points, ...(w.closed ? [w.points[0]] : [])].map(P).join(" ")}" fill="none" stroke="#ef4444" stroke-width="3"/>`);
  for (const b of world.buildings) {
    const col = b.id.startsWith("bd_ai") ? "#f97316" : b.id.startsWith("bd_ovt_") ? "#a3e635" : "#22d3ee";
    el.push(`<polygon points="${corners(b).map(P).join(" ")}" fill="${col}" fill-opacity="0.35" stroke="${col}" stroke-width="1.5"/>`);
  }
  if (sel) el.push(`<polygon points="${sel.map(P).join(" ")}" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-dasharray="8 5"/>`);
  for (const g of world.site?.gates ?? []) el.push(`<circle cx="${P(g).split(",")[0]}" cy="${P(g).split(",")[1]}" r="6" fill="#facc15" stroke="#000"/>`);
  el.push(`<rect x="0" y="0" width="${IW}" height="26" fill="#000" opacity="0.6"/><text x="8" y="18" fill="#fff" font-size="15" font-family="sans-serif">${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${IW}" height="${IH}">${el.join("")}</svg>`);
  await sharp(sat).composite([{ input: svg }]).png().toFile(path.join(dir(slug), file));
}

/* ------------------------------------------------------------------ */

export function buildWorld(slug: string, variant = process.env.VARIANT || "layout") {
  const meta = JSON.parse(fs.readFileSync(path.join(dir(slug), "meta.json"), "utf8")) as Meta;
  const bundle = loadBundle(slug);
  const [so, no, we, ea] = meta.bbox;
  const osm = convertOsmToWorld(bundle, { origin: { lat: (so + no) / 2, lon: (we + ea) / 2 }, bounds: { width: meta.W, depth: meta.D } }).world;
  let world = osm;
  let model = "none";
  let ms = 0;
  if (has(slug, `${variant}.json`)) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir(slug), `${variant}.json`), "utf8"));
    model = raw.model;
    ms = raw.ms;
    world = mergeVisionLayout(osm, VisionLayoutSchema.parse(raw.data ?? {})).world;
  }
  if (meta.ring) world = clipWorldToPolygon(world, ringToLocal(meta.ring, meta.bbox, meta.W, meta.D)).world;
  const prepared = prepareImportedWorld(world, Math.round(Math.abs(so * 1e4 + we * 1e4))).world;
  return { osm, prepared, model, ms, meta };
}

const mode = process.argv[2] ?? "render";
const only = process.argv[3];
const list = SOCIETIES.filter((s) => !only || only.split(",").includes(s.slug));
if (mode === "fetch") {
  for (const s of list) {
    const t0 = Date.now();
    try {
      const m = await fetchOne(s);
      console.log(`✓ ${s.slug}  ${Math.round(m.W)}×${Math.round(m.D)} m  "${m.displayName.slice(0, 70)}"  ${Date.now() - t0} ms`);
    } catch (e) {
      console.log(`✗ ${s.slug}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
} else {
  const rows: Record<string, unknown>[] = [];
  for (const s of list) {
    if (!has(s.slug, "bundle.json") || !has(s.slug, "sat.jpg")) continue;
    const { prepared, model, ms, meta } = buildWorld(s.slug);
    const m = metrics(prepared);
    rows.push({ slug: s.slug, size: `${Math.round(meta.W)}x${Math.round(meta.D)}`, ...m, model: model.replace("gemini-", ""), s: Math.round(ms / 1000) });
    if (meta.compound) console.log(`  ${s.slug}: compound ${meta.compound}`);
    await overlay(
      s.slug,
      prepared,
      `overlay${process.env.TAG ? "-" + process.env.TAG : ""}.png`,
      `${s.slug} · ${m.buildings} bldg (${m.ai} AI) · big ${m.big} · overlap ${m.overlaps} · on-road ${m.onRoad}`,
      meta.ring ? ringToLocal(meta.ring, meta.bbox, meta.W, meta.D) : undefined
    );
  }
  console.table(rows);
}
