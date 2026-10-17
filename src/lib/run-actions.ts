"use client";

/**
 * Client-side run orchestration: baseline & intervention execution,
 * report data preparation. Runs are pure computations over project state.
 */

import { useEditor, playbackClock } from "@/lib/store/editor";
import { executeRun, replayStoredRun } from "@/lib/sim/runner";
import { compareRuns } from "@/lib/sim/metrics";
import { ablateSync, headlineDiff, type AblationResult, type Headline } from "@/lib/sim/compare";
import { deepClone } from "@/lib/world/ids";
import type { PraesidiumProject, ScenarioConfig, StoredRun } from "@/lib/world/types";
import { useDrama } from "@/lib/store/drama";
import { dramaEnabled } from "@/lib/sim/drama";
import { policyCacheKey } from "@/lib/sim/policy";
import { getJevPolicy } from "@/lib/ai/jevClient";
import { compactIntel, intelHash } from "@/lib/ai/context";
import { intelSoon } from "@/lib/ai/intelLoader";
import { applyProposal, type Proposal } from "@/lib/ai/schema";
import { makeId } from "@/lib/world/ids";

/**
 * Attach a TypeSafe Jev behaviour policy to the scenario BEFORE the run
 * (cached per world + scenario; pre-baked table when offline; heuristics when
 * nothing is available). The engine stays deterministic: it samples the
 * table with its seeded rng.
 */
async function withJevPolicy(project: PraesidiumProject): Promise<ScenarioConfig> {
  const sc = project.scenario;
  if (!useDrama.getState().jevBehaviour || !dramaEnabled(sc)) {
    const { jevPolicy: _drop, ...rest } = sc;
    return rest as ScenarioConfig;
  }
  // The demo keeps its prebaked tables: intel never changes the demo's policy.
  const isDemo = project.source.kind === "demo";
  const local = isDemo ? null : compactIntel(await intelSoon(4000));
  const key = policyCacheKey(project.projectId, sc, intelHash(local));
  if (sc.jevPolicy?.key === key) return sc;
  const info = await getJevPolicy(project.projectId, sc, { preferPrebaked: isDemo, local });
  useDrama.getState().setPolicyInfo({ from: info.from, latencyMs: info.latencyMs, entries: info.policy ? Object.keys(info.policy.table).length : 0 });
  return info.policy ? { ...sc, jevPolicy: info.policy } : sc;
}

/**
 * Run the baseline: computes and stores an immutable snapshot run
 * (scenario + world + seed + engine version + metrics + events).
 */
export async function runBaseline(): Promise<void> {
  const s = useEditor.getState();
  const project = s.project;
  if (!project) return;
  if (project.world.roads.length === 0) {
    throw new Error("The neighborhood has no walkable roads or paths yet. Draw at least one path first.");
  }
  const scenario = await withJevPolicy(project);
  const { stored, active } = executeRun(project.world, scenario, "baseline");
  useEditor.setState((st) => ({
    project: st.project
      ? { ...st.project, scenario: { ...st.project.scenario, jevPolicy: scenario.jevPolicy }, baselineRun: stored, interventionRun: null, modifiedAt: new Date().toISOString() }
      : st.project,
    dirty: true,
    activeRun: active,
    runKind: "baseline",
    playing: true,
    displayT: 0,
    // a 30-min night at 1× is 30 real minutes — start fast enough to see the first incident in seconds
    speed: Math.max(st.speed, 4),
    // let the night play: a non-blocking summary card (NightSummary) links to the full results
    resultsOpen: false,
  }));
  playbackClock.t = 0;
  void useEditor.getState().save();
}

/**
 * Run the intervention with the CURRENT world + scenario but the SAME seed
 * as the baseline (unless the user deliberately changed it). The stored
 * baseline is never silently rewritten.
 */
