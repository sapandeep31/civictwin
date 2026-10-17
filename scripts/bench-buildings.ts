/**
 * Benchmark Gemini building detection against OSM footprints (societies with good OSM coverage).
 *   bun scripts/bench-buildings.ts <variant>[,<variant>] [slug,slug]
 * Variants: base (768 px, plain image) · grid (1024 px + labelled u,v grid) · grid-hi (1280 px + grid)
 * Uses the FLOW=v2 cache (.eval-import-v2) produced by eval-import.ts.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { z } from "zod";
import { convertOsmToWorld } from "@/lib/geo/convert";
import { orientedBox } from "@/lib/geo/footprint";
import { callGemini, parseJsonLoose } from "@/lib/ai/gemini";
import { clipWorldToPolygon, ringToLocal, ringToUV } from "@/lib/geo/selection";
import type { Building } from "@/lib/world/types";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const DIR = path.join(process.cwd(), ".eval-import-v2");
const SLUGS = (process.argv[3] ?? "prestige-shantiniketan,my-home-jewel,brigade-metropolis,lodha-splendora,amrapali-sapphire").split(",");
const VARIANTS = (process.argv[2] ?? "base,grid").split(",");

/** Labelled grid every 100 units (u,v ∈ 0..1000) — gives the model explicit coordinates to read off. */
export async function gridOverlay(jpeg: Buffer, px: number): Promise<Buffer> {
  const img = sharp(jpeg).resize(px, px, { fit: "inside" });
  const { data, info } = await img.jpeg().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const el: string[] = [];
  for (let k = 1; k < 10; k++) {
    const x = (k / 10) * W;
    const y = (k / 10) * H;
    el.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1"/>`);
    el.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1"/>`);
    el.push(`<text x="${x + 2}" y="12" fill="#ffff00" font-size="11" font-family="sans-serif">${k * 100}</text>`);
    el.push(`<text x="2" y="${y - 2}" fill="#ffff00" font-size="11" font-family="sans-serif">${k * 100}</text>`);
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${el.join("")}</svg>`);
  return sharp(data).composite([{ input: svg }]).jpeg({ quality: 85 }).toBuffer();
}

const Out = z.object({ buildings: z.array(z.object({ corners: z.array(z.tuple([z.coerce.number(), z.coerce.number()])).min(3).max(8) })).catch([]) });

async function detect(slug: string, variant: string, meta: { W: number; D: number; ring?: [number, number][]; bbox: [number, number, number, number] }) {
  const sat = fs.readFileSync(path.join(DIR, slug, "sat.jpg"));
  const px = variant === "base" ? 768 : variant === "grid-hi" ? 1280 : 1024;
  const img = variant === "base" ? await sharp(sat).resize(px, px, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer() : await gridOverlay(sat, px);
  const sel = meta.ring ? ringToUV(meta.ring, meta.bbox) : null;
  const prompt = `Satellite image, north up, ${Math.round(meta.W)} m × ${Math.round(meta.D)} m. Coordinates: u,v ∈ 0..1000 (u = left→right, v = top→bottom)${variant === "base" ? "" : "; the yellow labels mark every 100 units on the overlaid grid"}.
${sel ? `Only consider the area inside this outline (u,v): ${sel.map(([u, v]) => `${u},${v}`).join(" ")}.\n` : ""}List EVERY building (residential towers, apartment blocks, houses, clubhouse) — one entry per separate roof. For L/U/cross-shaped roofs give each rectangular wing separately.
Return JSON {"buildings":[{"corners":[[u,v],[u,v],[u,v],[u,v]]}]} — the 4 corners of each roof in order. Be precise: corners must sit on the roof edges.`;
  const t0 = Date.now();
  const r = await callGemini({
    system: "You are a precise satellite-imagery analyst. Output JSON only.",
    parts: [{ inlineData: { mimeType: "image/jpeg", data: img.toString("base64") } }, { text: prompt }],
    json: true,
    temperature: 0.1,
    maxOutputTokens: 12000,
    timeoutMs: 90000,
    models: ["gemini-3.8-flash"],
    thinkingLevel: "low",
  });
  let data: unknown;
  try {
    data = parseJsonLoose(r.text);
  } catch (e) {
    fs.writeFileSync(path.join(DIR, slug, `bench-${variant}.raw.txt`), r.text);
    console.log(`  ${slug}/${variant}: unparseable reply (${r.text.length} chars) saved`);
    data = {};
  }
  return { boxes: Out.parse(data ?? {}).buildings, ms: Date.now() - t0, model: r.model };
}

function inside(b: Pick<Building, "x" | "z" | "width" | "depth" | "rotation">, p: { x: number; z: number }, grow = 0) {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const dx = p.x - b.x;
  const dz = p.z - b.z;
  return Math.abs(dx * c - dz * s) <= b.width / 2 + grow && Math.abs(dx * s + dz * c) <= b.depth / 2 + grow;
}

const rows: Record<string, unknown>[] = [];
for (const slug of SLUGS) {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, slug, "meta.json"), "utf8"));
  const bundle = JSON.parse(fs.readFileSync(path.join(DIR, slug, "bundle.json"), "utf8"));
  const [so, no, we, ea] = meta.bbox;
  let osm = convertOsmToWorld(bundle, { origin: { lat: (so + no) / 2, lon: (we + ea) / 2 }, bounds: { width: meta.W, depth: meta.D } }).world;
  if (meta.ring) osm = clipWorldToPolygon(osm, ringToLocal(meta.ring, meta.bbox, meta.W, meta.D)).world;
  const truth = osm.buildings.filter((b) => b.width * b.depth >= 40);
  for (const variant of VARIANTS) {
    const cache = path.join(DIR, slug, `bench-${variant}.json`);
    let res: Awaited<ReturnType<typeof detect>>;
    if (fs.existsSync(cache)) res = JSON.parse(fs.readFileSync(cache, "utf8"));
    else {
      res = await detect(slug, variant, meta);
      fs.writeFileSync(cache, JSON.stringify(res));
    }
    const pt = (u: number, v: number) => ({ x: (u / 1000 - 0.5) * meta.W, z: (v / 1000 - 0.5) * meta.D });
    const det = res.boxes.map((b) => orientedBox(b.corners.map(([u, v]) => pt(u, v))));
    // precision: detected box centre falls inside (or within 4 m of) a mapped building
    const tp = det.filter((d) => truth.some((t) => inside(t, d, 4))).length;
    // recall: mapped building whose centre is covered by some detection
    const found = truth.filter((t) => det.some((d) => inside(d, t, 4))).length;
    // centre error for matched pairs
    const errs = det
      .map((d) => truth.filter((t) => inside(t, d, 4)).map((t) => Math.hypot(t.x - d.x, t.z - d.z))[0])
      .filter((e): e is number => e !== undefined);
    rows.push({
      slug,
      variant,
      truth: truth.length,
      detected: det.length,
      precision: det.length ? +(tp / det.length).toFixed(2) : 0,
      recall: truth.length ? +(found / truth.length).toFixed(2) : 0,
      centreErrM: errs.length ? +(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1) : null,
      s: Math.round(res.ms / 1000),
    });
  }
}
console.table(rows);
const agg: Record<string, { p: number; r: number; n: number }> = {};
for (const r of rows as { variant: string; precision: number; recall: number }[]) {
  agg[r.variant] ??= { p: 0, r: 0, n: 0 };
  agg[r.variant].p += r.precision;
  agg[r.variant].r += r.recall;
  agg[r.variant].n += 1;
}
for (const [v, a] of Object.entries(agg)) console.log(`${v}: mean precision ${(a.p / a.n).toFixed(2)} · mean recall ${(a.r / a.n).toFixed(2)}`);
