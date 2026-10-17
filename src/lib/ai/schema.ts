/**
 * AI planning-assistant proposal schema + strict allowlist validation.
 *
 * The model NEVER mutates the world directly. It returns a structured
 * proposal which is validated here against an explicit operation
 * allowlist, world bounds, and existing object IDs. Invalid proposals
 * are rejected with a recoverable error.
 */

import { z } from "zod";
import type { PraesidiumProject, Vec2 } from "../world/types";
import { COST_ASSUMPTIONS } from "../world/types";

const brightnessSchema = z.preprocess((val) => {
  if (typeof val === "number") {
    if (val > 1 && val <= 100) return Math.min(1, Math.max(0.1, val / 100));
    if (val > 1) return 1.0;
    if (val < 0.1) return 0.1;
  }
  return val;
}, z.number().min(0.1).max(1).optional());

const fractionSchema = z.preprocess((val) => {
  if (typeof val === "number") {
    if (val > 1 && val <= 100) return Math.min(1, Math.max(0, val / 100));
    if (val > 1) return 1.0;
    if (val < 0) return 0;
  }
  return val;
}, z.number().min(0).max(1).optional());

export const proposalOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_streetlight"),
    x: z.number(),
    z: z.number(),
    brightness: brightnessSchema,
    radius: z.number().min(5).max(45).optional(),
  }),
  z.object({
    op: z.literal("move_streetlight"),
    id: z.string(),
    x: z.number(),
    z: z.number(),
  }),
  z.object({
    op: z.literal("edit_streetlight"),
    id: z.string(),
    on: z.boolean().optional(),
    brightness: brightnessSchema,
    radius: z.number().min(5).max(45).optional(),
  }),
  z.object({
    op: z.literal("add_camera"),
    x: z.number(),
    z: z.number(),
    range: z.number().min(5).max(60).optional(),
    fovDeg: z.number().min(15).max(360).optional(),
    orientationDeg: z.number().min(-180).max(360).optional(),
  }),
  z.object({
    op: z.literal("move_camera"),
    id: z.string(),
    x: z.number(),
    z: z.number(),
  }),
  z.object({
    op: z.literal("edit_camera"),
    id: z.string(),
    active: z.boolean().optional(),
    range: z.number().min(5).max(60).optional(),
    fovDeg: z.number().min(15).max(360).optional(),
    orientationDeg: z.number().min(-180).max(360).optional(),
  }),
  z.object({
    op: z.literal("set_patrol"),
    guardId: z.string(),
    waypoints: z.array(z.object({ x: z.number(), z: z.number() })).min(2).max(8),
  }),
  z.object({
    op: z.literal("set_scenario"),
    patch: z.object({
      eventsPerHour: z.number().min(0).max(120).optional(),
      guardCount: z.number().int().min(0).max(20).nullable().optional(),
      lightingOutageFraction: fractionSchema,
      ambientVisibility: z.preprocess((val) => {
        if (typeof val === "number") {
          if (val > 1 && val <= 100) return Math.min(1, Math.max(0.2, val / 100));
          if (val > 1) return 1.0;
          if (val < 0.2) return 0.2;
        }
        return val;
      }, z.number().min(0.2).max(1).optional()),
    }),
  }),
]);

export const proposalSchema = z.object({
  title: z.string().min(3).max(120),
  rationale: z.string().min(10).max(2000),
  ops: z.array(proposalOpSchema).min(1).max(24),
  expectedEffects: z.array(z.string().max(240)).max(8).default([]),
  limitations: z.array(z.string().max(240)).max(8).default([]),
  costNotes: z.string().max(600).optional(),
});

export type ProposalOp = z.infer<typeof proposalOpSchema>;
export type Proposal = z.infer<typeof proposalSchema>;

export interface ValidationResult {
  ok: boolean;
  proposal?: Proposal;
  errors: string[];
  estimatedCostInr: number;
}

const MARGIN = 30; // allow slight off-bounds placements

/**
 * Validate a raw model output against the schema AND the actual world.
 */