export async function runIntervention(): Promise<void> {
  const s = useEditor.getState();
  const project = s.project;
  if (!project) return;
  if (!project.baselineRun) {
    throw new Error("Run a baseline simulation first — the comparison needs a preserved baseline.");
  }
  if (project.world.roads.length === 0) {
    throw new Error("The neighborhood has no walkable roads or paths yet.");
  }
  // same seed AND same behaviour policy as the baseline → a fair same-night comparison
  const scenario = { ...project.scenario, seed: project.baselineRun.seed, jevPolicy: project.baselineRun.scenario.jevPolicy };
  const { stored, active } = executeRun(project.world, scenario, "intervention", project.baselineRun.world);
  useEditor.setState((st) => ({
    project: st.project ? { ...st.project, interventionRun: stored, modifiedAt: new Date().toISOString() } : st.project,
    dirty: true,
    activeRun: active,
    runKind: "intervention",
    playing: true,
    displayT: 0,
    resultsOpen: false,
    compareOpen: true,
  }));
  playbackClock.t = 0;
  void useEditor.getState().save();
}

/** Cheap fingerprint of everything a fix can change (positions, counts, patrols, guards on duty). */
function setupSignature(w: PraesidiumProject["world"], guardCount: number | null | undefined): string {
  const r = (v: number) => Math.round(v * 10);
  const sum = (xs: { x: number; z: number }[]) => xs.reduce((s, p) => s + r(p.x) * 7 + r(p.z) * 13, 0);
  return [
    w.streetlights.length,
    sum(w.streetlights),
    w.streetlights.filter((l) => l.on).length,
    w.cameras.length,
    sum(w.cameras),
    w.cameras.filter((c) => c.active).length,
    w.guards.length,
    w.guards.reduce((s, g) => s + sum(g.waypoints) + g.waypoints.length, 0),
    w.buildings.length,
    w.roads.length,
    guardCount ?? "d",
  ].join("|");
}

/** True when the society or guards on duty changed since the stored baseline was run. */
export function setupChangedSinceBaseline(p: PraesidiumProject): boolean {
  const b = p.baselineRun;
  if (!b) return false;
  return setupSignature(p.world, p.scenario.guardCount) !== setupSignature(b.world, b.scenario.guardCount);
}

/** Restore playback frames for a stored run (deterministic replay). */
export function loadStoredRun(label: "baseline" | "intervention"): void {
  const s = useEditor.getState();
  const project = s.project;
  if (!project) return;
  const stored = label === "baseline" ? project.baselineRun : project.interventionRun;
  if (!stored) return;
  const active = replayStoredRun(stored);
  playbackClock.t = 0;
  useEditor.setState((st) => ({
    activeRun: active,
    runKind: label,
    playing: true,
    displayT: 0,
    resultsOpen: false,
    compareOpen: false,
    speed: Math.max(st.speed, 2),
    project: st.project
      ? {
          ...st.project,
          world: deepClone(stored.world),
          scenario: deepClone(stored.scenario),
        }
      : st.project,
  }));
}

/* ------------------------------------------------------------------ */
/* Report data                                                         */
/* ------------------------------------------------------------------ */

export interface ReportData {
  project: PraesidiumProject;
  baseline: StoredRun;
  intervention: StoredRun | null;
  comparison: ReturnType<typeof compareRuns>;
  ablation: AblationResult | null;
  headline: Headline | null;
  generatedAt: string;
}

