"use client";

/**
 * "Recommended fixes" — instant planner inside the AI planner panel.
 *   1. code generates candidate interventions from the baseline run (ms)
 *   2. TypeSafe Jev scores them all in ONE batched request (~0.4 s)
 *   3. the top 3 are verified with a same-seed single-change simulation
 *   4. the planner model can then write the explanation (existing planner flow)
 * The UI speaks plainly (impact / tested / cost); model names stay out of it.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/store/editor";
import { runBaseline } from "@/lib/run-actions";
import {
  candidateProposal,
  generateCandidates,
  heuristicScore,
  type Candidate,
  type CandidateScore,
  type VerifiedPick,
} from "@/lib/ai/quickpicks";
import type { Proposal } from "@/lib/ai/schema";
import { fmtInr } from "@/lib/sim/compare";
import { verifyCandidatesStreaming } from "@/lib/sim/verifyClient";
import { cn } from "@/lib/utils";
import { useIntel } from "@/lib/ai/intelStore";
import { compactIntel, localLine, localTagFor } from "@/lib/ai/context";

type Row = Candidate & { score: CandidateScore };

const KIND_ICON: Record<string, string> = { camera: "📹", light: "💡", patrol: "🧭", guard: "👮" };
const KIND_NAME: Record<string, string> = { camera: "CCTV camera", light: "Streetlight", patrol: "Patrol route", guard: "Night guard" };
const SHOWN = 5;

/** Labels carry raw map coordinates for the model; people don't need them. */
const cleanLabel = (s: string) => s.replace(/\s*\(-?\d+,\s*-?\d+\)/g, "");

function impactWord(v: number): { word: string; cls: string } {
  if (v >= 0.6) return { word: "High impact", cls: "text-[#0f766e]" };
  if (v >= 0.3) return { word: "Medium impact", cls: "text-[#2e5b7d]" };
  return { word: "Low impact", cls: "text-[#8a8272]" };
}

export interface QuickPicksProps {
  appliedIds: Set<string>;
  onApply: (id: string, label: string, costInr: number, proposal: Proposal) => void;
  onRemove: (id: string) => void;
  onShow: (proposal: Proposal, label: string) => void;
  onExplain: (message: string) => void;
}