export function validateProposal(raw: unknown, project: PraesidiumProject): ValidationResult {
  const errors: string[] = [];
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 6).map((i) => `Schema: ${i.path.join(".")} — ${i.message}`),
      estimatedCostInr: 0,
    };
  }
  const proposal = parsed.data;
  // Night conditions (incident rate, outages, haze) describe the test, not an
  // intervention — keep only guardCount so baseline vs intervention stays fair.
  proposal.ops = proposal.ops.filter((op) => {
    if (op.op !== "set_scenario") return true;
    op.patch = op.patch.guardCount !== undefined ? { guardCount: op.patch.guardCount } : {};
    return Object.keys(op.patch).length > 0;
  });
  if (!proposal.ops.length) {
    return { ok: false, errors: ["The proposal only changed night conditions, which are not interventions."], estimatedCostInr: 0 };
  }
  const { world } = project;
  const bw = world.bounds.width / 2 + MARGIN;
  const bd = world.bounds.depth / 2 + MARGIN;

  let cost = 0;
  proposal.ops.forEach((op, i) => {
    const posCheck = (x: number, z: number) => {
      if (Math.abs(x) > bw || Math.abs(z) > bd) {
        errors.push(`Operation ${i + 1}: position (${x.toFixed(0)}, ${z.toFixed(0)}) is outside the neighborhood bounds.`);
        return false;
      }
      return true;
    };
    switch (op.op) {
      case "add_streetlight":
        if (posCheck(op.x, op.z)) cost += COST_ASSUMPTIONS.streetlightInstallInr;
        break;
      case "add_camera":
        if (posCheck(op.x, op.z)) cost += COST_ASSUMPTIONS.cameraInstallInr;
        break;
      case "move_streetlight": {
        const l = world.streetlights.find((o) => o.id === op.id);
        if (!l) errors.push(`Operation ${i + 1}: streetlight ${op.id} does not exist.`);
        else posCheck(op.x, op.z);
        break;
      }
      case "edit_streetlight": {
        const l = world.streetlights.find((o) => o.id === op.id);
        if (!l) errors.push(`Operation ${i + 1}: streetlight ${op.id} does not exist.`);
        break;
      }
      case "move_camera": {
        const c = world.cameras.find((o) => o.id === op.id);
        if (!c) errors.push(`Operation ${i + 1}: camera ${op.id} does not exist.`);
        else posCheck(op.x, op.z);
        break;
      }
      case "edit_camera": {
        const c = world.cameras.find((o) => o.id === op.id);
        if (!c) errors.push(`Operation ${i + 1}: camera ${op.id} does not exist.`);
        break;
      }
      case "set_patrol": {
        const g = world.guards.find((o) => o.id === op.guardId);
        if (!g) errors.push(`Operation ${i + 1}: guard ${op.guardId} does not exist.`);
        else op.waypoints.forEach((w, wi) => posCheck(w.x, w.z) || errors.push(`Waypoint ${wi + 1} is out of bounds.`));
        break;
      }
      case "set_scenario":
        break; // patch keys already constrained by schema
    }
  });

  if (errors.length) return { ok: false, errors: errors.slice(0, 8), estimatedCostInr: cost };
  return { ok: true, proposal, errors: [], estimatedCostInr: cost };
}

/** Apply a validated proposal to a project draft (caller handles history/undo). */
export function applyProposal(draft: PraesidiumProject, proposal: Proposal): void {
  for (const op of proposal.ops) {
    switch (op.op) {
      case "add_streetlight":
        draft.world.streetlights.push({
          id: `sl_ai_${Math.random().toString(36).slice(2, 8)}`,
          x: op.x,
          z: op.z,
          height: 8,
          brightness: op.brightness ?? 0.85,
          radius: op.radius ?? 18,
          on: true,
          maintenance: "ok",
        });
        break;
      case "move_streetlight": {
        const l = draft.world.streetlights.find((o) => o.id === op.id);
        if (l) {
          l.x = op.x;
          l.z = op.z;
        }
        break;
      }
      case "edit_streetlight": {
        const l = draft.world.streetlights.find((o) => o.id === op.id);
        if (l) {
          if (op.on !== undefined) l.on = op.on;
          if (op.brightness !== undefined) l.brightness = op.brightness;
          if (op.radius !== undefined) l.radius = op.radius;
        }
        break;
      }
      case "add_camera":
        draft.world.cameras.push({
          id: `cam_ai_${Math.random().toString(36).slice(2, 8)}`,
          x: op.x,
          z: op.z,
          height: 6.5,
          range: op.range ?? 28,
          fovDeg: op.fovDeg ?? 80,
          orientationDeg: op.orientationDeg ?? 0,
          active: true,
        });
        break;
      case "move_camera": {
        const c = draft.world.cameras.find((o) => o.id === op.id);
        if (c) {
          c.x = op.x;
          c.z = op.z;
        }
        break;
      }
      case "edit_camera": {
        const c = draft.world.cameras.find((o) => o.id === op.id);
        if (c) {
          if (op.active !== undefined) c.active = op.active;
          if (op.range !== undefined) c.range = op.range;
          if (op.fovDeg !== undefined) c.fovDeg = op.fovDeg;
          if (op.orientationDeg !== undefined) c.orientationDeg = op.orientationDeg;
        }
        break;
      }
      case "set_patrol": {
        const g = draft.world.guards.find((o) => o.id === op.guardId);
        if (g) g.waypoints = op.waypoints.map((w) => ({ x: w.x, z: w.z } as Vec2));
        break;
      }
      case "set_scenario":
        draft.scenario = { ...draft.scenario, ...op.patch };
        break;
    }
  }
}