export function prepareReportData(): ReportData | null {
  const { project } = useEditor.getState();
  if (!project?.baselineRun) return null;
  const baseline = project.baselineRun;
  const intervention = project.interventionRun;
  return {
    project: deepClone(project),
    baseline,
    intervention,
    comparison: intervention ? compareRuns(baseline.metrics, intervention.metrics) : [],
    ablation: intervention ? ablateSync(baseline, intervention) : null,
    headline: intervention ? headlineDiff(baseline, intervention) : null,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* AI proposal application                                             */
/* ------------------------------------------------------------------ */

/** What one applied proposal changed — enough to show it on the map and to take it back. */
export interface AppliedChange {
  cameraIds: string[];
  lightIds: string[];
  patrols: { guardId: string; waypoints: { x: number; z: number }[] }[];
  /** previous scenario guardCount, when the proposal changed it */
  guardCount?: { prev: number | null | undefined };
  /** where the change landed (for the camera fly-to) */
  points: { x: number; z: number }[];
}

/** Where a proposal's changes land, before or after applying it (for "show on map"). */
export function proposalFocusPoints(proposal: Proposal, project: PraesidiumProject): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = [];
  const w = project.world;
  for (const op of proposal.ops) {
    switch (op.op) {
      case "add_streetlight":
      case "add_camera":
      case "move_streetlight":
      case "move_camera":
        pts.push({ x: op.x, z: op.z });
        break;
      case "edit_streetlight": {
        const l = w.streetlights.find((o) => o.id === op.id);
        if (l) pts.push({ x: l.x, z: l.z });
        break;
      }
      case "edit_camera": {
        const c = w.cameras.find((o) => o.id === op.id);
        if (c) pts.push({ x: c.x, z: c.z });
        break;
      }
      case "set_patrol":
        pts.push(...op.waypoints.map((p) => ({ x: p.x, z: p.z })));
        break;
      case "set_scenario":
        pts.push(...w.guards.filter((g) => g.active && g.waypoints[0]).map((g) => ({ x: g.waypoints[0].x, z: g.waypoints[0].z })));
        break;
    }
  }
  return pts;
}

/**
 * Apply a validated AI proposal on top of the current society (changes stack:
 * applying a second pick keeps the first). Returns what changed so the UI can
 * fly to it and offer a per-change "Remove".
 */
export function applyAiProposal(proposal: Proposal): AppliedChange | null {
  const s = useEditor.getState();
  const project = s.project;
  if (!project) return null;
  // applying is an edit: leave the read-only simulation view (same as undo)
  if (isLockedRun()) s.exitSimulation();
  const draft = deepClone(project);
  const camBefore = new Set(draft.world.cameras.map((c) => c.id));
  const lightBefore = new Set(draft.world.streetlights.map((l) => l.id));
  const patrols = proposal.ops
    .filter((op): op is Extract<typeof op, { op: "set_patrol" }> => op.op === "set_patrol")
    .map((op) => ({ guardId: op.guardId, waypoints: deepClone(draft.world.guards.find((g) => g.id === op.guardId)?.waypoints ?? []) }));
  const touchesGuards = proposal.ops.some((op) => op.op === "set_scenario" && op.patch.guardCount !== undefined);
  const prevGuardCount = draft.scenario.guardCount;
  const points = proposalFocusPoints(proposal, draft);
  applyProposal(draft, proposal);
  draft.modifiedAt = new Date().toISOString();
  useEditor.setState((st) => ({
    project: draft,
    dirty: true,
    history: st.project ? { past: [...st.history.past, st.project].slice(-50), future: [] } : st.history,
  }));
  void useEditor.getState().save();
  return {
    cameraIds: draft.world.cameras.filter((c) => !camBefore.has(c.id)).map((c) => c.id),
    lightIds: draft.world.streetlights.filter((l) => !lightBefore.has(l.id)).map((l) => l.id),
    patrols,
    ...(touchesGuards ? { guardCount: { prev: prevGuardCount } } : {}),
    points,
  };
}

/** Take back one applied change, leaving every other applied change in place. */
export function revertAiChange(change: AppliedChange): void {
  const s = useEditor.getState();
  if (!s.project) return;
  if (isLockedRun()) s.exitSimulation();
  const draft = deepClone(s.project);
  const cams = new Set(change.cameraIds);
  const lights = new Set(change.lightIds);
  draft.world.cameras = draft.world.cameras.filter((c) => !cams.has(c.id));
  draft.world.streetlights = draft.world.streetlights.filter((l) => !lights.has(l.id));
  for (const p of change.patrols) {
    const g = draft.world.guards.find((o) => o.id === p.guardId);
    if (g && p.waypoints.length) g.waypoints = deepClone(p.waypoints);
  }
  if (change.guardCount) draft.scenario = { ...draft.scenario, guardCount: change.guardCount.prev ?? null };
  draft.modifiedAt = new Date().toISOString();
  useEditor.setState((st) => ({
    project: draft,
    dirty: true,
    selection: null,
    history: st.project ? { past: [...st.history.past, st.project].slice(-50), future: [] } : st.history,
  }));
  void useEditor.getState().save();
}

const isLockedRun = () => useEditor.getState().activeRun !== null;

export function newRunId(): string {
  return makeId("run");
}
