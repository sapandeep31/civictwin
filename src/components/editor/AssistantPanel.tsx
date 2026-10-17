"use client";

/**
 * AI planner panel: recommended fixes + free-text requests. Nothing changes the
 * society without an explicit "Add to plan". Every added change stacks on the
 * others, can be removed on its own, and the 3D view flies to where it landed.
 * Falls back to deterministic recommendations when no AI provider is available
 * — and labels that honestly.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/store/editor";
import { applyAiProposal, proposalFocusPoints, revertAiChange, runIntervention, type AppliedChange } from "@/lib/run-actions";
import { describeOps, type Proposal } from "@/lib/ai/schema";
import { cn } from "@/lib/utils";
import { useIntel } from "@/lib/ai/intelStore";
import { useFocus } from "@/lib/store/focus";
import { fmtInr } from "@/lib/sim/compare";
import QuickPicks from "./QuickPicks";
import IntelChip from "./IntelChip";
import { compactIntel } from "@/lib/ai/context";
import { postApi } from "@/lib/api/client";
import PanelSkeleton from "./PanelSkeleton";
import type { World } from "@/lib/world/types";

interface ProposeResponse {
  ok: boolean;
  error?: string;
  data?: {
    provider: "gemini" | "z-ai" | "rules";
    proposal: Proposal;
    estimatedCostInr: number;
    basis: string[];
  };
}

interface PlanEntry {
  key: string;
  label: string;
  costInr: number;
  change: AppliedChange;
}

const SUGGESTIONS = [
  "Fix the poorly lit walking paths",
  "Add lights around the bus stop",
  "Make the guard patrol cover the park entrance",
  "Give me three options at different budgets",
  "Why did guards take so long to respond?",
];

/** An entry is still live if the objects it added are still in the world (e.g. not undone with Ctrl+Z). */
const isLive = (c: AppliedChange, w: World) =>
  c.cameraIds.every((id) => w.cameras.some((o) => o.id === id)) && c.lightIds.every((id) => w.streetlights.some((o) => o.id === id));

