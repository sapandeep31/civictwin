import { NextRequest, NextResponse } from "next/server";
import { callGemini, geminiConfigured, parseJsonLoose } from "@/lib/ai/gemini";
import type { IncidentMix, LocalIntel } from "@/lib/ai/context";
import { z } from "zod";
import { friendlyUpstreamError, rateLimit, readJson } from "@/lib/api/http";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const CACHE = new Map<string, { at: number; data: LocalIntel }>();
const TTL_MS = 60 * 60 * 1000;

const SYSTEM = `You are the local-context researcher for Praesidium, a residential-society security PLANNING simulator.
Use Google Search to find RECENT (last ~12 months) public local news and official information about safety in the given locality.
STRICT RULES:
- Area-level, public information only: incident TYPES, time-of-day patterns, places/stretches, police contacts, seasonal factors.
- NEVER name or describe individuals (victims, suspects, officers by name), and NEVER profile or attribute crime to any community, religion, caste, nationality, migrants, or demographic group. If a source does, ignore that part.
- Do not invent statistics. If evidence is thin, say so and keep weights moderate.
- Helplines must be official public numbers (e.g. 112, local police station public line) only if you found them; otherwise include only 112 and 1091 (women helpline).
- Be concise.`;

const clamp = (n: unknown, lo: number, hi: number, d: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : d;
  return Math.min(hi, Math.max(lo, v));
};
const str = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

// Defensive scrub: drop phone-like numbers inside prose (helplines are kept separately), emails, and demographic words.
const DEMOGRAPHIC = /\b(muslim|hindu|christian|sikh|dalit|caste|migrant|immigrant|refugee|bangladeshi|nepali|outsider|tribal|community members?)\b/gi;
function scrub(s: string): string {
  return s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]").replace(DEMOGRAPHIC, "[group]");
}

function normalize(raw: any, sources: { title: string; uri: string }[], placeName: string, model: string, grounded: boolean): LocalIntel {
  const mixRaw = raw?.incidentMix ?? {};
  const keys: (keyof IncidentMix)[] = ["mugger", "harasser", "burglar", "vandal", "chain_snatcher"];
  const mix = {} as IncidentMix;
  let total = 0;
  for (const k of keys) {
    mix[k] = clamp(mixRaw[k], 0, 1, 0.2);
    total += mix[k];
  }
  for (const k of keys) mix[k] = total > 0 ? Math.round((mix[k] / total) * 100) / 100 : 0.2;

  const ss = raw?.suggestedScenario ?? {};
  const rf = Array.isArray(raw?.riskFactors) ? raw.riskFactors : [];
  const hl = Array.isArray(raw?.helplines) ? raw.helplines : [];
  return {
    summary: scrub(str(raw?.summary, 900)),
    riskFactors: rf.slice(0, 8).map((r: any) => ({
      factor: scrub(str(r?.factor, 140)),
      evidence: scrub(str(r?.evidence, 300)),
      sourceIdx:
        Number.isInteger(r?.sourceIdx) && r.sourceIdx >= 0 && r.sourceIdx < sources.length ? (r.sourceIdx as number) : null,
    })),
    incidentMix: mix,
    peakHours: scrub(str(raw?.peakHours, 160)),
    suggestedScenario: {
      eventsPerHour: Math.round(clamp(ss.eventsPerHour, 1, 40, 8)),
      perpCount: Math.round(clamp(ss.perpCount, 0, 12, 3)),
      guardFatigue: Math.round(clamp(ss.guardFatigue, 0, 1, 0.3) * 100) / 100,
      lightingOutageFraction: Math.round(clamp(ss.lightingOutageFraction, 0, 0.8, 0.15) * 100) / 100,
      ambientVisibility: Math.round(clamp(ss.ambientVisibility, 0.3, 1, 0.8) * 100) / 100,
    },
    helplines: hl
      .slice(0, 6)
      .map((h: any) => ({ name: str(h?.name, 60), number: str(h?.number, 24).replace(/[^\d+\-\s()]/g, "") }))
      .filter((h: { name: string; number: string }) => h.name && h.number),
    sources: sources.slice(0, 10),
    placeName,
    generatedAt: new Date().toISOString(),
    model,
    grounded,
  };
}

const Body = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  placeName: z.unknown().optional(),
  societyType: z.unknown().optional(),
});

