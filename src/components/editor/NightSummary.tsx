"use client";

/**
 * Non-blocking "how did tonight go" card over the 3D view after a baseline run.
 * The night keeps playing behind it; the card says what happened in one line,
 * names the biggest gap, and points at the next step (find fixes).
 */

import { useState } from "react";
import { useEditor } from "@/lib/store/editor";
import type { RunMetrics } from "@/lib/world/types";

function biggestGap(m: RunMetrics): string | null {
  const gaps: { score: number; text: string }[] = [
    { score: 100 - m.cctvCoveragePct, text: m.cctvCoveragePct < 5 ? "almost no CCTV coverage on walkways" : `only ${Math.round(m.cctvCoveragePct)}% of walkways on CCTV` },
    { score: 100 - m.pathLenLitPct, text: `only ${Math.round(m.pathLenLitPct)}% of paths well lit` },
  ];
  if (m.patrolCoveragePct !== null) gaps.push({ score: (100 - m.patrolCoveragePct) * 0.9, text: `patrols reach only ${Math.round(m.patrolCoveragePct)}% of the society` });
  const resp = m.dramaMedianResponseSec ?? m.medianResponseSec;
  if (resp !== null && resp !== undefined && resp > 120) gaps.push({ score: Math.min(100, resp / 4), text: `guards take ~${Math.round(resp / 60)} min to arrive` });
  const top = gaps.sort((a, b) => b.score - a.score)[0];
  return top && top.score > 30 ? top.text : null;
}

export default function NightSummary() {
  const project = useEditor((s) => s.project);
  const runKind = useEditor((s) => s.runKind);
  const activeRun = useEditor((s) => s.activeRun);
  const resultsOpen = useEditor((s) => s.resultsOpen);
  const assistantOpen = useEditor((s) => s.assistantOpen);
  const setResultsOpen = useEditor((s) => s.setResultsOpen);
  const setAssistantOpen = useEditor((s) => s.setAssistantOpen);
  const runId = project?.baselineRun?.id;
  // remembers WHICH run was dismissed, so a new run (new id) shows the card again
  const [dismissed, setDismissed] = useState<string | null>(null);

  const run = project?.baselineRun;
  if (!run || runKind !== "baseline" || !activeRun || resultsOpen || assistantOpen || dismissed === runId) return null;
  const m = run.metrics;
  const incidents = m.dramaIncidents ?? m.eventsTotal;
  const caughtPct = m.perpsCaughtPct ?? m.resolutionRatePct;
  const gotAway = Math.round(incidents * (1 - caughtPct / 100));
  const gap = biggestGap(m);

  return (
    <div className="pointer-events-auto absolute bottom-14 left-4 z-20 w-[340px] max-w-[calc(100%-2rem)] rounded-xl border border-white/10 bg-[#0f1722]/95 p-3.5 text-white shadow-2xl backdrop-blur" data-testid="night-summary">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8fb3c9]">Tonight, simulated</div>
        <button onClick={() => setDismissed(runId ?? null)} className="-mr-1 -mt-1 rounded p-1 text-[11px] text-white/50 hover:bg-white/10 hover:text-white" aria-label="Dismiss">
          ✕
        </button>
      </div>
      <div className="mt-1 text-[15px] font-semibold leading-snug">
        {incidents === 0 ? (
          "A quiet night — no incidents."
        ) : (
          <>
            {incidents} incident{incidents === 1 ? "" : "s"}
            {gotAway > 0 ? (
              <>
                , <span className="text-[#ff8a7a]">{gotAway} got away</span>
              </>
            ) : (
              <span className="text-[#7be0b0]">, every offender caught</span>
            )}
          </>
        )}
      </div>
      {gap && (
        <div className="mt-1 text-[12px] text-white/75">
          Biggest gap: <span className="text-white">{gap}</span>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button onClick={() => setAssistantOpen(true)} className="flex-1 rounded-md bg-[#14b8a6] px-3 py-1.5 text-[12px] font-semibold text-[#062925] hover:bg-[#2dd4bf]">
          ✦ Find fixes
        </button>
        <button onClick={() => setResultsOpen(true)} className="rounded-md border border-white/20 px-3 py-1.5 text-[12px] text-white/90 hover:bg-white/10">
          Full results
        </button>
      </div>
      <div className="mt-2 text-[10px] text-white/45">The night keeps playing behind this card · fictional, simulated events</div>
    </div>
  );
}
