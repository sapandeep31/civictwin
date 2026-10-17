"use client";

/**
 * Results dashboard + baseline/intervention comparison.
 * Every number is computed from the stored runs — never hardcoded.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { ablateStreaming } from "@/lib/sim/verifyClient";
import { fmtInr, getCachedAblation, headlineDiff, planCostInr, riskIndex, RISK_EXPLAINER, type AblationResult } from "@/lib/sim/compare";
import { eventTypeLabel } from "@/lib/sim/labels";
import type { StoredRun } from "@/lib/world/types";

const SameNightReplay = dynamic(() => import("./SameNightReplay"), { ssr: false });
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/store/editor";
import { compareRuns, fmtMetric } from "@/lib/sim/metrics";
import { loadStoredRun } from "@/lib/run-actions";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
} from "recharts";

function MetricCard({
  label,
  value,
  sub,
  tone = "neutral",
  tag,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "bad" | "neutral";
  tag?: string;
}) {
  const toneCls =
    tone === "good"
      ? "text-[#2e7d5b]"
      : tone === "warn"
        ? "text-[#b98a2f]"
        : tone === "bad"
          ? "text-[#c23b3b]"
          : "text-[#1d2430]";
  return (
    <div className="rounded-lg border border-[#e3ded4] bg-white p-3">
      <div className="flex items-start justify-between gap-1">
        <div className="text-[10px] font-medium uppercase tracking-wide text-[#8a8272]">{label}</div>
        {tag && <span className="rounded bg-[#f1ede4] px-1 py-0.5 text-[8px] uppercase text-[#8a8272]">{tag}</span>}
      </div>
      <div className={`mt-1 text-xl font-bold ${toneCls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] leading-tight text-[#8a8272]">{sub}</div>}
    </div>
  );
}

function pctTone(v: number, goodHigh = true): "good" | "warn" | "bad" {
  const t = goodHigh ? v : 100 - v;
  return t >= 70 ? "good" : t >= 40 ? "warn" : "bad";
}

export function ResultsDialog() {
  const open = useEditor((s) => s.resultsOpen);
  const setOpen = useEditor((s) => s.setResultsOpen);
  const project = useEditor((s) => s.project);
  const runKind = useEditor((s) => s.runKind);
  const setCompareOpen = useEditor((s) => s.setCompareOpen);
  const activeRun = useEditor((s) => s.activeRun);

  const run = runKind === "intervention" ? project?.interventionRun : project?.baselineRun;
  const m = run?.metrics;

  const eventsOverTime = useMemo(() => {
    if (!run) return [];
    const dur = run.scenario.durationSec;
    const step = Math.max(30, Math.round(dur / 40));
    const out: { t: number; cumulative: number }[] = [];
    for (let t = step; t <= dur; t += step) {
      out.push({ t, cumulative: run.events.filter((e) => e.tSec <= t).length });
    }
    return out;
  }, [run]);

  const typeData = useMemo(() => {
    if (!m) return [];
    return Object.entries(m.eventsByType).map(([type, n]) => ({ type: eventTypeLabel(type), count: n }));
  }, [m]);

  if (!project || !m || !run) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Results</DialogTitle>
            <DialogDescription>Simulation results and metric breakdown.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-[#5c6470]">
            <p>No simulation results yet. Run a baseline simulation from the top bar first.</p>
            <p className="text-xs text-[#8a8272]">
              The baseline preserves the exact world, scenario and seed used — later edits never
              silently rewrite it.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[88vh] overflow-y-auto bg-[#f7f5f1] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#1d2430]">
            {run.label === "baseline" ? "Tonight's results — today's setup" : "Results — with your plan"} (simulated)
            <span className="rounded bg-[#eef4f0] px-2 py-0.5 text-[10px] font-medium text-[#2e7d5b]">
              seed {run.seed} · engine {run.engineVersion}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs text-[#5c6470]">
            Detailed safety metrics, lit path coverage, and incident breakdown for this simulation run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {run.label === "baseline" && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#cfe2d7] bg-[#eef4f0] px-3 py-2.5">
              <div className="text-[13px] text-[#1d2430]">
                <span className="font-semibold">{m.dramaIncidents ?? m.eventsTotal} incidents</span> on this simulated night ·{" "}
                {m.perpsCaughtPct ?? m.resolutionRatePct}% of offenders caught. Find the cheapest fixes that change this.
              </div>
              <Button
                size="sm"
                className="h-8 bg-[#0f766e] text-xs text-white hover:bg-[#115e59]"
                onClick={() => {
                  setOpen(false);
                  useEditor.getState().setAssistantOpen(true);
                }}
              >
                ✦ Find fixes with the AI planner
              </Button>
            </div>
          )}
          {/* metric cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricCard
              label="Lit path coverage"
              value={`${m.pathLenLitPct.toFixed(1)}%`}
              sub={`${m.poorlyLitSegments}/${m.segmentsTotal} segments below 50%`}
              tone={pctTone(m.pathLenLitPct)}
              tag="modeled"
            />
            <MetricCard
              label="CCTV coverage"
              value={`${m.cctvCoveragePct.toFixed(1)}%`}
              sub={`${m.uncoveredSegments} segments with no coverage`}
              tone={pctTone(m.cctvCoveragePct)}
              tag="modeled"
            />
            <MetricCard
              label="Est. avg response"
              value={m.avgResponseSec !== null ? `${m.avgResponseSec} s` : "—"}
              sub={m.medianResponseSec !== null ? `median ${m.medianResponseSec} s` : "no responses"}
              tone={m.avgResponseSec === null ? "neutral" : m.avgResponseSec < 150 ? "good" : m.avgResponseSec < 300 ? "warn" : "bad"}
              tag="estimated"
            />
            <MetricCard
              label="Resolution rate"
              value={`${m.resolutionRatePct.toFixed(1)}%`}
              sub={`${m.unresolvedEvents} unresolved of ${m.eventsTotal}`}
              tone={pctTone(m.resolutionRatePct)}
              tag="simulated"
            />
            <MetricCard
              label="Reachable trips"
              value={`${m.tripsReachablePct.toFixed(1)}%`}
              sub={`${m.unreachableTrips} unreachable`}
              tone={pctTone(m.tripsReachablePct)}
              tag="simulated"
            />
            <MetricCard
              label="Route completion"
              value={`${m.routeCompletionPct.toFixed(1)}%`}
              sub={`avg route ${m.avgRouteLengthM} m`}
              tone={pctTone(m.routeCompletionPct)}
              tag="simulated"
            />
            <MetricCard
              label="Events reached"
              value={`${m.eventsReachedPct.toFixed(1)}%`}
              sub={`${m.unreachableEvents} unreachable events`}
              tone={pctTone(m.eventsReachedPct)}
              tag="simulated"
            />
            <MetricCard
              label="Patrol coverage"
              value={m.patrolCoveragePct !== null ? `${m.patrolCoveragePct.toFixed(1)}%` : "—"}
              sub="walkable length within 40 m of patrol waypoints"
              tone={m.patrolCoveragePct === null ? "neutral" : pctTone(m.patrolCoveragePct)}
              tag="modeled"
            />
          </div>

          {/* charts */}
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-[#e3ded4] bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-[#1d2430]">Cumulative simulated events over time</div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={eventsOverTime} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
                    <CartesianGrid stroke="#eee9df" />
                    <XAxis dataKey="t" tick={{ fontSize: 10 }} unit="s" />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="cumulative" stroke="#b98a2f" strokeWidth={2} dot={false} name="events" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="rounded-lg border border-[#e3ded4] bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-[#1d2430]">Events by type (fictional scenario events)</div>
              <div className="h-44">
                {typeData.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-[#8a8272]">No simulated events occurred.</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={typeData} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
                      <CartesianGrid stroke="#eee9df" />
                      <XAxis dataKey="type" tick={{ fontSize: 9 }} interval={0} angle={-14} textAnchor="end" height={44} />
                      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                      <Tooltip contentStyle={{ fontSize: 11 }} />
                      <Bar dataKey="count" fill="#1d2430" radius={[3, 3, 0, 0]} name="events" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* assumptions */}
          <details className="rounded-lg border border-[#e3ded4] bg-white p-3 text-[11px] leading-relaxed text-[#5c6470]">
            <summary className="cursor-pointer text-xs font-semibold text-[#1d2430]">How these numbers are modelled (assumptions &amp; limits)</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Lighting: illumination = Σ brightness·(1−d/radius)<sup>1.5</sup> over active lamps; the lit
                threshold rises as ambient visibility ({Math.round(run.scenario.ambientVisibility * 100)}%) falls. A geometric
                approximation — not a photometric assessment.
              </li>
              <li>CCTV: a point is “covered” when within range × {run.scenario.cctvRangeScale.toFixed(2)} and the horizontal FOV cone. Coverage ≠ detection.</li>
              <li>Events: seeded Poisson process at {run.scenario.eventsPerHour}/h expected — fictional scenario events, not crime predictions.</li>
              <li>Response times: estimated from network travel distance at {run.scenario.guardSpeed} m/s; unreachable or unguarded cases are recorded explicitly, never averaged in.</li>
              <li>Outcomes depend on scenario parameters, synthetic agents and geometry quality. Higher modeled coverage does not prove real crime reduction.</li>
            </ul>
          </details>

          {/* actions */}
          <div className="flex flex-wrap items-center gap-2">
            {activeRun?.id === run.id ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  loadStoredRun(run.label);
                }}
              >
                Replay this run in the 3D view
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  loadStoredRun(run.label);
                }}
              >
                Load this run in the 3D view
              </Button>
            )}
            {project.interventionRun && (
              <Button
                size="sm"
                className="bg-[#2e7d5b] text-white hover:bg-[#276c4f]"
                onClick={() => {
                  setOpen(false);
                  setCompareOpen(true);
                }}
              >
                Compare with baseline
              </Button>
            )}
            <span className="ml-auto font-mono text-[10px] text-[#8a8272]">run {run.id}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

