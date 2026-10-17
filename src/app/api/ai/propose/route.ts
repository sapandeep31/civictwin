import { NextRequest, NextResponse } from "next/server";
import { callGemini, geminiConfigured, parseJsonLoose } from "@/lib/ai/gemini";
import { validateProposal, type Proposal } from "@/lib/ai/schema";
import { deterministicRecommendation } from "@/lib/ai/recommend";
import { OUTCOME_GLOSSARY, outcomeLabel } from "@/lib/sim/labels";
import type { PraesidiumProject, StoredRun } from "@/lib/world/types";
import { z } from "zod";
import { friendlyUpstreamError, rateLimit, readJson, withTimeout } from "@/lib/api/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ai/propose
 *
 * Generates a structured intervention proposal for the planning assistant.
 * Provider order: Gemini (if GEMINI_API_KEY is configured) → z-ai SDK →
 * deterministic rule-based recommendations. Model output is ALWAYS
 * validated against an explicit allowlist before being returned; nothing
 * is applied without explicit user approval in the UI.
 */
const arr = z.array(z.unknown()).max(5000);
const Body = z.object({
  project: z.object({
    name: z.string().max(200).optional(),
    world: z
      .object({
        bounds: z.object({ width: z.number(), depth: z.number() }),
        roads: arr,
        buildings: arr,
        facilities: arr,
        streetlights: arr,
        cameras: arr,
        guards: arr,
      })
      .passthrough(),
    scenario: z.object({ id: z.string() }).passthrough(),
  }),
  baselineRun: z.object({ metrics: z.record(z.string(), z.unknown()), events: z.array(z.unknown()).max(5000) }).passthrough().nullish(),
  message: z.string().optional(),
  localIntel: z.unknown().optional(),
});

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "ai/propose", 12);
  if (limited) return limited;
  const parsed = await readJson(req, 4_000_000, Body);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const project = body.project as unknown as PraesidiumProject;
  const message = typeof body.message === "string" ? body.message.slice(0, 1500) : "";
  const baselineRun = (body.baselineRun as unknown as StoredRun | null) ?? null;

  const geminiKey = geminiConfigured();

  if (geminiKey) {
    try {
      const raw = await callGeminiProposal(project, baselineRun, message, body.localIntel);
      const result = validateProposal(raw, project);
      if (result.ok) {
        return NextResponse.json({
          ok: true,
          data: { provider: "gemini", proposal: result.proposal, estimatedCostInr: result.estimatedCostInr, basis: [] },
        });
      }
      return NextResponse.json({
        ok: false,
        error: `The AI proposal failed validation and was rejected: ${result.errors.join(" ")}`,
        data: { provider: "gemini", rejected: true },
      });
    } catch (err) {
      // fall through to next provider, noting the failure
      console.warn("[ai/propose] Gemini failed:", err instanceof Error ? err.message.slice(0, 200) : err);
      if (process.env.AI_STRICT === "1") {
        const f = friendlyUpstreamError(err, "Gemini");
        return NextResponse.json({ ok: false, error: f.message, rateLimited: f.rateLimited }, { status: f.status });
      }
    }
  }

  // z-ai SDK provider (only usable where its config file exists; bounded so a hang never blocks the fallback)
  try {
    const raw = await withTimeout(callZai(project, baselineRun, message, body.localIntel), 20000, "z-ai");
    const result = validateProposal(raw, project);
    if (result.ok) {
      return NextResponse.json({
        ok: true,
        data: { provider: "z-ai", proposal: result.proposal, estimatedCostInr: result.estimatedCostInr, basis: [] },
      });
    }
    return NextResponse.json({
      ok: false,
      error: `The AI proposal failed validation and was rejected: ${result.errors.join(" ")}`,
      data: { provider: "z-ai", rejected: true },
    });
  } catch {
    // fall through to deterministic recommendations
  }

  // Deterministic fallback — clearly labeled as rule-based
  const rec = deterministicRecommendation(project, baselineRun);
  return NextResponse.json({
    ok: true,
    data: { provider: "rules", proposal: rec.proposal, estimatedCostInr: 0, basis: rec.basis },
  });
}