export default function QuickPicks({ appliedIds, onApply, onRemove, onShow, onExplain }: QuickPicksProps) {
  const project = useEditor((s) => s.project);
  const baseline = project?.baselineRun ?? null;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [aiScored, setAiScored] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<Record<string, VerifiedPick | "running">>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    if (!project || !baseline) return;
    setBusy(true);
    setRows(null);
    setVerified({});
    setShowAll(false);
    const cands = generateCandidates(project, baseline);
    let scores: Record<string, CandidateScore> | null = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch("/api/ai/jev/quickpicks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          candidates: cands,
          local: compactIntel(useIntel.getState().intel),
          context: {
            site: project.name,
            night: { name: baseline.scenario.name, startTime: baseline.scenario.startTime, ambientVisibility: baseline.scenario.ambientVisibility },
            metrics: {
              incidents: baseline.metrics.dramaIncidents,
              blindSpotIncidents: baseline.metrics.blindSpotIncidents,
              perpsCaughtPct: baseline.metrics.perpsCaughtPct,
              medianResponseSec: baseline.metrics.dramaMedianResponseSec,
              cctvCoveragePct: baseline.metrics.cctvCoveragePct,
              pathLenLitPct: baseline.metrics.pathLenLitPct,
            },
          },
        }),
      }).finally(() => clearTimeout(timer));
      const json = await res.json();
      if (json.ok) scores = json.data.scores;
    } catch {
      /* fall back below */
    }
    const ranked = cands
      .map((c) => ({ ...c, score: scores?.[c.id] ?? heuristicScore(c) }))
      .sort((a, b) => b.score.rank - a.score.rank || a.costInr - b.costInr);
    setRows(ranked);
    setAiScored(!!scores);
    setBusy(false);

    // stage 2: measured effect of the top 3 (same seed, one change at a time)
    // (off the main thread in a Web Worker; results stream in as each finishes)
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const top = ranked.slice(0, 3);
    setProgress({ done: 0, total: top.length });
    await verifyCandidatesStreaming(baseline, top, {
      signal: ctrl.signal,
      onStart: (id) => setVerified((v) => ({ ...v, [id]: "running" })),
      onResult: (id, v) => {
        setVerified((cur) => ({ ...cur, [id]: v }));
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      },
    });
    if (!ctrl.signal.aborted) setProgress(null);
  };

  // fresh baseline → fresh picks, automatically the next time the panel is open
  const panelOpen = useEditor((s) => s.assistantOpen);
  const baselineKey = baseline ? `${baseline.seed}:${baseline.events.length}:${baseline.metrics.dramaIncidents}` : null;
  const rankedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!baselineKey) {
      setRows(null);
      rankedFor.current = null;
      return;
    }
    if (panelOpen && rankedFor.current !== baselineKey) {
      rankedFor.current = baselineKey;
      void run();
    }
  }, [baselineKey, panelOpen]);

  const intel = useIntel((s) => s.intel);
  const localCompact = compactIntel(intel);
  const localTag = (r: { kind: string; incidentType?: string }) => localTagFor(r.kind, localCompact, r.incidentType);

  const explain = () => {
    if (!rows) return;
    const lines = rows.slice(0, 3).map((r, i) => {
      const v = verified[r.id];
      const m = v && v !== "running" ? `simulated risk ${v.riskBefore} → ${v.riskAfter}${v.riskPerLakh !== null ? ` (${v.riskPerLakh} per ₹1 lakh)` : ""}` : "not yet simulated";
      const lt = localTag(r);
      return `${i + 1}. ${r.label} — cost ${fmtInr(r.costInr)}, judged impact ${Math.round(r.score.impact * 100)}%, redundancy ${Math.round(r.score.redundant * 100)}%, ${m}${lt ? `, addresses local factor: ${lt}` : ""}`;
    });
    const ctx = localCompact ? `\n${localLine(localCompact)} Tie each pick to the local risk factors where relevant.` : "";
    onExplain(
      `Explain these recommended fixes and recommend the best value one. A fast AI judgment ranked them and the simulation measured the effect (same seed, one change at a time):\n${lines.join("\n")}${ctx}`
    );
  };

  if (!project) return null;

  if (!baseline) {
    return (
      <section className="rounded-xl border border-dashed border-[#cfd8d4] bg-[#f7faf9] p-4 text-center" data-testid="jev-quickpicks">
        <div className="text-2xl">🌙</div>
        <div className="mt-1 text-sm font-semibold text-[#1d2430]">Simulate a night first</div>
        <p className="mx-auto mt-1 max-w-[260px] text-[11px] leading-snug text-[#5c6470]">
          The planner looks at what went wrong in your society's simulated night, then suggests fixes that target it.
        </p>
        <Button
          size="sm"
          className="mt-3 h-8 bg-[#0f766e] text-xs text-white hover:bg-[#115e59]"
          disabled={baselineBusy}
          onClick={async () => {
            setBaselineBusy(true);
            try {
              await runBaseline();
            } finally {
              setBaselineBusy(false);
            }
          }}
        >
          {baselineBusy ? "Simulating…" : "▶ Run tonight's simulation"}
        </Button>
      </section>
    );
  }

  const visible = rows ? (showAll ? rows : rows.slice(0, SHOWN)) : [];

  return (
    <section data-testid="jev-quickpicks">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-bold text-[#1d2430]">Recommended fixes</h3>
          <p className="text-[10.5px] text-[#6b7280]">Ranked for your society's last simulated night</p>
        </div>
        <button
          onClick={run}
          disabled={busy}
          className="shrink-0 rounded-md px-2 py-1 text-[10.5px] font-medium text-[#0f766e] hover:bg-[#e6f4f1] disabled:opacity-50"
          title="Re-rank the fixes"
        >
          {busy ? "Ranking…" : "↻ Refresh"}
        </button>
      </div>

      {busy && (
        <div className="mt-2 space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[62px] animate-pulse rounded-lg bg-[#f1efe9]" />
          ))}
        </div>
      )}

      {progress && (
        <div className="mt-2" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <div className="flex justify-between text-[10px] text-[#6b7280]">
            <span>Testing the top {progress.total} on the same night…</span>
            <span>
              {progress.done}/{progress.total}
            </span>
          </div>
          <div className="mt-0.5 h-1 overflow-hidden rounded bg-[#e6f4f1]">
            <div className="h-full bg-[#0f766e] transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        </div>
      )}

      {rows && rows.length === 0 && (
        <p className="mt-2 rounded-lg bg-[#f7faf9] px-3 py-2 text-[11px] text-[#5c6470]">No obvious gaps found on this night — try asking the planner below.</p>
      )}

      {rows && rows.length > 0 && (
        <ol className="mt-2 space-y-1.5">
          {visible.map((r, i) => {
            const v = verified[r.id];
            const isApplied = appliedIds.has(r.id);
            const imp = impactWord(r.score.impact);
            const lt = localTag(r);
            const proposal = candidateProposal(r);
            return (
              <li
                key={r.id}
                className={cn(
                  "group rounded-lg border bg-white p-2.5 transition",
                  isApplied ? "border-[#5eb8a8] bg-[#f3fbf9] shadow-[inset_3px_0_0_#0f766e]" : "border-[#e8e4da] hover:border-[#b9d9d2]"
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#f4f2ec] text-sm" aria-hidden>
                    {KIND_ICON[r.kind]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[11.5px] font-semibold leading-snug text-[#1d2430]">
                        {i === 0 && !isApplied && <span className="mr-1 text-[#b45309]">★</span>}
                        {cleanLabel(r.label)}
                      </div>
                      <div className="shrink-0 text-[11px] font-semibold text-[#1d2430]">{r.costInr > 0 ? fmtInr(r.costInr) : "Free"}</div>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-[#6b7280]">
                      <span className={cn("font-medium", imp.cls)}>{imp.word}</span>
                      <span>{KIND_NAME[r.kind]}</span>
                      {r.evidence.incidentsNear > 0 && r.kind !== "guard" && r.kind !== "patrol" && (
                        <span>
                          {r.evidence.incidentsNear} incident{r.evidence.incidentsNear === 1 ? "" : "s"} nearby
                        </span>
                      )}
                      {r.score.redundant >= 0.5 && <span className="text-[#b45309]">may overlap existing coverage</span>}
                      {lt && (
                        <span className="text-[#2e7d5b]" data-testid="local-tag" title="Matches a local risk factor from Local Intel">
                          ◎ local: {lt}
                        </span>
                      )}
                    </div>
                    {v && (
                      <div className="mt-1 text-[10.5px]">
                        {v === "running" ? (
                          <span className="text-[#8a8272]">⏳ Testing on the same night…</span>
                        ) : v.riskReduced > 0 ? (
                          <span className="font-medium text-[#0f766e]">
                            ✓ Tested: risk {v.riskBefore} → {v.riskAfter}
                            {v.caughtDelta > 0 ? ` · ${v.caughtDelta} more caught` : ""}
                          </span>
                        ) : (
                          <span className="text-[#8a8272]">
                            Tested: no change in risk on this night ({v.riskBefore} → {v.riskAfter})
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {isApplied ? (
                        <>
                          <span className="text-[10.5px] font-semibold text-[#0f766e]">✓ Added to your plan</span>
                          <button
                            onClick={() => onShow(proposal, cleanLabel(r.label))}
                            className="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-[#0f766e] hover:bg-[#e6f4f1]"
                          >
                            ⌖ Show
                          </button>
                          <button onClick={() => onRemove(r.id)} className="rounded px-1.5 py-0.5 text-[10.5px] text-[#a33] hover:bg-[#fdf1f1]">
                            Remove
                          </button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            className="h-6 bg-[#0f766e] px-2.5 text-[10.5px] text-white hover:bg-[#115e59]"
                            onClick={() => onApply(r.id, cleanLabel(r.label), r.costInr, proposal)}
                          >
                            + Add to plan
                          </Button>
                          <button
                            onClick={() => onShow(proposal, cleanLabel(r.label))}
                            className="rounded px-1.5 py-0.5 text-[10.5px] text-[#5c6470] hover:bg-[#f4f2ec]"
                            title="Fly the map to where this would go"
                          >
                            ⌖ Show on map
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {rows && rows.length > SHOWN && (
        <button onClick={() => setShowAll((x) => !x)} className="mt-1.5 w-full rounded-md py-1 text-[10.5px] font-medium text-[#5c6470] hover:bg-[#f4f2ec]">
          {showAll ? "Show fewer" : `Show ${rows.length - SHOWN} more options`}
        </button>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[9.5px] text-[#9a9384]">{aiScored ? "Ranked by AI, tested in the simulation" : "Ranked by built-in rules (AI unavailable)"}</span>
          <button onClick={explain} className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-[#2e5b7d] hover:bg-[#eef3f8]">
            ✦ Explain these
          </button>
        </div>
      )}
    </section>
  );
}