export function CompareDialog() {
  const open = useEditor((s) => s.compareOpen);
  const setOpen = useEditor((s) => s.setCompareOpen);
  const project = useEditor((s) => s.project);
  const setResultsOpen = useEditor((s) => s.setResultsOpen);

  const baseline = project?.baselineRun;
  const intervention = project?.interventionRun;

  const rows = useMemo(
    () => (baseline && intervention ? compareRuns(baseline.metrics, intervention.metrics) : []),
    [baseline, intervention]
  );
  const headline = useMemo(
    () => (baseline && intervention ? headlineDiff(baseline, intervention) : null),
    [baseline, intervention]
  );
  // Two extra WebGL canvases are only mounted while the dialog is open.
  const [showReplay, setShowReplay] = useState(true);
  useEffect(() => {
    if (!open) setShowReplay(true);
  }, [open]);

  const chartData = useMemo(
    () =>
      rows
        .filter((r) => r.kind === "pct")
        .map((r) => ({
          metric: r.label.replace("Modeled ", "").replace(" (simulated)", ""),
          Baseline: parseFloat(r.baseline) || 0,
          Intervention: parseFloat(r.intervention) || 0,
        })),
    [rows]
  );

  if (!baseline || !intervention) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Compare runs</DialogTitle>
            <DialogDescription>Comparison between baseline and intervention simulation runs.</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-[#5c6470]">
            You need both a baseline and an intervention run. Run a baseline first, change the
            neighborhood or scenario, then “Run intervention” — it reuses the baseline seed for a
            genuine like-for-like comparison.
          </p>
        </DialogContent>
      </Dialog>
    );
  }

  // one cost figure everywhere (plan bar, this view, the table, the report)
  const cost: number | null = planCostInr(baseline, intervention);
  const riskBefore = riskIndex(baseline.events);
  const riskAfter = riskIndex(intervention.events);
  const net = Math.round((riskBefore - riskAfter) * 10) / 10;
  const verdict = net > 0.05 ? "better" : net < -0.05 ? "worse" : "same";
  const litDelta = intervention.metrics.pathLenLitPct - baseline.metrics.pathLenLitPct;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[92vh] overflow-y-auto bg-[#f7f5f1] sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="text-[#1d2430]">Same night: today&apos;s setup vs your plan</DialogTitle>
          <DialogDescription className="text-xs text-[#5c6470]">
            Both runs replay the same simulated night — the same people, the same offenders. Only your changes differ.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* overall verdict first — it must agree with the "All changes together" row below */}
          <div
            className={`rounded-lg border px-4 py-3 ${
              verdict === "better" ? "border-[#bfe0cf] bg-[#eef7f2]" : verdict === "worse" ? "border-[#f0c9c9] bg-[#fdf3f3]" : "border-[#e3ded4] bg-white"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[#8a8272]">
              Overall (simulated)
              <span className={`rounded px-1.5 py-0.5 text-[9px] text-white ${verdict === "better" ? "bg-[#2e7d5b]" : verdict === "worse" ? "bg-[#c23b3b]" : "bg-[#8a8272]"}`}>
                {verdict === "better" ? "safer night" : verdict === "worse" ? "riskier night — rethink the plan" : "no clear change"}
              </span>
            </div>
            <div className="mt-0.5 text-lg font-bold text-[#1d2430]">
              Risk {riskBefore} → {riskAfter}
              {cost ? <span className="font-medium text-[#5c6470]"> · {fmtInr(cost)}</span> : <span className="font-medium text-[#5c6470]"> · free</span>}
            </div>
            {headline && (
              <div className="mt-1 text-[13px] text-[#1d2430]">
                <span className="text-[#8a8272]">Biggest single change: </span>
                {headline.text}
              </div>
            )}
          </div>

          {showReplay ? (
            <SameNightReplay baseline={baseline} intervention={intervention} headline={headline} />
          ) : (
            <button
              onClick={() => setShowReplay(true)}
              className="w-full rounded-lg border border-dashed border-[#8a8272] bg-white py-6 text-sm font-medium text-[#1d2430] hover:bg-[#faf8f4]"
            >
              ▶ Play the split-screen replay
            </button>
          )}

          <CostEffectTable baseline={baseline} intervention={intervention} />
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded bg-white px-2 py-1 font-mono text-[#5c6470]">
              baseline seed {baseline.seed}
            </span>
            <span className="rounded bg-white px-2 py-1 font-mono text-[#5c6470]">
              intervention seed {intervention.seed}
            </span>
            {baseline.seed === intervention.seed ? (
              <span className="rounded bg-[#eef4f0] px-2 py-1 font-medium text-[#2e7d5b]">
                Same seed — like-for-like comparison
              </span>
            ) : (
              <span className="rounded bg-[#fdf6e7] px-2 py-1 font-medium text-[#7a5d1e]">
                Different seeds — interpret with care
              </span>
            )}
            {cost !== null && (
              <span className="rounded bg-white px-2 py-1 text-[#5c6470]">
                Est. cost <b className="text-[#1d2430]">INR {cost.toLocaleString("en-IN")}</b>
              </span>
            )}
          </div>

          <div className="h-56 rounded-lg border border-[#e3ded4] bg-white p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 10, bottom: 0, left: -14 }}>
                <CartesianGrid stroke="#eee9df" />
                <XAxis dataKey="metric" tick={{ fontSize: 9 }} interval={0} />
                <YAxis tick={{ fontSize: 10 }} unit="%" />
                <Tooltip contentStyle={{ fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Baseline" fill="#8a8272" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Intervention" fill="#2e7d5b" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-hidden rounded-lg border border-[#e3ded4] bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#e3ded4] bg-[#faf8f4] text-left text-[10px] uppercase tracking-wide text-[#8a8272]">
                  <th className="px-3 py-2 font-medium">Metric</th>
                  <th className="px-3 py-2 text-right font-medium">Baseline</th>
                  <th className="px-3 py-2 text-right font-medium">Intervention</th>
                  <th className="px-3 py-2 text-right font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const b = baseline.metrics[r.key] as number | null;
                  const i = intervention.metrics[r.key] as number | null;
                  const improved =
                    b !== null && i !== null
                      ? r.betterWhenLower
                        ? i < b - 0.05
                        : i > b + 0.05
                      : false;
                  const worsened =
                    b !== null && i !== null
                      ? r.betterWhenLower
                        ? i > b + 0.05
                        : i < b - 0.05
                      : false;
                  return (
                    <tr key={String(r.key)} className="border-b border-[#f1ede4] last:border-0">
                      <td className="px-3 py-1.5 text-[#1d2430]">{r.label}</td>
                      <td className="px-3 py-1.5 text-right text-[#5c6470]">{r.baseline}</td>
                      <td className="px-3 py-1.5 text-right text-[#5c6470]">{r.intervention}</td>
                      <td
                        className={`px-3 py-1.5 text-right font-medium ${
                          improved ? "text-[#2e7d5b]" : worsened ? "text-[#c23b3b]" : "text-[#8a8272]"
                        }`}
                      >
                        {r.delta}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="rounded-lg border border-[#e3ded4] bg-white p-3 text-[11px] leading-relaxed text-[#5c6470]">
            <b className="text-[#1d2430]">How to read this:</b> absolute values are shares of the
            modeled walkable network or simulated outcomes; “pp” = percentage-point change. Higher
            modeled coverage does not prove a real reduction in crime — results depend on scenario
            parameters, synthetic agents, geometry quality and simplified assumptions.
            {cost !== null && litDelta > 0.05 && (
              <> Cost per percentage point of modeled lit coverage added: ≈ INR {Math.round(cost / litDelta).toLocaleString("en-IN")}.</>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => { setOpen(false); setResultsOpen(true); }}>
              Open full results
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setOpen(false);
                loadStoredRun("baseline");
              }}
            >
              Replay baseline in 3D
            </Button>
            <Button
              size="sm"
              className="bg-[#2e7d5b] text-white hover:bg-[#276c4f]"
              onClick={() => {
                setOpen(false);
                loadStoredRun("intervention");
              }}
            >
              Replay intervention in 3D
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Risk reduced per ₹ — honest per-change ablation                     */
/* ------------------------------------------------------------------ */

function signed(n: number, unit = ""): string {
  if (n === 0) return "—";
  return `${n > 0 ? "+" : "−"}${Math.abs(n)}${unit}`;
}

export function CostEffectTable({ baseline, intervention }: { baseline: StoredRun; intervention: StoredRun }) {
  const [res, setRes] = useState<AblationResult | null>(() => getCachedAblation(intervention.id));
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    let alive = true;
    if (getCachedAblation(intervention.id)) {
      setRes(getCachedAblation(intervention.id));
      return;
    }
    setRes(null);
    setProgress(null);
    // let the dialog paint first; re-runs happen in a Web Worker (chunked main-thread fallback)
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      void ablateStreaming(baseline, intervention, {
        signal: ctrl.signal,
        onProgress: (done, total) => alive && setProgress({ done, total }),
      }).then((r) => alive && r && setRes(r));
    }, 50);
    return () => {
      alive = false;
      ctrl.abort();
      clearTimeout(id);
    };
  }, [baseline, intervention]);

  return (
    <div className="overflow-hidden rounded-lg border border-[#e3ded4] bg-white">
      <div className="flex items-baseline justify-between gap-2 border-b border-[#e3ded4] bg-[#faf8f4] px-3 py-2">
        <div className="text-xs font-semibold text-[#1d2430]">Risk reduced per ₹ — which change earns its cost?</div>
        <div className="text-[10px] text-[#8a8272]">simulated estimates · each change re-run alone on the same night</div>
      </div>
      {!res ? (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-[#5c6470]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#2e7d5b]" /> Re-running the baseline once per change (same seed)…{progress && progress.total > 0 ? ` ${progress.done}/${progress.total}` : ""}
        </div>
      ) : res.rows.length === 0 ? (
        <div className="px-3 py-4 text-xs text-[#5c6470]">No physical changes between the two runs (only scenario settings differ).</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[#e3ded4] text-left text-[10px] uppercase tracking-wide text-[#8a8272]">
              <th className="px-3 py-1.5 font-medium">#</th>
              <th className="px-3 py-1.5 font-medium">Change</th>
              <th className="px-3 py-1.5 text-right font-medium">Est. cost</th>
              <th className="px-3 py-1.5 text-right font-medium">Risk reduced</th>
              <th className="px-3 py-1.5 text-right font-medium">Per ₹1 lakh</th>
              <th className="px-3 py-1.5 text-right font-medium">Incidents avoided</th>
              <th className="px-3 py-1.5 text-right font-medium">Extra caught</th>
              <th className="px-3 py-1.5 text-right font-medium">Blind-spot cases removed</th>
              <th className="px-3 py-1.5 text-right font-medium">Response saved</th>
            </tr>
          </thead>
          <tbody>
            {[...res.rows, res.combined].map((r, i) => {
              const all = r.id === "all";
              // a paid change that made the night worse on its own is the one to drop first
              const drop = !all && r.costInr > 0 && r.riskReduced < 0;
              const dud = !all && r.costInr > 0 && r.riskReduced === 0 && !r.responseSavedSec;
              return (
                <tr key={r.id} className={`border-b border-[#f1ede4] last:border-0 ${all ? "bg-[#faf8f4] font-semibold" : drop ? "bg-[#fdf3f3]" : ""}`}>
                  <td className="px-3 py-1.5 text-[#8a8272]">{all ? "Σ" : i + 1}</td>
                  <td className="px-3 py-1.5 text-[#1d2430]">
                    {r.label}
                    {drop && <span className="ml-1.5 text-[10px] font-semibold text-[#c23b3b]">✕ made it worse — drop it</span>}
                    {dud && <span className="ml-1.5 text-[10px] text-[#8a8272]">no effect on this night</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right text-[#5c6470]">{r.costInr ? fmtInr(r.costInr) : "free"}</td>
                  <td className={`px-3 py-1.5 text-right ${r.riskReduced > 0 ? "text-[#2e7d5b]" : r.riskReduced < 0 ? "text-[#c23b3b]" : "text-[#8a8272]"}`}>
                    {r.riskReduced === 0 ? "—" : `${r.riskReduced > 0 ? "−" : "+"}${Math.abs(r.riskReduced)} pts`}
                  </td>
                  <td className="px-3 py-1.5 text-right text-[#1d2430]">
                    {r.riskPerLakh === null ? (r.riskReduced > 0 ? "∞ (free)" : "—") : r.riskPerLakh > 0 ? r.riskPerLakh.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right text-[#5c6470]">{signed(r.incidentsPrevented)}</td>
                  <td className="px-3 py-1.5 text-right text-[#5c6470]">{signed(r.caughtDelta)}</td>
                  <td className="px-3 py-1.5 text-right text-[#5c6470]">{signed(r.blindSpotRemoved)}</td>
                  <td className="px-3 py-1.5 text-right text-[#5c6470]">{r.responseSavedSec === null ? "—" : signed(r.responseSavedSec, " s")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="border-t border-[#f1ede4] px-3 py-2 text-[10px] leading-snug text-[#8a8272]">
        {RISK_EXPLAINER} Baseline risk: {res?.baselineRisk ?? "…"} pts. Single-change effects need not add up to the combined
        effect (changes interact). Costs are standard estimates (excl. tax, civil works, maintenance). Simulated, not a crime prediction.
        {res?.truncated && " Only the first 14 changes were tested individually."}
      </p>
    </div>
  );
}
