/**
 * Professional PDF report generation via jsPDF (fully client-side).
 * Vector tables and bar charts — no HTML rendering, no external assets.
 */

import { jsPDF } from "jspdf";
import type { ReportData } from "@/lib/run-actions";
import type { StoredRun, World } from "@/lib/world/types";
import { COST_ASSUMPTIONS } from "@/lib/world/types";
import type { MetricDiff } from "@/lib/sim/metrics";
import { eventTypeLabel, outcomeLabel } from "@/lib/sim/labels";
import { planCostInr, riskIndex, RISK_EXPLAINER } from "@/lib/sim/compare";

/**
 * jsPDF's built-in fonts are Latin-1 only. Anything outside it (−, →, ≈, …, ✓, curly quotes)
 * is drawn as garbage AND makes jsPDF letter-space the whole line — so map the common ones
 * and drop the rest. Applied to every doc.text / splitTextToSize call below.
 */
function pdfSafe(s: string): string {
  return s
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/₹\s?/g, "INR ")
    .replace(/[–—]/g, "-")
    .replace(/[−‒]/g, "-")
    .replace(/≈/g, "~")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/…/g, "...")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[✓✔]/g, "OK")
    .replace(/[✕✗×]/g, "x")
    .replace(/Σ/g, "All")
    .replace(/•/g, "-")
    .replace(/[^\x00-\xFF]/g, "");
}

/** Route all text through pdfSafe (strings and string arrays). */
function safeDoc(doc: jsPDF): jsPDF {
  const text = doc.text.bind(doc);
  const split = doc.splitTextToSize.bind(doc);
  const clean = (t: unknown) => (typeof t === "string" ? pdfSafe(t) : Array.isArray(t) ? t.map((x) => (typeof x === "string" ? pdfSafe(x) : x)) : t);
  (doc as unknown as { text: (...a: unknown[]) => jsPDF }).text = (t: unknown, ...rest: unknown[]) => (text as (...a: unknown[]) => jsPDF)(clean(t), ...rest);
  (doc as unknown as { splitTextToSize: (...a: unknown[]) => string[] }).splitTextToSize = (t: unknown, ...rest: unknown[]) =>
    (split as (...a: unknown[]) => string[])(clean(t), ...rest);
  return doc;
}

const NAVY: [number, number, number] = [29, 36, 48];
const GOLD: [number, number, number] = [232, 195, 74];
const GREEN: [number, number, number] = [46, 125, 91];
const AMBER: [number, number, number] = [185, 138, 47];
const GREY: [number, number, number] = [92, 100, 112];

const M = 18;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - M * 2;