/* ------------------------------------------------------------------ */

function buildPrompt(project: PraesidiumProject, baselineRun: StoredRun | null, message: string, intel?: unknown): string {
  const { world, scenario } = project;
  const lights = world.streetlights.length;
  const cams = world.cameras.length;
  const guards = world.guards.map((g) => ({ id: g.id, name: g.name, waypoints: g.waypoints.length }));

  const darkSegments = world.roads
    .filter((r) => r.pedestrian)
    .slice(0, 40)
    .map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      mid: r.points[Math.floor(r.points.length / 2)],
    }))
    .slice(0, 25);

  const summary = {
    neighborhood: { name: project.name, bounds: world.bounds },
    counts: {
      roads: world.roads.length,
      buildings: world.buildings.length,
      facilities: world.facilities.length,
      streetlights: lights,
      cameras: cams,
      guards: guards.length,
    },
    facilities: world.facilities.slice(0, 12).map((f) => ({ type: f.type, name: f.name, x: Math.round(f.x), z: Math.round(f.z) })),
    guards,
    sampleRoadMidpoints: darkSegments,
    scenario: {
      id: scenario.id,
      durationSec: scenario.durationSec,
      population: scenario.population,
      eventsPerHour: scenario.eventsPerHour,
      lightingOutageFraction: scenario.lightingOutageFraction,
      ambientVisibility: scenario.ambientVisibility,
    },
    baseline: baselineRun
      ? {
          metrics: baselineRun.metrics,
          unresolvedEvents: baselineRun.events
            .filter((e) => e.outcome !== "resolved")
            .slice(0, 10)
            .map((e) => ({ x: Math.round(e.x), z: Math.round(e.z), type: e.type, outcome: e.outcome, outcomeLabel: outcomeLabel(e.outcome) })),
        }
      : null,
  };

  const intelBlock = formatIntel(intel);
  return `You are the Praesidium planning assistant for neighborhood safety planning exercises.
All data is a FICTIONAL simulation. Never imply predictions of real crime or make claims about real individuals.

Project summary (compact, trusted — computed by the application):
${JSON.stringify(summary)}
${intelBlock}

User planning request: "${message || "Suggest improvements to poorly illuminated pedestrian paths and response coverage."}"

Respond with ONLY a JSON object (no markdown fences, no commentary) shaped exactly like:
{
  "title": string,             // short proposal title
  "rationale": string,         // 2-4 sentences, plain language
  "ops": [                     // 1-12 operations from this allowlist ONLY:
    {"op":"add_streetlight","x":number,"z":number,"brightness":number,"radius":number}, // brightness is float 0.1 to 1.0 (default 1.0), radius is meters (10 to 30)
    {"op":"move_streetlight","id":string,"x":number,"z":number},
    {"op":"edit_streetlight","id":string,"on":boolean,"brightness":number,"radius":number},
    {"op":"add_camera","x":number,"z":number,"range":number,"fovDeg":number,"orientationDeg":number},
    {"op":"move_camera","id":string,"x":number,"z":number},
    {"op":"edit_camera","id":string,"active":boolean,"range":number,"fovDeg":number,"orientationDeg":number},
    {"op":"set_patrol","guardId":string,"waypoints":[{"x":number,"z":number}]},
    {"op":"set_scenario","patch":{"eventsPerHour":number,"guardCount":number|null,"lightingOutageFraction":number,"ambientVisibility":number}}
  ],
  "expectedEffects": string[],  // short bullets
  "limitations": string[],      // short bullets
  "costNotes": string           // optional
}

Rules:
- Coordinates are local meters, x east / z south, within bounds ±${Math.round(world.bounds.width / 2)} , ±${Math.round(world.bounds.depth / 2)}.
- brightness MUST be a decimal float between 0.1 and 1.0 (e.g. 1.0 or 0.8), NOT a percentage like 80 or 100.
- Only reference streetlight/camera/guard IDs that appear in the summary. sampleRoadMidpoints are safe positions on the walkable network.
- Prefer placing new streetlights ON or NEAR walkable paths (use sampleRoadMidpoints or facility positions as anchors).
- Never claim crime prevention; speak in "modeled coverage" and "estimated response" terms.
- Write title, rationale, expectedEffects and limitations for an RWA committee: plain English, short. Never show internal codes or IDs (no "perp_escaped", "escaped_on_cctv", "gd_inf_0", "sl_…", coordinates) — say "escaped through a blind spot", "the gate guard", "near the main gate" instead.
- ${OUTCOME_GLOSSARY} Prioritise cameras covering spots where incidents ended "perp_escaped" (blind spots), and patrol/guard changes where guards were late or absent.
- Do NOT use set_scenario to change eventsPerHour, lightingOutageFraction or ambientVisibility — those describe the night being tested, not something the society can buy; changing them would make the comparison unfair. set_scenario may only change guardCount.`;
}