export default function AssistantPanel() {
  const open = useEditor((s) => s.assistantOpen);
  const setOpen = useEditor((s) => s.setAssistantOpen);
  const project = useEditor((s) => s.project);
  const baselineRun = useEditor((s) => s.project?.baselineRun);
  const focusOn = useFocus((s) => s.focusOn);
  const panelRef = useRef<HTMLElement>(null);

  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposeResponse["data"] | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [plan, setPlan] = useState<PlanEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        const f = h?.features;
        if (f) setProviderStatus(f.aiProvider);
      })
      .catch(() => setProviderStatus(null));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // drop plan entries that were undone elsewhere
  const world = project?.world;
  const livePlan = useMemo(() => (world ? plan.filter((p) => isLive(p.change, world)) : []), [plan, world]);
  const baselineKey = baselineRun ? `${baselineRun.seed}:${baselineRun.events.length}:${baselineRun.metrics.dramaIncidents}` : "none";
  const pickPrefix = `qp|${baselineKey}|`;
  const appliedPickIds = useMemo(
    () => new Set(livePlan.filter((p) => p.key.startsWith(pickPrefix)).map((p) => p.key.slice(pickPrefix.length))),
    [livePlan, pickPrefix]
  );

  if (!project) return null;

  const insetRight = () => (open ? panelRef.current?.offsetWidth ?? 400 : 0);

  const show = (proposal: Proposal, label: string) => {
    focusOn({ points: proposalFocusPoints(proposal, useEditor.getState().project ?? project), label, tone: "preview", insetRight: insetRight() });
  };

  const addToPlan = (key: string, label: string, costInr: number, proposal: Proposal) => {
    const change = applyAiProposal(proposal);
    if (!change) return;
    setPlan((cur) => [...cur.filter((p) => p.key !== key), { key, label, costInr, change }]);
    focusOn({ points: change.points, label, tone: "added", insetRight: insetRight() });
  };

  const removeFromPlan = (key: string) => {
    const entry = livePlan.find((p) => p.key === key);
    if (!entry) return;
    revertAiChange(entry.change);
    setPlan((cur) => cur.filter((p) => p.key !== key));
  };

  const request = async (msg: string) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await postApi<ProposeResponse["data"]>("/api/ai/propose", {
        project: {
          name: project.name,
          world: project.world,
          scenario: project.scenario,
        },
        baselineRun: baselineRun ? { metrics: baselineRun.metrics, events: baselineRun.events } : null,
        message: msg,
        localIntel: compactIntel(useIntel.getState().intel),
      });
      setResult(data ?? null);
      setResultKey(`ask|${Date.now()}`);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The planner request failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const rerun = async () => {
    setRunError(null);
    setRunning(true);
    await new Promise((r) => setTimeout(r, 30));
    try {
      await runIntervention();
      setOpen(false);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "The re-run failed.");
    } finally {
      setRunning(false);
    }
  };

  const resultApplied = !!resultKey && livePlan.some((p) => p.key === resultKey);
  const planCost = livePlan.reduce((s, p) => s + p.costInr, 0);
  const rulesOnly = providerStatus === "none" || providerStatus === "rules";

  return (
    <aside
      ref={panelRef}
      className={cn(
        "fixed right-0 top-0 z-50 flex h-full w-[400px] max-w-[92vw] flex-col border-l border-[#e3ded4] bg-[#fcfbf8] shadow-2xl transition-transform duration-200",
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      )}
      aria-label="Planning assistant"
      aria-hidden={!open}
    >
      {/* header */}
      <div className="border-b border-[#e8e4da] bg-white px-4 pb-3 pt-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-bold text-[#1d2430]">✦ AI planner</div>
            <div className="mt-0.5 text-[11px] leading-snug text-[#6b7280]">Find the fixes that make your society safer at night. Nothing changes until you add it.</div>
          </div>
          <button onClick={() => setOpen(false)} className="rounded p-1 text-[#8a8272] hover:bg-[#f1ede4]" aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </div>
        <ol className="mt-3 grid grid-cols-3 gap-1.5 text-[10px] leading-tight">
          {[
            ["1", "Pick fixes", !!baselineRun],
            ["2", "See them on the map", livePlan.length > 0],
            ["3", "Re-run & compare", !!project.interventionRun],
          ].map(([n, t, done]) => (
            <li key={n as string} className={cn("flex items-center gap-1.5 rounded-md px-2 py-1.5", done ? "bg-[#e6f4f1] text-[#0f766e]" : "bg-[#f4f2ec] text-[#6b7280]")}>
              <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold", done ? "bg-[#0f766e] text-white" : "bg-white text-[#6b7280]")}>{n}</span>
              <span className="font-medium">{t}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <IntelChip />

        <QuickPicks
          appliedIds={appliedPickIds}
          onApply={(id, label, cost, proposal) => addToPlan(pickPrefix + id, label, cost, proposal)}
          onRemove={(id) => removeFromPlan(pickPrefix + id)}
          onShow={show}
          onExplain={(m) => request(m)}
        />

        {/* ask */}
        <section>
          <h3 className="text-[13px] font-bold text-[#1d2430]">Ask the planner</h3>
          <p className="text-[10.5px] text-[#6b7280]">Describe a problem in your own words — get a costed plan back.</p>
          <form
            className="mt-2 rounded-lg border border-[#dcd6c8] bg-white focus-within:border-[#0f766e]"
            onSubmit={(e) => {
              e.preventDefault();
              if (!loading) request(message);
            }}
          >
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, 600))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!loading) request(message);
                }
              }}
              placeholder="e.g. The lane behind Block C feels unsafe after 10 pm"
              rows={2}
              className="block w-full resize-none rounded-t-lg bg-transparent px-2.5 py-2 text-xs focus:outline-none"
            />
            <div className="flex items-center justify-between gap-1.5 border-t border-[#f0ece3] px-1.5 py-1.5">
              <button type="button" className="rounded px-1.5 py-1 text-[10.5px] text-[#5c6470] hover:bg-[#f4f2ec]" disabled={loading} onClick={() => request("")}>
                Analyze my project
              </button>
              <Button type="submit" size="sm" className="h-7 bg-[#1d2430] px-3 text-xs text-white hover:bg-[#2c3642]" disabled={loading || !message.trim()}>
                {loading ? "Thinking…" : "Ask ↵"}
              </Button>
            </div>
          </form>

          {!result && !loading && !error && (
            <div className="mt-2 flex flex-wrap gap-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setMessage(s);
                    request(s);
                  }}
                  className="rounded-full border border-[#e8e4da] bg-white px-2.5 py-1 text-left text-[10.5px] text-[#5c6470] hover:border-[#0f766e] hover:text-[#0f766e]"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {loading && (
            <div className="mt-2">
              <PanelSkeleton label="Reading your society and drafting a plan…" rows={4} />
            </div>
          )}

          {error && (
            <div className="mt-2 rounded-md border border-[#e6c1c1] bg-[#fdf1f1] px-3 py-2 text-xs text-[#a33]">
              {error}
              <button onClick={() => request(message)} className="ml-2 underline">
                retry
              </button>
            </div>
          )}

          {result && (
            <div className={cn("mt-2 rounded-lg border bg-white p-3", resultApplied ? "border-[#5eb8a8] shadow-[inset_3px_0_0_#0f766e]" : "border-[#e3ded4]")}>
              <div className="flex items-start justify-between gap-2">
                <div className="text-[13px] font-bold leading-snug text-[#1d2430]">{result.proposal.title}</div>
                {result.estimatedCostInr > 0 && <div className="shrink-0 text-[12px] font-semibold text-[#1d2430]">{fmtInr(result.estimatedCostInr)}</div>}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-[#5c6470]">{result.proposal.rationale}</p>

              {result.basis && result.basis.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 rounded-md bg-[#fdf9ef] py-1.5 pl-6 pr-2 text-[11px] text-[#7a5d1e]">
                  {result.basis.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}

              <div className="mt-2.5 text-[10px] font-semibold uppercase tracking-wider text-[#8a8272]">What changes ({result.proposal.ops.length})</div>
              <ol className="mt-1 space-y-0.5 text-[11px] text-[#1d2430]">
                {describeOps(result.proposal).map((line, i) => (
                  <li key={i} className="rounded bg-[#faf8f4] px-2 py-1">
                    {line}
                  </li>
                ))}
              </ol>

              {result.proposal.expectedEffects.length > 0 && (
                <>
                  <div className="mt-2.5 text-[10px] font-semibold uppercase tracking-wider text-[#8a8272]">Expected effect</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-[#5c6470]">
                    {result.proposal.expectedEffects.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </>
              )}
              {result.proposal.limitations.length > 0 && (
                <details className="mt-2 text-[11px] text-[#8a8272]">
                  <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider">Limitations</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {result.proposal.limitations.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
              {result.proposal.costNotes && <p className="mt-2 rounded bg-[#faf8f4] px-2 py-1 text-[10px] text-[#5c6470]">{result.proposal.costNotes}</p>}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {resultApplied ? (
                  <>
                    <span className="text-[11px] font-semibold text-[#0f766e]">✓ Added to your plan</span>
                    <button onClick={() => show(result.proposal, result.proposal.title)} className="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-[#0f766e] hover:bg-[#e6f4f1]">
                      ⌖ Show
                    </button>
                    <button onClick={() => resultKey && removeFromPlan(resultKey)} className="rounded px-1.5 py-0.5 text-[10.5px] text-[#a33] hover:bg-[#fdf1f1]">
                      Remove
                    </button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      className="h-7 bg-[#0f766e] text-xs text-white hover:bg-[#115e59]"
                      onClick={() => resultKey && addToPlan(resultKey, result.proposal.title, result.estimatedCostInr, result.proposal)}
                    >
                      + Add to plan
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => show(result.proposal, result.proposal.title)}>
                      ⌖ Show on map
                    </Button>
                    <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs text-[#8a8272]" onClick={() => setResult(null)}>
                      Dismiss
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        <p className="text-[10px] leading-snug text-[#9a9384]">
          {rulesOnly
            ? "No AI key is configured, so suggestions come from built-in rules computed from your metrics. "
            : "Suggestions are AI-generated, then checked against your map and tested in the simulation. "}
          Every change is validated before you see it; simulated results are not a prediction of real crime.
        </p>
      </div>

      {/* your plan — sticky footer */}
      {livePlan.length > 0 && (
        <div className="border-t border-[#e3ded4] bg-white px-4 py-3 shadow-[0_-6px_16px_-10px_rgba(0,0,0,0.25)]">
          <div className="flex items-baseline justify-between">
            <div className="text-[12px] font-bold text-[#1d2430]">
              Your plan · {livePlan.length} change{livePlan.length === 1 ? "" : "s"}
            </div>
            <div className="text-[12px] font-semibold text-[#1d2430]">{planCost > 0 ? fmtInr(planCost) : "Free"}</div>
          </div>
          <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto">
            {livePlan.map((p) => (
              <li key={p.key} className="flex items-center gap-1.5 text-[11px] text-[#374151]">
                <span className="text-[#0f766e]">✓</span>
                <button
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  title="Show on map"
                  onClick={() => focusOn({ points: p.change.points, label: p.label, tone: "added", insetRight: insetRight() })}
                >
                  {p.label}
                </button>
                <button onClick={() => removeFromPlan(p.key)} className="shrink-0 rounded px-1 text-[#9a9384] hover:bg-[#fdf1f1] hover:text-[#a33]" aria-label={`Remove ${p.label}`}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <Button
            className="mt-2 h-9 w-full bg-[#0f766e] text-[13px] font-semibold text-white hover:bg-[#115e59]"
            disabled={!baselineRun || running}
            onClick={rerun}
            title={baselineRun ? "Replay the same night with your plan and compare with the original" : "Run a baseline simulation first"}
          >
            {running ? "Simulating…" : "▶ Re-run the night & compare"}
          </Button>
          {runError && <div className="mt-2 rounded bg-[#fdf1f1] px-2 py-1 text-[11px] text-[#a33]">{runError}</div>}
        </div>
      )}
    </aside>
  );
}
