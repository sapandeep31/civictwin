import { NextRequest, NextResponse } from "next/server";
import { fetchOsmFeatures, validateBbox, type OsmFeatureBundle } from "@/lib/geo/osm";
import { dedupeAgainst, fetchOvertureBuildings } from "@/lib/geo/overture";
import { convertOsmToWorld } from "@/lib/geo/convert";
import { friendlyUpstreamError, rateLimit, readJson } from "@/lib/api/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/geo/import — fetch OSM features (plus Overture ML building
 * footprints where OSM has none) for a bounding box and convert them into the
 * internal world model. Bounded by max area + feature caps.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "geo/import", 12);
  if (limited) return limited;
  const parsed = await readJson<{ south?: unknown; north?: unknown; west?: unknown; east?: unknown; name?: unknown; fixToBbox?: unknown }>(req, 4096);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const s = Number(body.south);
  const n = Number(body.north);
  const w = Number(body.west);
  const e = Number(body.east);
  const bad = validateBbox(s, n, w, e);
  if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });
  const spanLat = (n - s) * 111320;
  const spanLon = (e - w) * 111320 * Math.cos(((s + n) / 2) * (Math.PI / 180));

  try {
    // OSM + ML footprints (Overture) in parallel; OSM wins, Overture fills unmapped buildings
    const [osmR, ovR] = await Promise.allSettled([fetchOsmFeatures(s, n, w, e), fetchOvertureBuildings(s, n, w, e)]);
    if (ovR.status === "rejected") console.warn("[geo/import] overture skipped:", String(ovR.reason).slice(0, 160));
    const extraAll = ovR.status === "fulfilled" ? ovR.value : [];
    if (osmR.status === "rejected" && !extraAll.length) throw osmR.reason;
    const osmBundle: OsmFeatureBundle =
      osmR.status === "fulfilled"
        ? osmR.value
        : { roads: [], buildings: [], parks: [], facilities: [], attribution: "", fetchedAt: new Date().toISOString() };
    const extra = dedupeAgainst(osmBundle.buildings, extraAll);
    const bundle: OsmFeatureBundle = {
      ...osmBundle,
      buildings: [...osmBundle.buildings, ...extra.map((b) => ({ id: b.id, polygon: b.polygon, height: b.height, levels: b.levels, source: b.source }))],
      attribution: [osmBundle.attribution, extra.length ? "Buildings: Overture Maps Foundation (Google Open Buildings, Microsoft)" : ""].filter(Boolean).join(" · "),
    };
    // fixToBbox: origin = bbox center and bounds = bbox span (aligns with /api/geo/satellite imagery)
    const fix = body.fixToBbox === true;
    const { world, stats, notes } = convertOsmToWorld(
      bundle,
      fix ? { origin: { lat: (s + n) / 2, lon: (w + e) / 2 }, bounds: { width: spanLon, depth: spanLat } } : undefined
    );
    if (extra.length) {
      const bySrc = new Map<string, number>();
      for (const b of extra) bySrc.set(b.source, (bySrc.get(b.source) ?? 0) + 1);
      notes.unshift(
        `${extra.length} building footprint${extra.length === 1 ? "" : "s"} missing from OpenStreetMap were added from ${[...bySrc.entries()].map(([k, v]) => `${k} (${v})`).join(", ")} via Overture Maps — machine-traced from imagery, marked inferred.`
      );
    }
    if (osmR.status === "rejected") notes.unshift("OpenStreetMap was unavailable, so roads are missing — buildings come from Overture Maps only.");
    stats.extraBuildings = extra.length;
    if (!fix && stats.roads === 0 && stats.buildings === 0) {
      return NextResponse.json(
        { ok: false, error: "No mapped roads or buildings were found in this area. Try a different place or use the demo neighborhood." },
        { status: 422 }
      );
    }
    return NextResponse.json({
      ok: true,
      data: {
        world,
        stats,
        notes,
        attribution: bundle.attribution,
        fetchedAt: bundle.fetchedAt,
        suggestedName: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Imported Neighborhood",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[geo/import] failed:", msg.slice(0, 300));
    const f = friendlyUpstreamError(err, "OpenStreetMap");
    return NextResponse.json({ ok: false, error: f.message, rateLimited: f.rateLimited }, { status: f.status });
  }
}
