import { describe, it, expect } from "vitest";
import { validateProposal, applyProposal, describeOps } from "@/lib/ai/schema";
import { makeDemoProject } from "@/lib/world/demo";
import type { PraesidiumProject } from "@/lib/world/types";

function proj(): PraesidiumProject {
  return JSON.parse(JSON.stringify(makeDemoProject()));
}

describe("AI proposal validation", () => {
  it("accepts a valid allowlisted proposal", () => {
    const p = proj();
    const res = validateProposal(
      {
        title: "Light the dark lane",
        rationale: "Two path segments are modeled below the lighting threshold; adding lamps raises modeled coverage.",
        ops: [
          { op: "add_streetlight", x: 20, z: 30, brightness: 0.9, radius: 18 },
          { op: "add_camera", x: 30, z: -95, range: 30, fovDeg: 80, orientationDeg: 90 },
        ],
        expectedEffects: ["Higher modeled lit coverage"],
        limitations: ["Geometric approximation only"],
      },
      p
    );
    expect(res.ok).toBe(true);
    expect(res.proposal!.ops.length).toBe(2);
    expect(res.estimatedCostInr).toBe(14000 + 26000);
  });

  it("rejects schema-invalid proposals", () => {
    const res = validateProposal({ title: "x", ops: "not-an-array" }, proj());
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it("rejects out-of-bounds coordinates", () => {
    const res = validateProposal(
      {
        title: "Way outside",
        rationale: "Placing a lamp far outside the neighborhood bounds.",
        ops: [{ op: "add_streetlight", x: 99999, z: 0 }],
        expectedEffects: [],
        limitations: [],
      },
      proj()
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/outside the neighborhood bounds/);
  });

  it("rejects unknown object ids (no hallucinated references)", () => {
    const res = validateProposal(
      {
        title: "Ghost lamp",
        rationale: "Attempts to move a streetlight that does not exist in the world.",
        ops: [{ op: "move_streetlight", id: "sl_ghost", x: 10, z: 10 }],
        expectedEffects: [],
        limitations: [],
      },
      proj()
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/does not exist/);
  });

  it("rejects non-allowlisted operations", () => {
    const res = validateProposal(
      {
        title: "Bad op",
        rationale: "This proposal contains an operation that is not in the allowlist.",
        ops: [{ op: "delete_all_buildings" }],
        expectedEffects: [],
        limitations: [],
      },
      proj()
    );
    expect(res.ok).toBe(false);
  });

  it("rejects patrol updates for unknown guards", () => {
    const res = validateProposal(
      {
        title: "Wrong guard",
        rationale: "Patrol rerouting referencing a guard that does not exist.",
        ops: [{ op: "set_patrol", guardId: "gd_ghost", waypoints: [{ x: 0, z: 0 }, { x: 5, z: 5 }] }],
        expectedEffects: [],
        limitations: [],
      },
      proj()
    );
    expect(res.ok).toBe(false);
  });
});

describe("AI proposal application", () => {
  it("applies ops to the draft without mutating the original", () => {
    const p = proj();
    const before = p.world.streetlights.length;
    const res = validateProposal(
      {
        title: "Add three lamps",
        rationale: "Three additional streetlights along the darkest modeled paths.",
        ops: [
          { op: "add_streetlight", x: 10, z: 20 },
          { op: "add_streetlight", x: -40, z: 60 },
          { op: "edit_streetlight", id: p.world.streetlights[0].id, brightness: 1 },
        ],
        expectedEffects: [],
        limitations: [],
      },
      p
    );
    expect(res.ok).toBe(true);
    applyProposal(p, res.proposal!);
    expect(p.world.streetlights.length).toBe(before + 2);
    expect(p.world.streetlights[0].brightness).toBe(1);
  });

  it("describes operations in human-readable form", () => {
    const lines = describeOps({
      title: "t",
      rationale: "r",
      ops: [
        { op: "add_streetlight", x: 1, z: 2 },
        { op: "set_patrol", guardId: "gd_0", waypoints: [{ x: 0, z: 0 }, { x: 1, z: 1 }] },
      ],
      expectedEffects: [],
      limitations: [],
    });
    expect(lines[0]).toMatch(/Add a streetlight at \(1, 2\)/);
    expect(lines[1]).toMatch(/patrol route/);
  });

  it("names places and guards instead of coordinates and ids when given the world", () => {
    const p = makeDemoProject();
    const g = p.world.guards[0];
    const gate = p.world.site?.gates[0];
    const lines = describeOps(
      {
        title: "t",
        rationale: "r",
        ops: [
          { op: "add_camera", x: gate ? gate.x + 3 : 0, z: gate ? gate.z : 0 },
          { op: "set_patrol", guardId: g.id, waypoints: [{ x: 0, z: 0 }, { x: 1, z: 1 }] },
        ],
        expectedEffects: [],
        limitations: [],
      },
      p.world
    );
    expect(lines.join(" ")).not.toMatch(/\(\-?\d+, \-?\d+\)|gd_/);
    expect(lines[1]).toContain(g.name);
  });
});