export function generateReportPdf(data: ReportData, opts?: { download?: boolean }): jsPDF {
  const doc = safeDoc(new jsPDF({ unit: "mm", format: "a4" }));
  const { project, baseline, intervention, comparison } = data;
  let y = 0;
  let page = 1;

  const footer = () => {
    doc.setFontSize(8);
    doc.setTextColor(...GREY);
    doc.text(`Praesidium · Simulation report · Page ${page}`, M, PAGE_H - 10);
    doc.text("Simulated results — not predictions of actual crime", PAGE_W - M, PAGE_H - 10, {
      align: "right",
    });
  };

  const newPage = () => {
    footer();
    doc.addPage();
    page += 1;
    y = M;
  };

  const ensure = (need: number) => {
    if (y + need > PAGE_H - 20) newPage();
  };

  const title = (text: string) => {
    ensure(14);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12.5);
    doc.setTextColor(...NAVY);
    doc.text(text, M, y);
    y += 3;
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.7);
    doc.line(M, y, M + 26, y);
    doc.setLineWidth(0.2);
    y += 5;
  };

  const para = (text: string, size = 9.5, color: [number, number, number] = GREY, gap = 1.6) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, CONTENT_W);
    ensure(lines.length * (size * 0.45) + 4);
    doc.text(lines, M, y);
    y += lines.length * (size * 0.45 + 0.35) + gap;
  };

  const kvTable = (rows: [string, string][]) => {
    rows.forEach(([k, v], i) => {
      ensure(8);
      if (i % 2 === 0) {
        doc.setFillColor(246, 244, 239);
        doc.rect(M, y - 3.4, CONTENT_W, 6.6, "F");
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(...NAVY);
      doc.text(k, M + 2, y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...GREY);
      const vs = doc.splitTextToSize(v, CONTENT_W - 68);
      doc.text(vs, M + 64, y);
      y += Math.max(6.6, vs.length * 4.2);
    });
    y += 3;
  };

  const simpleTable = (rows: string[][], widths: number[], head: string[]) => {
    const drawRow = (cells: string[], bold = false, fill: [number, number, number] | null = null) => {
      ensure(8);
      if (fill) {
        doc.setFillColor(...fill);
        doc.rect(M, y - 3.6, CONTENT_W, 7, "F");
      }
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(9);
      doc.setTextColor(...(bold ? NAVY : GREY));
      let x = M + 2;
      cells.forEach((c, i) => {
        const w = widths[i];
        const lines = doc.splitTextToSize(c, w - 3);
        doc.text(lines[0] ?? "", x, y);
        x += w;
      });
      y += 7;
    };
    drawRow(head, true, [238, 234, 226]);
    rows.forEach((r) => drawRow(r));
    y += 2;
  };

  /* ---------------- cover header ---------------- */
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, PAGE_W, 46, "F");
  doc.setFillColor(...GOLD);
  doc.circle(M + 7, 16, 4.2, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("Praesidium", M + 15, 19);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(190, 200, 214);
  doc.text("Neighborhood Safety Simulation & Planning — Simulation Report", M + 15, 26);
  doc.setFontSize(9);
  doc.text(`Generated ${new Date(data.generatedAt).toLocaleString()}`, M, 38);
  doc.text(`Project: ${project.name}`, PAGE_W - M, 38, { align: "right" });

  y = 56;

  /* ---------------- project & disclaimer ---------------- */
  doc.setTextColor(...NAVY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(project.name, M, y);
  y += 6;

  para(
    project.description ||
      "A neighborhood modeled in Praesidium for a community safety planning exercise.",
    9.5
  );

  doc.setFillColor(253, 246, 231);
  doc.setDrawColor(...AMBER);
  doc.roundedRect(M, y, CONTENT_W, 18, 2, 2, "FD");
  doc.setTextColor(120, 90, 30);
  doc.setFontSize(8.5);
  const disc = doc.splitTextToSize(
    "Important: this report presents outputs of a simplified simulation with synthetic agents and fictional scenario events. It is a planning-support exercise — NOT a prediction of actual crime, a photometric assessment, or a guarantee of safety. Modeled coverage does not establish that incidents would be prevented, recorded, or detected.",
    CONTENT_W - 6
  );
  doc.text(disc, M + 3, y + 6);
  y += 24;

  /* ---------------- page-1 summary: the answer a committee reads first ---------------- */
  {
    const b = baseline.metrics;
    const lines: string[] = [];
    const inc = b.dramaIncidents ?? b.eventsTotal;
    lines.push(`Today's setup: ${inc} simulated incident(s), ${b.perpsCaughtPct ?? b.resolutionRatePct}% of offenders caught (risk index ${riskIndex(baseline.events)}).`);
    if (intervention) {
      const after = riskIndex(intervention.events);
      const before = riskIndex(baseline.events);
      const cost = planCostInr(baseline, intervention);
      lines.push(
        `With the proposed plan (est. INR ${cost.toLocaleString("en-IN")}): risk ${before} -> ${after}` +
          (after < before ? " — a safer simulated night." : after > before ? " — a RISKIER simulated night; revise the plan." : " — no clear change on this night.")
      );
      const ab = data.ablation;
      if (ab) {
        const best = ab.rows.filter((r) => r.riskReduced > 0).sort((p, q) => (q.riskPerLakh ?? 1e6) - (p.riskPerLakh ?? 1e6))[0];
        if (best) lines.push(`Best value: ${best.label} (${best.costInr ? `INR ${best.costInr.toLocaleString("en-IN")}` : "free"}).`);
        const worse = ab.rows.filter((r) => r.costInr > 0 && r.riskReduced < 0);
        if (worse.length) lines.push(`Drop first: ${worse.map((w) => w.label).join("; ")} — made the night worse on its own.`);
      }
    } else {
      lines.push("No plan tested yet — add fixes in the AI planner and re-run the night to compare.");
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    const wrapped = lines.flatMap((l) => doc.splitTextToSize(`•  ${l}`, CONTENT_W - 8));
    const h = 10 + wrapped.length * 4.6;
    doc.setFillColor(238, 244, 240);
    doc.setDrawColor(...GREEN);
    doc.roundedRect(M, y, CONTENT_W, h, 2, 2, "FD");
    doc.setTextColor(...GREEN);
    doc.text("Summary for the committee (simulated)", M + 4, y + 6);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...NAVY);
    doc.text(wrapped, M + 4, y + 11.5);
    y += h + 6;
  }

  /* ---------------- provenance ---------------- */
  title("Data provenance & run identity");
  const prov: [string, string][] = [
    [
      "Data source",
      project.source.kind === "osm"
        ? `OpenStreetMap import (${project.source.attribution ?? "© OpenStreetMap contributors"})`
        : project.source.kind === "demo"
          ? "Bundled demonstration neighborhood (fictional geometry)"
          : "Manually constructed in the editor",
    ],
    ["Engine version", baseline.engineVersion],
    ["Simulation seed", String(baseline.seed)],
    ["Simulated duration", `${Math.round(baseline.scenario.durationSec / 60)} simulated minutes`],
    ["Scenario", `${baseline.scenario.name} — ${baseline.scenario.description}`],
    [
      "Synthetic population",
      `${baseline.scenario.population} agents (${Math.round(baseline.scenario.residentRatio * 100)}% residents / ${Math.round((1 - baseline.scenario.residentRatio) * 100)}% night-shift commuters)`,
    ],
    ["Baseline run ID", baseline.id],
  ];
  if (intervention) prov.push(["Intervention run ID", intervention.id]);
  kvTable(prov);

  if (project.source.kind === "osm") {
    para(
      "Note: imported geometry is simplified (building footprints as fitted rectangles; heights may be estimated). Inferred attributes are marked in the editor and are not authoritative facts.",
      8.5
    );
  }

  /* ---------------- assumptions ---------------- */
  newPage();
  title("Scenario configuration & assumptions");
  const sc = baseline.scenario;
  kvTable([
    ["Start time (display)", sc.startTime],
    ["Expected simulated events", `${sc.eventsPerHour} per simulated hour (Poisson model)`],
    ["Lighting outage assumption", `${Math.round(sc.lightingOutageFraction * 100)}% of lamps unavailable this night`],
    ["Ambient visibility assumption", `${Math.round(sc.ambientVisibility * 100)}% (multiplier on modeled illumination)`],
    ["CCTV effective range multiplier", `${sc.cctvRangeScale.toFixed(2)}×`],
    ["Pedestrian walking speed", `${sc.pedestrianSpeed.toFixed(2)} m/s (±15% per agent)`],
    ["Guards", sc.guardCount === null ? "As defined in the neighborhood" : `${sc.guardCount} (scenario override)`],
    ["Guard walking speed", `${sc.guardSpeed.toFixed(2)} m/s`],
  ]);

  para(
    "Methodology: pedestrian agents route along the walkable network using A* pathfinding. Modeled lighting coverage samples the walkable network every 5 m and sums each active lamp's brightness × (1 − d/radius)^1.5 attenuation; a sample counts as lit above a threshold that rises as ambient visibility falls. Modeled CCTV coverage requires a sample point to lie within a camera's range × range multiplier and horizontal field of view. Guard response times are estimated from simulated travel distance along the network at the configured guard speed. Event generation uses a seeded Poisson-process model; event types and severities are fictional scenario parameters.",
    9,
    GREY,
    4
  );

  /* ---------------- baseline results ---------------- */
  title("Baseline results");
  simpleTable(resultsRows(baseline), [86, 34, 60], ["Metric", "Value", "Label"]);

  const types = Object.entries(baseline.metrics.eventsByType);
  if (types.length) {
    title("Simulated events by type (baseline)");
    simpleTable(types.map(([t, n]) => [eventTypeLabel(t), String(n)]), [110, 70], ["Event type (fictional scenario)", "Count"]);
  }

  const notable = baseline.events.filter((e) => e.outcome !== "resolved").slice(0, 8);
  if (notable.length) {
    title("Notable unresolved cases (baseline)");
    notableTable(doc, notable, simpleTable);
  }

  /* ---------------- intervention ---------------- */
  if (intervention) {
    newPage();
    title("Intervention results");
    simpleTable(resultsRows(intervention), [86, 34, 60], ["Metric", "Value", "Label"]);

    title("Baseline vs intervention");
    const rows = comparison.map((r) => [
      r.label,
      r.baseline,
      r.intervention,
      r.delta,
    ]);
    simpleTable(rows, [78, 32, 32, 38], ["Metric", "Baseline", "Intervention", "Change"]);

    {
      ensure(20);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...NAVY);
      doc.text(
        `Estimated cost of the plan: INR ${planCostInr(baseline, intervention).toLocaleString("en-IN")}`,
        M,
        y
      );
      y += 6;
      para(
        `Cost assumptions (estimates only): streetlight INR ${COST_ASSUMPTIONS.streetlightInstallInr.toLocaleString("en-IN")} · CCTV camera INR ${COST_ASSUMPTIONS.cameraInstallInr.toLocaleString("en-IN")} · guard-night INR ${COST_ASSUMPTIONS.guardNightInr.toLocaleString("en-IN")} · lamp relocation/edit ≈ 10% of install. Costs exclude tax, civil works and recurring maintenance.`,
        8.5
      );
    }

    ensure(80);
    title("Key modeled-coverage metrics at a glance");
    y = barChart(
      doc,
      comparison
        .filter((r) =>
          ["pathLenLitPct", "cctvCoveragePct", "eventsReachedPct", "resolutionRatePct"].includes(String(r.key))
        )
        .map((r) => ({
          label: shortLabel(String(r.key)),
          baseline: parseFloat(r.baseline) || 0,
          intervention: parseFloat(r.intervention) || 0,
        })),
      y
    );

    const implemented = diffWorlds(baseline.world, intervention.world);
    if (implemented.length) {
      title("Implemented interventions");
      implemented.forEach((line) => para(`•  ${line}`, 9.5, GREY, 0.8));
    }

    /* ---------------- committee page: risk reduced per rupee ---------------- */
    const ab = data.ablation;
    if (ab) {
      newPage();
      doc.setFillColor(...NAVY);
      doc.rect(M, y - 5, CONTENT_W, 13, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(255, 255, 255);
      doc.text("For the committee: what to fund first", M + 3, y + 3.5);
      doc.setFontSize(8);
      doc.setTextColor(...GOLD);
      doc.text("SIMULATED ESTIMATES", PAGE_W - M - 3, y + 3.5, { align: "right" });
      y += 15;

      if (data.headline) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(...GREEN);
        const hl = doc.splitTextToSize(`Same night, one change — ${pdfSafe(data.headline.text)}`, CONTENT_W);
        doc.text(hl, M, y);
        y += hl.length * 5 + 2;
      }

      const c = ab.combined;
      para(
        `We replayed the same simulated night twice with identical people and perpetrators (seed ${baseline.seed}). ` +
          `With all proposed changes (est. INR ${c.costInr.toLocaleString("en-IN")}), the risk index moves from ${ab.baselineRisk} to ${c.risk} points` +
          `${c.riskReduced > 0 ? ` (${c.riskReduced} points lower)` : ""}; ${c.caught} incident(s) end with the perpetrator caught` +
          `${c.blindSpotRemoved > 0 ? `, and ${c.blindSpotRemoved} fewer incident(s) happen in camera blind spots` : ""}. ` +
          "To see which purchase does the work, each change was then tested on its own against the original night.",
        9.5,
        NAVY,
        3
      );

      const rows = [...ab.rows, c].map((r, i) => [
        r.id === "all" ? "All" : String(i + 1),
        pdfSafe(r.label),
        r.costInr ? `INR ${r.costInr.toLocaleString("en-IN")}` : "free",
        r.riskReduced === 0 ? "-" : `${r.riskReduced > 0 ? "-" : "+"}${Math.abs(r.riskReduced)}`,
        r.riskPerLakh === null ? (r.riskReduced > 0 ? "free win" : "-") : r.riskPerLakh > 0 ? r.riskPerLakh.toFixed(1) : "-",
        r.incidentsPrevented ? String(r.incidentsPrevented) : "-",
        r.caughtDelta ? `${r.caughtDelta > 0 ? "+" : ""}${r.caughtDelta}` : "-",
        r.responseSavedSec ? `${r.responseSavedSec} s` : "-",
      ]);
      simpleTable(rows, [9, 55, 24, 17, 19, 18, 15, 17], ["#", "Change", "Est. cost", "Risk", "Per lakh", "Avoided", "Caught", "Faster"]);

      const best = ab.rows.find((r) => r.riskReduced > 0);
      const worse = ab.rows.filter((r) => r.riskReduced < 0 && r.costInr > 0);
      const dud = ab.rows.filter((r) => r.riskReduced === 0 && r.costInr > 0);
      const bullets: string[] = [];
      if (best) bullets.push(`Best value: "${best.label}" — ${best.riskPerLakh !== null ? `${best.riskPerLakh.toFixed(1)} risk points removed per INR 1 lakh` : "no purchase cost"}.`);
      if (worse.length) bullets.push(`Drop first — made this night worse on its own: ${worse.map((d) => d.label).join("; ")}.`);
      if (dud.length) bullets.push(`${dud.length} paid change(s) showed no measurable benefit on this night: ${dud.map((d) => d.label).join("; ")}. Consider deferring or re-siting them.`);
      bullets.push("Changes interact: single-change effects need not add up to the combined result.");
      bullets.push("One simulated night is one sample. Re-test on the High-Risk and Low-Visibility nights before committing funds.");
      bullets.forEach((b) => para(`•  ${b}`, 9.5, GREY, 1));
      para(
        `How to read it: "Risk" is the change in a simple risk index (lower is better). ${pdfSafe(RISK_EXPLAINER.replace("Σ", "sum of"))} "Per lakh" = risk points removed per INR 1,00,000 spent. "Avoided" = incidents that did not occur; "Caught" = extra incidents ending with the perpetrator caught; "Faster" = median guard response time saved. Costs are standard estimates excluding tax, civil works and maintenance.`,
        8,
        GREY,
        2
      );
    }
  }

  /* ---------------- limitations ---------------- */
  newPage();
  title("Limitations & responsible use");
  const limits = [
    "All simulated residents, guards and events are synthetic and fictional. No real individual is profiled, tracked, or scored.",
    "Event generation is a fictional scenario parameter, not an inference about actual criminality of any area or person.",
    "Modeled lighting and CCTV coverage are geometric approximations with disclosed assumptions; they are not photometric or engineering assessments.",
    "Camera coverage does not imply incidents would be detected or recorded; lighting coverage does not imply prevention.",
    "Response times are estimates from simulated distances along the modeled pedestrian network at configured speeds.",
    "Results depend on scenario parameters, synthetic population assumptions and geometry quality. Validate findings with real community consultation.",
    "If the neighborhood was imported from OpenStreetMap, geometry is simplified and attributes may be inferred or missing.",
    "This report is generated locally in your browser. No project data leaves your device except optional AI planning requests, which send only an aggregated summary.",
  ];
  limits.forEach((l) => para(`•  ${l}`, 9.5, GREY, 1.2));

  footer();
  if (opts?.download !== false) {
    doc.save(`${project.name.replace(/[^a-z0-9-_ ]/gi, "").replace(/\s+/g, "_")}_praesidium_report.pdf`);
  }
  return doc;
}