/**
 * "near Main gate (Dr Rajkumar Rd)" / "near Tower B" / "on the north-east side" — places a
 * position for people, instead of local coordinates.
 */
export function describePlace(x: number, z: number, world?: PraesidiumProject["world"]): string {
  if (world) {
    const marks: { name: string; x: number; z: number }[] = [
      ...(world.site?.gates ?? []).map((g) => ({ name: g.name ?? "the gate", x: g.x, z: g.z })),
      ...world.facilities.filter((f) => f.name && f.type !== "park").map((f) => ({ name: f.name!, x: f.x, z: f.z })),
      ...world.buildings.filter((b) => b.name).map((b) => ({ name: b.name!, x: b.x, z: b.z })),
      ...world.facilities.filter((f) => f.name && f.type === "park" && f.name !== "Park").map((f) => ({ name: f.name!, x: f.x, z: f.z })),
    ];
    let best: { name: string; d: number } | null = null;
    for (const m of marks) {
      const d = Math.hypot(m.x - x, m.z - z);
      if (d < 45 && (!best || d < best.d)) best = { name: m.name, d };
    }
    if (best) return `near ${best.name}`;
    const W = world.bounds.width;
    const D = world.bounds.depth;
    const ns = z < -D * 0.15 ? "north" : z > D * 0.15 ? "south" : "";
    const ew = x < -W * 0.15 ? "west" : x > W * 0.15 ? "east" : "";
    if (ns || ew) return `on the ${ns && ew ? `${ns}-${ew}` : ns || ew} side`;
    return "in the centre";
  }
  return `at (${x.toFixed(0)}, ${z.toFixed(0)})`;
}

/** Human-readable list of a proposal's operations (pass the world to name places and objects). */
export function describeOps(proposal: Proposal, world?: PraesidiumProject["world"]): string[] {
  const out: string[] = [];
  const at = (x: number, z: number) => describePlace(x, z, world);
  const light = (id: string) => world?.streetlights.find((l) => l.id === id);
  const cam = (id: string) => world?.cameras.find((c) => c.id === id);
  const guardName = (id: string) => world?.guards.find((g) => g.id === id)?.name ?? (world ? "a guard" : id);
  proposal.ops.forEach((op, i) => {
    switch (op.op) {
      case "add_streetlight":
        out.push(`${i + 1}. Add a streetlight ${at(op.x, op.z)}`);
        break;
      case "move_streetlight": {
        const l = light(op.id);
        out.push(`${i + 1}. Move the streetlight ${l ? at(l.x, l.z) : world ? "" : op.id} to ${at(op.x, op.z).replace(/^near |^on |^in /, "")}`.replace(/\s+/g, " "));
        break;
      }
      case "edit_streetlight": {
        const l = light(op.id);
        const what = op.on === true ? "Switch on" : op.on === false ? "Switch off" : "Brighten / adjust";
        out.push(`${i + 1}. ${what} the streetlight ${l ? at(l.x, l.z) : world ? "" : op.id}`.trim());
        break;
      }
      case "add_camera":
        out.push(`${i + 1}. Add a CCTV camera ${at(op.x, op.z)}`);
        break;
      case "move_camera": {
        const c = cam(op.id);
        out.push(`${i + 1}. Move the camera ${c ? at(c.x, c.z) : world ? "" : op.id} to ${at(op.x, op.z).replace(/^near |^on |^in /, "")}`.replace(/\s+/g, " "));
        break;
      }
      case "edit_camera": {
        const c = cam(op.id);
        const what = op.active === true ? "Repair / switch on" : op.active === false ? "Switch off" : "Re-aim / widen";
        out.push(`${i + 1}. ${what} the camera ${c ? at(c.x, c.z) : world ? "" : op.id}`.trim());
        break;
      }
      case "set_patrol":
        out.push(`${i + 1}. New patrol route for ${guardName(op.guardId)} (${op.waypoints.length} stops)`);
        break;
      case "set_scenario":
        out.push(
          op.patch.guardCount !== undefined
            ? `${i + 1}. Set guards on duty to ${op.patch.guardCount ?? "neighbourhood default"}`
            : `${i + 1}. Adjust scenario parameters: ${JSON.stringify(op.patch)}`
        );
        break;
    }
  });
  return out;
}
