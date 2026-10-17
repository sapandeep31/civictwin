/**
 * Locate the actual society compound around a searched point, so the import
 * covers the society (and nothing else) instead of a guessed square.
 *
 * Sources, best first:
 *   1. the outline the geocoder already returned (Nominatim polygon);
 *   2. OSM areas that contain / touch the point (landuse=residential, named
 *      complexes) via Overpass `is_in`, scored by name match and plausible size;
 *   3. Gemini on a wider satellite view with the point marked.
 * Pure helpers are exported for tests; `locateCompound` does the network calls.
 */

import { z } from "zod";
import type { OverpassEl } from "./osm";

export type LL = [number, number]; // lat, lon

export interface CompoundResult {
  ring: LL[];
  source: "geocoder" | "osm" | "gemini";
  name?: string;
  areaHa: number;
  note?: string;
}

const M = 111320;
const kx = (lat: number) => M * Math.cos((lat * Math.PI) / 180);
const en = (p: LL, o: LL) => ({ e: (p[1] - o[1]) * kx(o[0]), n: (p[0] - o[0]) * M });

export function ringAreaHa(ring: LL[]): number {
  if (ring.length < 3) return 0;
  const o = ring[0];
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = en(ring[i], o);
    const q = en(ring[(i + 1) % ring.length], o);
    a += p.e * q.n - q.e * p.n;
  }
  return Math.abs(a) / 2 / 10000;
}

export function containsLL(ring: LL[], p: LL): boolean {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ya, xa] = ring[i];
    const [yb, xb] = ring[j];
    if (ya > p[0] !== yb > p[0] && p[1] < ((xb - xa) * (p[0] - ya)) / (yb - ya) + xa) ins = !ins;
  }
  return ins;
}

/** Distance (m) from p to the ring's edges. */
export function distToRingM(ring: LL[], p: LL): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = en(ring[i], p);
    const b = en(ring[(i + 1) % ring.length], p);
    const dx = b.e - a.e;
    const dy = b.n - a.n;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, (-a.e * dx - a.n * dy) / l2));
    best = Math.min(best, Math.hypot(a.e + t * dx, a.n + t * dy));
  }
  return best;
}

/** True when any two non-adjacent edges cross. */
export function selfIntersects(ring: LL[]): boolean {
  const o = ring[0];
  const P = ring.map((p) => en(p, o));
  const n = P.length;
  const cross = (a: { e: number; n: number }, b: { e: number; n: number }, c: { e: number; n: number }) => (b.e - a.e) * (c.n - a.n) - (b.n - a.n) * (c.e - a.e);
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = P[j];
      const d = P[(j + 1) % n];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    }
  }
  return false;
}

/** Douglas–Peucker in meters; drops the closing duplicate; caps the vertex count. */
export function simplifyRing(ring: LL[], tolM = 3, maxPts = 40): LL[] {
  const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  if (open.length <= 4) return open;
  const o = open[0];
  // split the ring at its farthest vertex from the start so both halves are simplified as open chains
  const P = open.map((p) => en(p, o));
  let far = 1;
  for (let i = 1; i < P.length; i++) if (Math.hypot(P[i].e, P[i].n) > Math.hypot(P[far].e, P[far].n)) far = i;
  const chain = [...P, P[0]];
  const run = (tol: number) => {
    const keep = chain.map((_, i) => i === 0 || i === far || i === chain.length - 1);
    const dp = (a: number, b: number) => {
      const A = chain[a];
      const B = chain[b];
      const dx = B.e - A.e;
      const dy = B.n - A.n;
      const l = Math.hypot(dx, dy) || 1;
      let idx = -1;
      let dmax = 0;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * (chain[i].e - A.e) - dx * (chain[i].n - A.n)) / l;
        if (d > dmax) ((dmax = d), (idx = i));
      }
      if (idx >= 0 && dmax > tol) {
        keep[idx] = true;
        dp(a, idx);
        dp(idx, b);
      }
    };
    dp(0, far);
    dp(far, chain.length - 1);
    return open.filter((_, i) => keep[i]);
  };
  let tol = tolM;
  for (let pass = 0; pass < 10; pass++) {
    const out = run(tol);
    if (out.length <= maxPts) return out;
    tol *= 1.6;
  }
  return run(tol);
}

