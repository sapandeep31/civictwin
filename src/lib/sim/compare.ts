/**
 * Baseline vs intervention analysis:
 *  - incident matching + a headline diff ("Mugging at 22:01: escaped in blind spot → caught on CCTV")
 *  - a simple, explainable risk index
 *  - per-change ablation (re-run the BASELINE with one change applied, same seed)
 *    and a "risk reduced per ₹" ranking.
 *
 * Everything here is a simulated estimate computed from deterministic runs.
 */

import type { CctvCamera, Guard, RunMetrics, ScenarioConfig, Streetlight, StoredRun, StoredRunEvent, World } from "../world/types";
import { COST_ASSUMPTIONS } from "../world/types";
import { deepClone } from "../world/ids";
import { runSimulation } from "./engine";
import { computeMetrics } from "./metrics";
import { clockLabel } from "./runner";
import { EVENT_TYPE_LABEL, eventTypeLabel, outcomeRank, outcomeShort } from "./labels";
import { describePlace } from "../ai/schema";

/* ------------------------------------------------------------------ */
/* Risk index                                                          */
/* ------------------------------------------------------------------ */

/** How bad an outcome is (1 = worst). Weighted by severity in the risk index. */
const BADNESS: Record<string, number> = {
  perp_escaped: 1,
  no_guard: 0.9,
  unreachable: 0.85,
  open_at_end: 0.8,
  escaped_on_cctv: 0.5,
  resolved: 0.15,
};
export const RISK_EXPLAINER =
  "Risk index = Σ incident severity (1–3) × outcome weight (escaped in blind spot 1.0 · no guard 0.9 · unreachable 0.85 · still open 0.8 · escaped but on CCTV 0.5 · caught 0.15).";

export function riskIndex(events: StoredRunEvent[]): number {
  let r = 0;
  for (const e of events) r += e.severity * (BADNESS[e.outcome] ?? 0.8);
  return Math.round(r * 10) / 10;
}

const isIncident = (e: StoredRunEvent) => e.type in EVENT_TYPE_LABEL;

/* ------------------------------------------------------------------ */
/* Incident matching + headline                                        */
/* ------------------------------------------------------------------ */

export interface IncidentPair {
  base: StoredRunEvent | null;
  int: StoredRunEvent | null;
  /** positive = intervention better */
  gain: number;
}

/** Greedy match of incidents of the same type closest in time (≤ 240 s apart). */
export function matchIncidents(base: StoredRunEvent[], int: StoredRunEvent[]): IncidentPair[] {
  const B = base.filter(isIncident);
  const I = int.filter(isIncident);
  const used = new Set<number>();
  const pairs: IncidentPair[] = [];
  for (const b of B) {
    let best = -1;
    let bd = Infinity;
    I.forEach((i, k) => {
      if (used.has(k) || i.type !== b.type) return;
      const d = Math.abs(i.tSec - b.tSec) + Math.hypot(i.x - b.x, i.z - b.z) * 0.5;
      if (d < bd && Math.abs(i.tSec - b.tSec) <= 240) {
        bd = d;
        best = k;
      }
    });
    if (best >= 0) {
      used.add(best);
      const i = I[best];
      pairs.push({ base: b, int: i, gain: (outcomeRank(i.outcome) - outcomeRank(b.outcome)) * b.severity });
    } else {
      pairs.push({ base: b, int: null, gain: (3 - outcomeRank(b.outcome)) * b.severity * 0.9 + 0.01 });
    }
  }
  I.forEach((i, k) => {
    if (!used.has(k)) pairs.push({ base: null, int: i, gain: -(3 - outcomeRank(i.outcome)) * i.severity * 0.9 });
  });
  return pairs.sort((a, b) => (a.base ?? a.int)!.tSec - (b.base ?? b.int)!.tSec);
}

export interface Headline {
  text: string;
  tSec: number;
  x: number;
  z: number;
  improved: boolean;
  /** The intervention made this incident turn out worse. */
  worse?: boolean;
}