/* ------------------------------------------------------------------ */

function resultsRows(run: StoredRun): string[][] {
  const m = run.metrics;
  const row = (label: string, value: string, kind: string) => [label, value, kind];
  return [
    row("Modeled lit path coverage", pct(m.pathLenLitPct), "modeled coverage"),
    row("Modeled CCTV coverage", pct(m.cctvCoveragePct), "modeled coverage"),
    row("Poorly lit path segments", `${m.poorlyLitSegments} of ${m.segmentsTotal}`, "modeled"),
    row("Lighting outages this night", String(m.lightingOutages), "scenario assumption"),
    row("Trips with reachable destinations", pct(m.tripsReachablePct), "simulated"),
    row("Unreachable trips", String(m.unreachableTrips), "simulated"),
    row("Average route length", `${m.avgRouteLengthM} m`, "simulated"),
    row("Route completion rate", pct(m.routeCompletionPct), "simulated"),
    row("Simulated events", String(m.eventsTotal), "fictional scenario events"),
    row("Events with an available guard", pct(m.eventsWithGuardPct), "simulated"),
    row("Events reached by a guard", pct(m.eventsReachedPct), "simulated"),
    row("Estimated avg. response time", m.avgResponseSec !== null ? `${m.avgResponseSec} s` : "—", "estimated"),
    row("Estimated median response time", m.medianResponseSec !== null ? `${m.medianResponseSec} s` : "—", "estimated"),
    row("Unreachable events", String(m.unreachableEvents), "simulated"),
    row("Unresolved events", String(m.unresolvedEvents), "simulated"),
    row("Resolution rate", pct(m.resolutionRatePct), "simulated"),
    row("Patrol coverage (40 m of waypoints)", m.patrolCoveragePct !== null ? pct(m.patrolCoveragePct) : "—", "modeled"),
  ];
}