async function callGeminiProposal(
  project: PraesidiumProject,
  baselineRun: StoredRun | null,
  message: string,
  intel: unknown
): Promise<unknown> {
  const r = await callGemini({
    prompt: buildPrompt(project, baselineRun, message, intel),
    json: true,
    temperature: 0.3,
    // thinking tokens count against this budget — 4096 truncated replies mid-array
    maxOutputTokens: 8192,
    thinkingLevel: "low",
    timeoutMs: 30000,
  });
  return parseJsonLooseStrict(r.text);
}
async function callZai(
  project: PraesidiumProject,
  baselineRun: StoredRun | null,
  message: string,
  intel?: unknown
): Promise<unknown> {
  const { default: ZAI } = await import("z-ai-web-dev-sdk");
  const zai = await ZAI.create();
  const completion = await zai.chat.completions.create({
    messages: [
      {
        role: "assistant",
        content:
          "You are the Praesidium planning assistant. You output ONLY valid JSON matching the requested schema, with no markdown fences or commentary.",
      },
      { role: "user", content: buildPrompt(project, baselineRun, message, intel) },
    ],
    thinking: { type: "disabled" },
  });
  const text = completion.choices[0]?.message?.content ?? "";
  return parseJsonLooseStrict(text);
}

function parseJsonLooseStrict(text: string): unknown {
  if (!text || !text.trim()) throw new Error("Empty model response.");

  // 1. Check for markdown code fences ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenceMatch ? fenceMatch[1] : text).trim();

  // 2. Direct parse attempt
  try {
    return JSON.parse(candidate);
  } catch {
    // 3. Extract outermost { ... }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = candidate.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        /* fall through to the shared repair (trailing commas, truncated replies) */
      }
    }
    try {
      return parseJsonLoose(candidate);
    } catch {
      throw new Error("Model response did not contain valid JSON.");
    }
  }
}

export type { Proposal };


/** Compact, sanitized local-intel context (area-level only) for the planner prompt. */
function formatIntel(intel: unknown): string {
  const i = intel as {
    summary?: string;
    peakHours?: string;
    riskFactors?: ({ factor?: string } | string)[];
    incidentMix?: Record<string, number>;
    grounded?: boolean;
  } | null;
  if (!i || typeof i !== "object" || typeof i.summary !== "string") return "";
  const factors = (i.riskFactors ?? []).slice(0, 5).map((r) => String(typeof r === "string" ? r : r?.factor ?? "").slice(0, 100)).filter(Boolean);
  return `Local context (area-level, ${i.grounded ? "from public sources" : "general knowledge, not web-grounded"}; use it to prioritise where/when to intervene, never to profile people):
${JSON.stringify({ summary: i.summary.slice(0, 400), peakHours: String(i.peakHours ?? "").slice(0, 80), riskFactors: factors, incidentMix: i.incidentMix ?? {} })}
In "rationale" (and expectedEffects) explicitly tie each proposed addition to one of these local risk factors or common incident types, e.g. "chain snatching is common near metro exits, so light the Block F footpath". Keep every op valid and inside the allowlist.
`;
}