export function headlineDiff(baseline: StoredRun, intervention: StoredRun): Headline | null {
  const pairs = matchIncidents(baseline.events, intervention.events);
  const start = baseline.scenario.startTime;
  const best = pairs.slice().sort((a, b) => b.gain - a.gain)[0];
  const describe = (p: IncidentPair) => {
    const ref = (p.base ?? p.int)!;
    const when = clockLabel(ref.tSec, start).slice(0, 5);
    const what = eventTypeLabel(ref.type);
    const a = p.base ? outcomeShort(p.base.outcome) : "did not happen";
    const b = p.int ? outcomeShort(p.int.outcome) : "never happened";
    return { head: `${what} at ${when}`, text: `${what} at ${when}: ${a} → ${b}`, tSec: ref.tSec, x: ref.x, z: ref.z };
  };
  const strip = ({ head: _h, ...rest }: ReturnType<typeof describe>) => rest;
  if (best && best.gain > 0) return { ...strip(describe(best)), improved: true };
  const changed = pairs.find((p) => !p.base || !p.int || p.base.outcome !== p.int.outcome);
  if (changed) return { ...strip(describe(changed)), improved: false, worse: changed.gain < 0 };
  const first = pairs[0];
  if (first) {
    const d = describe(first);
    return { ...strip(d), text: `${d.head}: same outcome in both runs (${outcomeShort((first.base ?? first.int)!.outcome)})`, improved: false };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Change detection                                                    */
/* ------------------------------------------------------------------ */

export interface WorldChange {
  id: string;
  label: string;
  costInr: number;
  apply: (world: World, scenario: ScenarioConfig) => void;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

function lightChanged(a: Streetlight, b: Streetlight) {
  return !near(a.x, b.x) || !near(a.z, b.z) || a.on !== b.on || !near(a.brightness, b.brightness) || !near(a.radius, b.radius);
}
function camChanged(a: CctvCamera, b: CctvCamera) {
  return !near(a.x, b.x) || !near(a.z, b.z) || a.active !== b.active || !near(a.range, b.range) || !near(a.fovDeg, b.fovDeg) || !near(a.orientationDeg, b.orientationDeg);
}
function guardChanged(a: Guard, b: Guard) {
  return a.active !== b.active || !near(a.speed, b.speed) || JSON.stringify(a.waypoints) !== JSON.stringify(b.waypoints);
}

export function detectChanges(base: StoredRun, int: StoredRun): WorldChange[] {
  const bw = base.world;
  const iw = int.world;
  const out: WorldChange[] = [];
  for (const l of iw.streetlights) {
    const b = bw.streetlights.find((x) => x.id === l.id);
    if (!b) {
      out.push({
        id: `add-${l.id}`,
        label: `New streetlight ${describePlace(l.x, l.z, iw)}`,
        costInr: COST_ASSUMPTIONS.streetlightInstallInr,
        apply: (w) => void w.streetlights.push(deepClone(l)),
      });
    } else if (lightChanged(b, l)) {
      out.push({
        id: `edit-${l.id}`,
        label: !b.on && l.on ? `Repair streetlight ${describePlace(l.x, l.z, iw)}` : `Move / adjust streetlight ${describePlace(b.x, b.z, iw)}`,
        costInr: Math.round(COST_ASSUMPTIONS.streetlightInstallInr * 0.1),
        apply: (w) => {
          const i = w.streetlights.findIndex((x) => x.id === l.id);
          if (i >= 0) w.streetlights[i] = deepClone(l);
        },
      });
    }
  }
  for (const c of iw.cameras) {
    const b = bw.cameras.find((x) => x.id === c.id);
    if (!b) {
      out.push({
        id: `add-${c.id}`,
        label: `New CCTV camera ${describePlace(c.x, c.z, iw)}`,
        costInr: COST_ASSUMPTIONS.cameraInstallInr,
        apply: (w) => void w.cameras.push(deepClone(c)),
      });
    } else if (camChanged(b, c)) {
      out.push({
        id: `edit-${c.id}`,
        label: `${!b.active && c.active ? "Repair" : "Re-aim / move"} camera ${describePlace(b.x, b.z, iw)}`,
        costInr: Math.round(COST_ASSUMPTIONS.cameraInstallInr * 0.1),
        apply: (w) => {
          const i = w.cameras.findIndex((x) => x.id === c.id);
          if (i >= 0) w.cameras[i] = deepClone(c);
        },
      });
    }
  }
  for (const g of iw.guards) {
    const b = bw.guards.find((x) => x.id === g.id);
    if (!b) {
      out.push({
        id: `add-${g.id}`,
        label: `Extra guard (${g.name})`,
        costInr: COST_ASSUMPTIONS.guardNightInr,
        apply: (w) => void w.guards.push(deepClone(g)),
      });
    } else if (guardChanged(b, g)) {
      out.push({
        id: `edit-${g.id}`,
        label: `Re-route patrol of ${g.name}`,
        costInr: COST_ASSUMPTIONS.patrolWaypointEditInr,
        apply: (w) => {
          const i = w.guards.findIndex((x) => x.id === g.id);
          if (i >= 0) w.guards[i] = deepClone(g);
        },
      });
    }
  }
  // removals (rare, but keep the ablation honest)
  for (const l of bw.streetlights) if (!iw.streetlights.some((x) => x.id === l.id))
    out.push({ id: `rm-${l.id}`, label: `Remove streetlight ${describePlace(l.x, l.z, bw)}`, costInr: 0, apply: (w) => void (w.streetlights = w.streetlights.filter((x) => x.id !== l.id)) });
  for (const c of bw.cameras) if (!iw.cameras.some((x) => x.id === c.id))
    out.push({ id: `rm-${c.id}`, label: `Remove camera ${describePlace(c.x, c.z, bw)}`, costInr: 0, apply: (w) => void (w.cameras = w.cameras.filter((x) => x.id !== c.id)) });

  const bg = base.scenario.guardCount;
  const ig = int.scenario.guardCount;
  if (bg !== ig) {
    const before = bg ?? bw.guards.filter((g) => g.active).length;
    const after = ig ?? iw.guards.filter((g) => g.active).length;
    out.push({
      id: "guard-count",
      label: `Guards on duty ${before} → ${after}`,
      costInr: Math.max(0, after - before) * COST_ASSUMPTIONS.guardNightInr,
      apply: (_w, s) => void (s.guardCount = ig),
    });
  }
  return out;
}

/**
 * What the current setup costs on top of a baseline — the ONE cost figure used by
 * the plan bar, the compare view and the report (same rules as the per-change table).
 */
export function planCostInr(base: { world: World; scenario: ScenarioConfig }, now: { world: World; scenario: ScenarioConfig }): number {
  return detectChanges(base as StoredRun, now as StoredRun).reduce((s, c) => s + c.costInr, 0);
}

/* ------------------------------------------------------------------ */
/* Ablation                                                            */
/* ------------------------------------------------------------------ */

export interface Effect {
  risk: number;
  riskReduced: number;
  incidents: number;
  incidentsPrevented: number;
  caught: number;
  caughtDelta: number;
  blindSpotRemoved: number;
  responseSavedSec: number | null;
}

export interface CostEffectRow extends Effect {
  id: string;
  label: string;
  costInr: number;
  /** risk-index points reduced per ₹1 lakh (null when cost is 0). */
  riskPerLakh: number | null;
}

export interface AblationResult {
  interventionId: string;
  baselineRisk: number;
  rows: CostEffectRow[];
  combined: CostEffectRow;
  /** True when the change list was capped. */
  truncated: boolean;
}

function effectOf(base: { events: StoredRunEvent[]; metrics: RunMetrics }, run: { events: StoredRunEvent[]; metrics: RunMetrics }): Effect {
  const br = riskIndex(base.events);
  const r = riskIndex(run.events);
  const caught = (evs: StoredRunEvent[]) => evs.filter((e) => isIncident(e) && e.outcome === "resolved").length;
  const bInc = base.events.filter(isIncident).length;
  const iInc = run.events.filter(isIncident).length;
  const bResp = base.metrics.dramaMedianResponseSec ?? base.metrics.medianResponseSec;
  const iResp = run.metrics.dramaMedianResponseSec ?? run.metrics.medianResponseSec;
  return {
    risk: r,
    riskReduced: Math.round((br - r) * 10) / 10,
    incidents: iInc,
    incidentsPrevented: bInc - iInc,
    caught: caught(run.events),
    caughtDelta: caught(run.events) - caught(base.events),
    blindSpotRemoved: (base.metrics.blindSpotIncidents ?? 0) - (run.metrics.blindSpotIncidents ?? 0),
    responseSavedSec: bResp != null && iResp != null ? Math.round(bResp - iResp) : null,
  };
}

const perLakh = (risk: number, cost: number) => (cost > 0 ? Math.round((risk / (cost / 100000)) * 100) / 100 : null);

const MAX_CHANGES = 14;
const cache = new Map<string, AblationResult>();

export function getCachedAblation(interventionId: string): AblationResult | null {
  return cache.get(interventionId) ?? null;
}

/**
 * Re-run the baseline once per single change (same seed, same night) and
 * rank changes by risk reduced per ₹. Pass `yieldEvery` to keep the UI responsive.
 */
export async function ablate(baseline: StoredRun, intervention: StoredRun, opts?: { yieldBetween?: boolean }): Promise<AblationResult> {
  const hit = cache.get(intervention.id);
  if (hit) return hit;
  const all = detectChanges(baseline, intervention);
  const changes = all.slice(0, MAX_CHANGES);
  const rows: CostEffectRow[] = [];
  for (const ch of changes) {
    if (opts?.yieldBetween) await new Promise((r) => setTimeout(r, 0));
    const w = deepClone(baseline.world);
    const s = deepClone(baseline.scenario);
    ch.apply(w, s);
    const sim = runSimulation(w, s);
    const metrics = computeMetrics(w, s, sim, { label: "intervention", baseWorld: baseline.world });
    const eff = effectOf(baseline, { events: sim.events, metrics });
    rows.push({ id: ch.id, label: ch.label, costInr: ch.costInr, ...eff, riskPerLakh: perLakh(eff.riskReduced, ch.costInr) });
  }
  rows.sort((a, b) => score(b) - score(a));
  const totalCost = all.reduce((s, c) => s + c.costInr, 0);
  const combEff = effectOf(baseline, intervention);
  const result: AblationResult = {
    interventionId: intervention.id,
    baselineRisk: riskIndex(baseline.events),
    rows,
    combined: { id: "all", label: "All changes together", costInr: totalCost, ...combEff, riskPerLakh: perLakh(combEff.riskReduced, totalCost) },
    truncated: all.length > changes.length,
  };
  cache.set(intervention.id, result);
  return result;
}

/** Number of single-change re-runs the ablation will do (for progress UIs / workers). */
export function ablationCount(baseline: StoredRun, intervention: StoredRun): number {
  return Math.min(MAX_CHANGES, detectChanges(baseline, intervention).length);
}

/** One single-change re-run (index into the capped change list). Pure; safe in a worker. */
export function ablateOne(baseline: StoredRun, intervention: StoredRun, index: number): CostEffectRow | null {
  const ch = detectChanges(baseline, intervention).slice(0, MAX_CHANGES)[index];
  if (!ch) return null;
  const w = deepClone(baseline.world);
  const s = deepClone(baseline.scenario);
  ch.apply(w, s);
  const sim = runSimulation(w, s);
  const metrics = computeMetrics(w, s, sim, { label: "intervention", baseWorld: baseline.world });
  const eff = effectOf(baseline, { events: sim.events, metrics });
  return { id: ch.id, label: ch.label, costInr: ch.costInr, ...eff, riskPerLakh: perLakh(eff.riskReduced, ch.costInr) };
}

/** Combine streamed single-change rows into the final (cached) ablation result. */
export function assembleAblation(baseline: StoredRun, intervention: StoredRun, rowsIn: CostEffectRow[]): AblationResult {
  const all = detectChanges(baseline, intervention);
  const rows = rowsIn.slice().sort((a, b) => score(b) - score(a));
  const totalCost = all.reduce((s, c) => s + c.costInr, 0);
  const combEff = effectOf(baseline, intervention);
  const result: AblationResult = {
    interventionId: intervention.id,
    baselineRisk: riskIndex(baseline.events),
    rows,
    combined: { id: "all", label: "All changes together", costInr: totalCost, ...combEff, riskPerLakh: perLakh(combEff.riskReduced, totalCost) },
    truncated: all.length > MAX_CHANGES,
  };
  cache.set(intervention.id, result);
  return result;
}

/** Synchronous variant (PDF export, tests). */
export function ablateSync(baseline: StoredRun, intervention: StoredRun): AblationResult {
  return cache.get(intervention.id) ?? computeInline(baseline, intervention);
}

function computeInline(baseline: StoredRun, intervention: StoredRun): AblationResult {
  const all = detectChanges(baseline, intervention);
  const changes = all.slice(0, MAX_CHANGES);
  const rows: CostEffectRow[] = changes.map((ch) => {
    const w = deepClone(baseline.world);
    const s = deepClone(baseline.scenario);
    ch.apply(w, s);
    const sim = runSimulation(w, s);
    const metrics = computeMetrics(w, s, sim, { label: "intervention", baseWorld: baseline.world });
    const eff = effectOf(baseline, { events: sim.events, metrics });
    return { id: ch.id, label: ch.label, costInr: ch.costInr, ...eff, riskPerLakh: perLakh(eff.riskReduced, ch.costInr) };
  });
  rows.sort((a, b) => score(b) - score(a));
  const totalCost = all.reduce((s, c) => s + c.costInr, 0);
  const combEff = effectOf(baseline, intervention);
  const result: AblationResult = {
    interventionId: intervention.id,
    baselineRisk: riskIndex(baseline.events),
    rows,
    combined: { id: "all", label: "All changes together", costInr: totalCost, ...combEff, riskPerLakh: perLakh(combEff.riskReduced, totalCost) },
    truncated: all.length > changes.length,
  };
  cache.set(intervention.id, result);
  return result;
}

/** Ranking key: free changes that help go first, then risk per lakh, then raw reduction. */
function score(r: CostEffectRow): number {
  if (r.riskReduced <= 0) return -1000 + r.riskReduced;
  if (r.costInr === 0) return 1e6 + r.riskReduced;
  return r.riskPerLakh ?? 0;
}

export function fmtInr(v: number): string {
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}
