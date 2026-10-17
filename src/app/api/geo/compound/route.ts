import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { locateCompound } from "@/lib/geo/compound";
import { rateLimit, readJson, withTimeout } from "@/lib/api/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  lat: z.coerce.number().min(-85).max(85),
  lon: z.coerce.number().min(-180).max(180),
  query: z.string().max(300).default(""),
  outline: z.array(z.tuple([z.coerce.number(), z.coerce.number()])).max(2000).nullish(),
});

/**
 * POST /api/geo/compound — { lat, lon, query, outline? }
 * → { ok, data: { compound: { ring: [lat,lon][], source, name?, areaHa, note? } | null } }
 * Finds the society's real perimeter around a search result (geocoder outline →
 * OSM residential area → Gemini on satellite). null = no confident outline.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "geo/compound", 20);
  if (limited) return limited;
  const body = await readJson(req, 200_000, Body);
  if (!body.ok) return body.res;
  try {
    const compound = await withTimeout(locateCompound({ ...body.data, outline: body.data.outline ?? null }), 50000, "compound lookup");
    return NextResponse.json({ ok: true, data: { compound } });
  } catch (err) {
    console.warn("[geo/compound] failed:", err instanceof Error ? err.message.slice(0, 200) : err);
    return NextResponse.json({ ok: true, data: { compound: null } });
  }
}