function pct(v: number): string {
  return `${v.toFixed(1)}%`;
}

function notableTable(
  doc: jsPDF,
  events: StoredRun["events"],
  simpleTable: (rows: string[][], widths: number[], head: string[]) => void
) {
  simpleTable(
    events.map((e) => [
      `${e.tSec}s`,
      eventTypeLabel(e.type),
      `sev ${e.severity}`,
      outcomeLabel(e.outcome),
      e.note,
    ]),
    [14, 28, 13, 50, 69],
    ["Time", "Type", "Severity", "Outcome", "Detail"]
  );
  void doc;
}

function barChart(doc: jsPDF, bars: { label: string; baseline: number; intervention: number }[], startY: number): number {
  const chartH = 52;
  const groupW = CONTENT_W / Math.max(bars.length, 1);
  const maxV = Math.max(100, ...bars.flatMap((b) => [b.baseline, b.intervention]));
  const baseY = startY + chartH;

  // axis
  doc.setDrawColor(...GREY);
  doc.setLineWidth(0.3);
  doc.line(M, baseY, M + CONTENT_W, baseY);
  doc.setFontSize(8);
  doc.setTextColor(...GREY);

  bars.forEach((b, i) => {
    const cx = M + i * groupW;
    const bw = Math.min(12, groupW / 3.2);
    const h1 = (b.baseline / maxV) * (chartH - 10);
    const h2 = (b.intervention / maxV) * (chartH - 10);
    doc.setFillColor(...GREY);
    doc.rect(cx + groupW / 2 - bw - 2, baseY - h1, bw, h1, "F");
    doc.setFillColor(...GREEN);
    doc.rect(cx + groupW / 2 + 2, baseY - h2, bw, h2, "F");
    doc.setFontSize(7.5);
    doc.setTextColor(...NAVY);
    const lines = doc.splitTextToSize(b.label, groupW - 4);
    doc.text(lines, cx + groupW / 2, baseY + 4, { align: "center" });
    doc.setFontSize(7);
    doc.setTextColor(...GREY);
    doc.text(`${b.baseline.toFixed(0)}%`, cx + groupW / 2 - bw - 2 + bw / 2, baseY - h1 - 1.5, { align: "center" });
    doc.text(`${b.intervention.toFixed(0)}%`, cx + groupW / 2 + 2 + bw / 2, baseY - h2 - 1.5, { align: "center" });
  });

  // legend
  doc.setFillColor(...GREY);
  doc.rect(M, baseY + 12, 3.5, 3.5, "F");
  doc.setFontSize(8);
  doc.setTextColor(...GREY);
  doc.text("Baseline", M + 6, baseY + 15);
  doc.setFillColor(...GREEN);
  doc.rect(M + 30, baseY + 12, 3.5, 3.5, "F");
  doc.text("Intervention", M + 36, baseY + 15);
  return baseY + 22;
}