/** Grow a ring outward by ~m meters (vertex offset along the averaged edge normals). */
export function bufferRing(ring: LL[], m: number): LL[] {
  const o = ring[0];
  const P = ring.map((p) => en(p, o));
  // orientation: positive shoelace = counter-clockwise in (e, n)
  let s = 0;
  for (let i = 0; i < P.length; i++) s += P[i].e * P[(i + 1) % P.length].n - P[(i + 1) % P.length].e * P[i].n;
  const sign = s > 0 ? 1 : -1;
  return P.map((p, i) => {
    const a = P[(i - 1 + P.length) % P.length];
    const b = P[(i + 1) % P.length];
    const n1 = { e: (p.n - a.n) * sign, n: -(p.e - a.e) * sign };
    const n2 = { e: (b.n - p.n) * sign, n: -(b.e - p.e) * sign };
    const l1 = Math.hypot(n1.e, n1.n) || 1;
    const l2 = Math.hypot(n2.e, n2.n) || 1;
    const nx = n1.e / l1 + n2.e / l2;
    const ny = n1.n / l1 + n2.n / l2;
    const l = Math.hypot(nx, ny) || 1;
    // |n1 + n2| = 2·cos(half-angle) → miter = 1/cos; capped so sharp corners don't spike
    const miter = Math.min(2, 2 / Math.max(1e-6, l));
    const e = p.e + (nx / l) * m * miter;
    const nn = p.n + (ny / l) * m * miter;
    return [o[0] + nn / M, o[1] + e / kx(o[0])] as LL;
  });
}

const STOP = new Set(["the", "a", "of", "and", "society", "apartments", "apartment", "residency", "chs", "ltd", "phase", "block", "tower", "towers", "sector", "road", "rd", "india"]);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

/** 0..1 token overlap of the query's first comma part with a candidate name. */
export function nameScore(query: string, name?: string): number {
  if (!name) return 0;
  const q = new Set(tokens(query.split(",")[0]));
  const n = new Set(tokens(name));
  if (!q.size || !n.size) return 0;
  let hit = 0;
  for (const t of q) if (n.has(t)) hit++;
  return hit / Math.min(q.size, n.size);
}

function elRing(el: OverpassEl): LL[] | null {
  if (el.type === "way" && el.geometry && el.geometry.length >= 4) return el.geometry.map((g) => [g.lat, g.lon] as LL);
  if (el.type === "relation" && el.members) {
    // take the largest closed outer member (multipolygons of single compounds are usually one way)
    let best: LL[] | null = null;
    for (const m of el.members) {
      if (m.role !== "outer" || !m.geometry || m.geometry.length < 4) continue;
      const r = m.geometry.map((g) => [g.lat, g.lon] as LL);
      const closed = Math.abs(r[0][0] - r[r.length - 1][0]) + Math.abs(r[0][1] - r[r.length - 1][1]) < 1e-7;
      if (closed && (!best || ringAreaHa(r) > ringAreaHa(best))) best = r;
    }
    return best;
  }
  return null;
}