export async function POST(req: NextRequest) {
  const parsed = await readJson(req, 8192, Body);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const { lat, lng } = body;
  const placeName = str(body.placeName, 120) || `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  const societyType = str(body.societyType, 60) || "residential society";
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;

  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ ok: true, data: { ...hit.data, cached: true } });
  }
  if (!geminiConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Local safety intel needs Gemini, which is not configured on this server. The simulation works fine without it." },
      { status: 503 }
    );
  }
  const limited = rateLimit(req, "ai/context", 8);
  if (limited) return limited;

  const prompt = `Locality: ${placeName} (lat ${lat.toFixed(4)}, lng ${lng.toFixed(4)}). Site type: ${societyType}. Today: ${new Date().toISOString().slice(0, 10)}.

Research public local news/info (last ~12 months) about neighbourhood safety here and nearby: reported incident types (chain snatching, burglary, mobile theft, harassment, vehicle theft, vandalism...), time-of-day patterns, hotspots by TYPE of place nearby (metro exits, parks, liquor shops, unlit stretches, construction), the local police station and public helpline numbers, and festival/season factors.

Then reply with ONLY one fenced \`\`\`json block shaped exactly like:
{
 "summary": "3-4 sentence area-level briefing",
 "riskFactors": [{"factor": "short", "evidence": "what public reporting indicates, 1-2 sentences", "sourceIdx": 0}],
 "incidentMix": {"mugger":0-1,"harasser":0-1,"burglar":0-1,"vandal":0-1,"chain_snatcher":0-1},
 "peakHours": "e.g. 21:00-01:00 and 05:30-07:00",
 "suggestedScenario": {"eventsPerHour": 1-40, "perpCount": 0-12, "guardFatigue": 0-1, "lightingOutageFraction": 0-0.8, "ambientVisibility": 0.3-1},
 "helplines": [{"name":"Police control room","number":"112"}]
}
sourceIdx = 0-based index into the grounding sources list you used (omit/null if unsure). The incidentMix weights should sum to about 1. The scenario values are for a SIMULATION stress-test, not predictions.`;

  try {
    let r;
    let groundingNote = "";
    try {
      r = await callGemini({
        prompt,
        system: SYSTEM,
        googleSearch: true,
        temperature: 0.3,
        // grounded search has its own small quota: fail fast (it 429s on every key) instead of ~60 s
        maxOutputTokens: 8192,
        timeoutMs: 22000,
        budgetMs: 28000,
      });
    } catch (e) {
      // Search-grounding quota/outage: degrade to model knowledge, clearly labelled, and do not cache for long.
      groundingNote = " (Live web search was unavailable; this briefing is from general model knowledge, not recent news.)";
      r = await callGemini({
        prompt: prompt + "\nNOTE: live search is unavailable; use only general well-known knowledge, state uncertainty, and set sourceIdx to null.",
        system: SYSTEM,
        temperature: 0.3,
        maxOutputTokens: 8192,
        thinkingLevel: "low",
        timeoutMs: 25000,
        budgetMs: 35000,
      });
      console.warn("[ai/context] grounded call failed:", e instanceof Error ? e.message.slice(0, 200) : e);
    }
    // De-dup sources by uri, keep order.
    const seen = new Set<string>();
    const sources = r.sources.filter((s) => (seen.has(s.uri) ? false : (seen.add(s.uri), true)));
    const data = normalize(parseJsonLoose(r.text), sources, placeName, r.model, sources.length > 0);
    data.summary += groundingNote;
    // Without search grounding, only keep short national emergency numbers (avoid hallucinated local numbers).
    if (!data.grounded) data.helplines = data.helplines.filter((h) => h.number.replace(/\D/g, "").length <= 4);
    // Ungrounded results are cached only briefly so grounding is retried soon.
    CACHE.set(key, { at: Date.now() - (groundingNote ? TTL_MS - 2 * 60 * 1000 : 0), data });
    return NextResponse.json({ ok: true, data });
  } catch (err) {
    // Never a 5xx: local intel is optional context. Return a clearly-labelled neutral briefing
    // (even incident mix, national helplines only) and cache it briefly so it is retried soon.
    console.warn("[ai/context] failed:", err instanceof Error ? err.message.slice(0, 200) : err);
    const f = friendlyUpstreamError(err, "Gemini");
    const data = normalize(
      {
        summary: `Local news research is unavailable right now (${f.rateLimited ? "AI quota reached" : "AI service error"}), so the simulation uses neutral defaults for ${placeName}. Retry later for a grounded local briefing.`,
        helplines: [
          { name: "Emergency (police)", number: "112" },
          { name: "Women helpline", number: "1091" },
        ],
      },
      [],
      placeName,
      "none",
      false
    );
    CACHE.set(key, { at: Date.now() - TTL_MS + 2 * 60 * 1000, data });
    return NextResponse.json({ ok: true, data: { ...data, unavailable: true } });
  }
}
