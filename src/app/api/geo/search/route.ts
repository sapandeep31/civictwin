import { NextRequest, NextResponse } from "next/server";
import { searchPlaces } from "@/lib/geo/osm";
import { rateLimit, readJson } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/geo/search — place search: Google Places (when a key is set) merged
 * with an OSM-compatible geocoder (Nominatim by default, with mapped outlines).
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "geo/search", 30);
  if (limited) return limited;
  const parsed = await readJson<{ query?: unknown }>(req, 2048);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const q = typeof body.query === "string" ? body.query.trim() : "";
  if (!q) return NextResponse.json({ ok: false, error: "Provide a place name to search." }, { status: 400 });
  if (q.length > 200) return NextResponse.json({ ok: false, error: "Query is too long." }, { status: 400 });

  try {
    const results = await searchPlaces(q);
    return NextResponse.json({
      ok: true,
      data: {
        results,
        attribution: results.some((r) => r.source === "google") ? "Google Places · © OpenStreetMap contributors" : "© OpenStreetMap contributors",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const timeout = msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("abort");
    return NextResponse.json(
      {
        ok: false,
        error: timeout
          ? "The location search service timed out. It may be unreachable from this network — you can still use the demo neighborhood or build from scratch."
          : `Location search failed${/429/.test(msg) ? " (the search service is rate-limiting — wait a few seconds)" : ""}. You can still use the sample society or build from scratch.`,
      },
      { status: 502 }
    );
  }
}