/** Score OSM area candidates around a point; returns the best plausible compound or null. Pure. */
export function pickCompound(els: OverpassEl[], at: LL, query: string): { ring: LL[]; name?: string; areaHa: number; score: number } | null {
  let best: { ring: LL[]; name?: string; areaHa: number; score: number } | null = null;
  for (const el of els) {
    const t = el.tags ?? {};
    if (t.boundary === "administrative" || t.admin_level) continue;
    const ring = elRing(el);
    if (!ring) continue;
    const a = ringAreaHa(ring);
    const isBuilding = !!t.building;
    if (a < (isBuilding ? 0.3 : 0.15) || a > 150) continue;
    const inside = containsLL(ring, at);
    const d = inside ? 0 : distToRingM(ring, at);
    if (!inside && d > 120) continue;
    let s = inside ? 2 : 1 - d / 120;
    if (t.name) s += 0.6;
    s += 4 * nameScore(query, t.name);
    if (t.landuse === "residential" || t.residential) s += 1;
    if (t.place === "neighbourhood") s += 0.2;
    if (isBuilding) s += 0.2;
    s -= 0.5 * Math.log10(Math.max(a, 0.5) / 8) ** 2; // most societies are ~1–40 ha
    if (!best || s > best.score) best = { ring, name: t.name, areaHa: a, score: s };
  }
  return best && best.score >= 1.5 ? best : null;
}

/* ------------------------------------------------------------------ */
/* network                                                             */
/* ------------------------------------------------------------------ */

const plausible = (ring: LL[], at: LL) => {
  const a = ringAreaHa(ring);
  return ring.length >= 3 && a >= 0.15 && a <= 150 && (containsLL(ring, at) || distToRingM(ring, at) < 150);
};

export function finishRing(ring: LL[]): LL[] {
  // a few meters of slack so the compound wall, gates and edge buildings stay inside
  return bufferRing(simplifyRing(ring, 2.5, 40), 10);
}

async function fromOverpass(at: LL, query: string): Promise<CompoundResult | null> {
  const { overpassQuery } = await import("./osm");
  const [la, lo] = at.map((v) => v.toFixed(6));
  const q = `[out:json][timeout:12];
is_in(${la},${lo})->.a;
(
  way(pivot.a)["landuse"="residential"];
  relation(pivot.a)["landuse"="residential"];
  way(pivot.a)["residential"];
  way(pivot.a)["place"="neighbourhood"];
  way(pivot.a)["building"]["name"];
  way(around:100,${la},${lo})["landuse"="residential"]["name"];
);
out tags geom;`;
  const els = await overpassQuery(q, 16000);
  const best = pickCompound(els, at, query);
  return best ? { ring: finishRing(best.ring), source: "osm", name: best.name, areaHa: Math.round(best.areaHa * 10) / 10 } : null;
}

const LocateSchema = z.object({
  found: z.boolean().catch(false),
  confidence: z.coerce.number().min(0).max(1).catch(0),
  outline: z.array(z.tuple([z.coerce.number(), z.coerce.number()])).max(60).catch([]),
  name: z.string().max(80).optional().catch(undefined),
});