function diffWorlds(a: World, b: World): string[] {
  const out: string[] = [];
  const newLights = b.streetlights.filter((l) => !a.streetlights.some((x) => x.id === l.id));
  const removedLights = a.streetlights.filter((l) => !b.streetlights.some((x) => x.id === l.id));
  const movedLights = b.streetlights.filter((l) => {
    const o = a.streetlights.find((x) => x.id === l.id);
    return o && (o.x !== l.x || o.z !== l.z || o.on !== l.on || o.brightness !== l.brightness || o.radius !== l.radius);
  });
  const newCams = b.cameras.filter((c) => !a.cameras.some((x) => x.id === c.id));
  const movedCams = b.cameras.filter((c) => {
    const o = a.cameras.find((x) => x.id === c.id);
    return o && (o.x !== c.x || o.z !== c.z || o.orientationDeg !== c.orientationDeg || o.range !== c.range || o.fovDeg !== c.fovDeg || o.active !== c.active);
  });
  const patrolChanges = b.guards.filter((g) => {
    const o = a.guards.find((x) => x.id === g.id);
    if (!o) return false;
    return JSON.stringify(o.waypoints) !== JSON.stringify(g.waypoints);
  });
  const newGuards = b.guards.filter((g) => !a.guards.some((x) => x.id === g.id));

  if (newLights.length) out.push(`Added ${newLights.length} streetlight${newLights.length > 1 ? "s" : ""}.`);
  if (removedLights.length) out.push(`Removed ${removedLights.length} streetlight${removedLights.length > 1 ? "s" : ""}.`);
  if (movedLights.length) out.push(`Edited ${movedLights.length} streetlight${movedLights.length > 1 ? "s" : ""} (position, brightness, radius or status).`);
  if (newCams.length) out.push(`Added ${newCams.length} CCTV camera${newCams.length > 1 ? "s" : ""}.`);
  if (movedCams.length) out.push(`Adjusted ${movedCams.length} CCTV camera${movedCams.length > 1 ? "s" : ""}.`);
  patrolChanges.forEach((g) => out.push(`Updated patrol route for ${g.name}.`));
  if (newGuards.length) out.push(`Added ${newGuards.length} guard${newGuards.length > 1 ? "s" : ""}.`);
  return out;
}

function shortLabel(key: string): string {
  switch (key) {
    case "pathLenLitPct":
      return "Lit path coverage";
    case "cctvCoveragePct":
      return "CCTV coverage";
    case "eventsReachedPct":
      return "Events reached";
    case "resolutionRatePct":
      return "Resolution rate";
    default:
      return key;
  }
}
