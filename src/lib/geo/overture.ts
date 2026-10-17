/**
 * Server-only: ML building footprints from Overture Maps (Google Open Buildings,
 * Microsoft ML Buildings, … merged with OSM) read straight from the public
 * buildings PMTiles via HTTP range requests — no key, no bulk download.
 *
 * Used to fill buildings OSM has not mapped (common for Indian societies) before
 * any model-inferred geometry: these footprints are traced from imagery at scale
 * and are far more precise than a vision model's estimates.
 */

import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

export interface ExtraBuilding {
  id: string;
  polygon: [number, number][]; // [lat, lon]
  height?: number;
  levels?: number;
  source: string;
  confidence?: number;
}

const STAC = "https://stac.overturemaps.org/catalog.json";
const FALLBACK_RELEASE = process.env.OVERTURE_RELEASE || "2026-09-23.1";
const Z = 14;
const MAX_TILES = 6;
const MIN_CONFIDENCE = 0.65;

let release: { name: string; at: number } | null = null;
let archive: { name: string; pm: PMTiles } | null = null;

async function latestRelease(): Promise<string> {
  if (release && Date.now() - release.at < 24 * 3600 * 1000) return release.name;
  try {
    const cat = (await (await fetch(STAC, { signal: AbortSignal.timeout(4000) })).json()) as { links: { rel: string; href: string }[] };
    const names = cat.links
      .filter((l) => l.rel === "child")
      .map((l) => l.href.split("/").slice(-2)[0])
      .filter((n) => /^\d{4}-\d{2}-\d{2}/.test(n))
      .sort();
    release = { name: names[names.length - 1] ?? FALLBACK_RELEASE, at: Date.now() };
  } catch {
    release = { name: FALLBACK_RELEASE, at: Date.now() - 23 * 3600 * 1000 }; // retry discovery in ~1 h
  }
  return release.name;
}

async function pmtiles(): Promise<PMTiles> {
  const name = await latestRelease();
  if (!archive || archive.name !== name) archive = { name, pm: new PMTiles(`https://tiles.overturemaps.org/${name}/buildings.pmtiles`) };
  return archive.pm;
}

const lonToX = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const latToY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** Z);
};

function parseSources(raw: unknown): { resource?: string; confidence?: number }[] {
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Non-OSM building footprints intersecting the bbox (OSM-sourced ones are skipped: we have OSM already). */
export async function fetchOvertureBuildings(s: number, n: number, w: number, e: number, timeoutMs = 9000): Promise<ExtraBuilding[]> {
  const x0 = lonToX(w);
  const x1 = lonToX(e);
  const y0 = latToY(n);
  const y1 = latToY(s);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) return [];
  const pm = await pmtiles();
  const jobs: Promise<ExtraBuilding[]>[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      jobs.push(
        (async () => {
          const t = await pm.getZxy(Z, x, y);
          if (!t?.data) return [];
          const vt = new VectorTile(new PbfReader(new Uint8Array(t.data)));
          const layer = vt.layers.building;
          if (!layer) return [];
          const out: ExtraBuilding[] = [];
          for (let i = 0; i < layer.length; i++) {
            const f = layer.feature(i);
            const p = f.properties as Record<string, unknown>;
            const geomSource = String(p["@geometry_source"] ?? "");
            if (/openstreetmap/i.test(geomSource) || p.is_underground === true) continue;
            const src = parseSources(p.sources)[0];
            const confidence = typeof src?.confidence === "number" ? src.confidence : undefined;
            if (confidence !== undefined && confidence < MIN_CONFIDENCE) continue;
            const gj = f.toGeoJSON(x, y, Z).geometry;
            const rings: number[][][] = gj.type === "Polygon" ? [gj.coordinates[0]] : gj.type === "MultiPolygon" ? gj.coordinates.map((pl) => pl[0]) : [];
            rings.forEach((ring, k) => {
              if (ring.length < 4) return;
              const lats = ring.map((c) => c[1]);
              const lons = ring.map((c) => c[0]);
              if (Math.max(...lats) < s || Math.min(...lats) > n || Math.max(...lons) < w || Math.min(...lons) > e) return;
              out.push({
                id: `ovt_${String(p.id ?? `${x}_${y}_${i}`).slice(0, 36)}${k ? `_${k}` : ""}`,
                polygon: ring.map((c) => [c[1], c[0]] as [number, number]),
                height: typeof p.height === "number" ? p.height : undefined,
                levels: typeof p.num_floors === "number" ? p.num_floors : undefined,
                source: geomSource || "Overture Maps",
                confidence,
              });
            });
          }
          return out;
        })()
      );
  const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Overture buildings timed out")), timeoutMs));
  const tiles = await Promise.race([Promise.all(jobs), timer]);
  // features crossing tile edges appear in both tiles — keep the first copy
  const seen = new Set<string>();
  return tiles.flat().filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
}

function pip(p: [number, number], ring: [number, number][]) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ya, xa] = ring[i];
    const [yb, xb] = ring[j];
    if (ya > p[0] !== yb > p[0] && p[1] < ((xb - xa) * (p[0] - ya)) / (yb - ya) + xa) ins = !ins;
  }
  return ins;
}
const centroid = (r: [number, number][]): [number, number] => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];

export function ringAreaM2(r: [number, number][]): number {
  const k = 111320 * Math.cos((r[0][0] * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][1] - r[i][1]) * k * ((r[j][0] + r[i][0]) * 111320);
  return Math.abs(a / 2);
}

/**
 * Keep only extra footprints that don't duplicate a mapped (OSM) building and
 * are big enough to matter. Where OSM is locally mapped (≥ 2 mapped buildings
 * within 60 m) the mapping there is nearly complete, so only substantial extras
 * (≥ 100 m²) get in — otherwise kiosks, sheds and pergolas clutter the twin;
 * in unmapped stretches anything ≥ 40 m² (a small house) is kept. Pure.
 */
export function dedupeAgainst(mapped: { polygon: [number, number][] }[], extra: ExtraBuilding[]): ExtraBuilding[] {
  const mc = mapped.map((m) => ({ ring: m.polygon, c: centroid(m.polygon) }));
  const near = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180)) < 60;
  return extra.filter((x) => {
    const c = centroid(x.polygon);
    if (mc.some((m) => pip(c, m.ring) || pip(m.c, x.polygon))) return false;
    let dense = 0;
    for (const m of mc) if (near(c, m.c) && ++dense >= 2) break;
    return ringAreaM2(x.polygon) >= (dense >= 2 ? 100 : 40);
  });
}