async function fromGemini(at: LL, query: string): Promise<CompoundResult | null> {
  const { geminiConfigured, callGeminiJson } = await import("../ai/gemini");
  const { captureSatellite, captureStreetMap, markCenter, downscaleJpeg } = await import("./satellite");
  if (!geminiConfigured()) return null;
  const half = 450; // m — wide enough to contain a large township around the pin
  const dLat = half / M;
  const dLon = half / kx(at[0]);
  const [s, n, w, e] = [at[0] - dLat, at[0] + dLat, at[1] - dLon, at[1] + dLon];
  const cap = await captureSatellite(s, n, w, e);
  // the street map labels societies by name and shades their plots — strong evidence of the real extent
  const street = await captureStreetMap(s, n, w, e, cap.width, cap.height).catch(() => null);
  const img = (await downscaleJpeg(await markCenter(cap.jpeg), 900)).toString("base64");
  const streetImg = street ? (await downscaleJpeg(await markCenter(street.jpeg), 900)).toString("base64") : null;
  const { data } = await callGeminiJson<unknown>({
    system: "You are a precise satellite-imagery analyst. Output JSON only.",
    parts: [
      { text: "IMAGE 1 (satellite):" },
      { inlineData: { mimeType: "image/jpeg", data: img } },
      ...(streetImg ? [{ text: "IMAGE 2 (street map of exactly the same area, same grid):" }, { inlineData: { mimeType: "image/jpeg", data: streetImg } }] : []),
      {
        text: `${streetImg ? "Both images" : "The image"}: north up, ${half * 2} m × ${half * 2} m. The red crosshair at the centre is where a map search for "${query}" landed (it may sit on a gate, a road or on just one building of the place).
Find the WHOLE residential society / gated complex / colony that the search refers to — every tower, block or house belonging to it, not only the building under the crosshair.${
          streetImg ? ` Use IMAGE 2: the society's name is often printed on it and its plot is drawn as a shaded block with a boundary — follow that block.` : ""
        } Societies often have towers on both sides of an internal road; include them all.
Rules: the compound must contain built residential buildings — never pick a construction site, bare land or a neighbouring compound. The outline must contain or touch the crosshair.
Return {"found": boolean, "confidence": 0..1, "name"?: string, "outline": [[u,v],...]} where outline is its perimeter (compound wall or plot edge), 4-24 points, clockwise, in a grid u,v ∈ 0..1000 (u west→east, v north→south). Follow the actual wall, as a simple non-self-intersecting polygon. If you cannot tell which compound it is, return found=false.`,
      },
    ],
    json: true,
    temperature: 0.1,
    maxOutputTokens: 6144,
    timeoutMs: 30000,
    models: ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview"],
    thinkingLevel: "low",
  });
  const r = LocateSchema.parse(data ?? {});
  const reject = (why: string) => (console.info(`[compound] gemini outline rejected: ${why}`), null);
  if (!r.found || r.confidence < 0.45 || r.outline.length < 3) return reject(`found=${r.found} confidence=${r.confidence} points=${r.outline.length}`);
  const ring = r.outline.map(([u, v]) => [n - (v / 1000) * (n - s), w + (u / 1000) * (e - w)] as LL);
  // stricter than OSM: the model's outline must hold the pin (or pass within 60 m of it) and not cross itself
  if (!plausible(ring, at)) return reject(`implausible (${ringAreaHa(ring).toFixed(1)} ha, pin ${Math.round(distToRingM(ring, at))} m away)`);
  if (!containsLL(ring, at) && distToRingM(ring, at) > 60) return reject(`pin ${Math.round(distToRingM(ring, at))} m outside`);
  if (selfIntersects(ring)) return reject("self-intersecting");
  return { ring: finishRing(ring), source: "gemini", name: r.name, areaHa: Math.round(ringAreaHa(ring) * 10) / 10, note: `confidence ${Math.round(r.confidence * 100)}%` };
}

export async function locateCompound(args: { lat: number; lon: number; query: string; outline?: LL[] | null }): Promise<CompoundResult | null> {
  const at: LL = [args.lat, args.lon];
  if (args.outline && args.outline.length >= 4 && plausible(args.outline, at)) {
    return { ring: finishRing(args.outline), source: "geocoder", areaHa: Math.round(ringAreaHa(args.outline) * 10) / 10 };
  }
  // public Overpass mirrors can take 10-20 s: if OSM hasn't answered in 3 s, start Gemini alongside it.
  // A mapped OSM area still wins whenever it arrives.
  let osmDone = false;
  let geminiP: Promise<CompoundResult | null> | null = null;
  const runGemini = () =>
    (geminiP ??= fromGemini(at, args.query).catch((err) => {
      console.warn("[compound] gemini failed:", err instanceof Error ? err.message.slice(0, 120) : err);
      return null;
    }));
  const osm = fromOverpass(at, args.query)
    .catch((err) => {
      console.warn("[compound] overpass failed:", err instanceof Error ? err.message.slice(0, 120) : err);
      return null;
    })
    .finally(() => (osmDone = true));
  const head = setTimeout(() => !osmDone && runGemini(), 3000);
  const o = await osm;
  if (o) {
    clearTimeout(head);
    return o;
  }
  clearTimeout(head);
  return runGemini();
}
