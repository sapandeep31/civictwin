import { describe, it, expect } from "vitest";
import { fitFootprint, orientedBox, polygonArea } from "@/lib/geo/footprint";
import { parseJsonLoose, repairJson } from "@/lib/ai/gemini";
import { mergeVisionLayout, VisionLayoutSchema } from "@/lib/geo/visionLayout";
import { bufferRing, pickCompound, ringAreaHa, selfIntersects, simplifyRing, type LL } from "@/lib/geo/compound";
import { dedupeAgainst, type ExtraBuilding } from "@/lib/geo/overture";
import type { World } from "@/lib/world/types";

const rot = (pts: { x: number; z: number }[], deg: number) => {
  const t = (deg * Math.PI) / 180;
  return pts.map((p) => ({ x: p.x * Math.cos(t) - p.z * Math.sin(t), z: p.x * Math.sin(t) + p.z * Math.cos(t) }));
};
const rect = (w: number, d: number) => [
  { x: -w / 2, z: -d / 2 },
  { x: w / 2, z: -d / 2 },
  { x: w / 2, z: d / 2 },
  { x: -w / 2, z: d / 2 },
];

describe("footprint fitting", () => {
  it("fits a tilted rectangle tightly instead of inflating it (axis-aligned bbox would double it)", () => {
    const b = orientedBox(rot(rect(40, 12), 37));
    expect(b.width).toBeCloseTo(40, 1);
    expect(b.depth).toBeCloseTo(12, 1);
    expect(Math.abs(Math.abs(b.rotation) - (37 * Math.PI) / 180)).toBeLessThan(0.01);
  });

  it("splits an L-shaped block into wings that cover it without the empty corner", () => {
    const L = [
      { x: 0, z: 0 },
      { x: 60, z: 0 },
      { x: 60, z: 15 },
      { x: 15, z: 15 },
      { x: 15, z: 50 },
      { x: 0, z: 50 },
    ];
    const fit = fitFootprint(L);
    expect(fit.parts.length).toBeGreaterThanOrEqual(2);
    const covered = fit.parts.reduce((s, p) => s + p.width * p.depth, 0);
    expect(covered / polygonArea(L)).toBeGreaterThan(0.85);
    expect(covered / polygonArea(L)).toBeLessThan(1.1); // the bbox would be 3000 m² vs 1425 m² real
  });

  it("keeps a plain rectangle as one box", () => {
    expect(fitFootprint(rot(rect(30, 20), 12)).parts).toHaveLength(1);
  });
});

describe("model JSON repair", () => {
  it("drops trailing commas outside strings only", () => {
    expect(JSON.parse(repairJson('{"a":[1,2,],"s":"x,]y"}'))).toEqual({ a: [1, 2], s: "x,]y" });
  });
  it("recovers a reply truncated by the token limit", () => {
    const v = parseJsonLoose<{ buildings: unknown[] }>('{"buildings":[{"corners":[[1,2],[3,4],[5,6]]},{"corners":[[7,8],[9');
    expect(v.buildings.length).toBe(2);
  });
});

describe("vision layout schema + merge", () => {
  const W = 300;
  const base: World = {
    bounds: { width: W, depth: W },
    roads: [{ id: "r1", points: [{ x: -150, z: 0 }, { x: 150, z: 0 }], width: 6, category: "road", pedestrian: true }],
    buildings: [],
    facilities: [],
    streetlights: [],
    cameras: [],
    guards: [],
  };

  it("keeps the valid buildings when one entry is malformed", () => {
    const L = VisionLayoutSchema.parse({
      buildings: [{ corners: [[100, 100], [200, 100], [200, 150], [100, 150]] }, { corners: "oops" }, { u: 700, v: 700, widthM: 20, depthM: 10 }],
    });
    expect(L.buildings).toHaveLength(2);
  });

  it("builds buildings from corners, and rejects a slab lying across a mapped road", () => {
    const L = VisionLayoutSchema.parse({
      buildings: [
        { corners: [[100, 100], [200, 100], [200, 160], [100, 160]], floors: 12 }, // north of the road
        { corners: [[400, 450], [600, 450], [600, 550], [400, 550]], floors: 20 }, // straddles z = 0 road
      ],
    });
    const { world, added } = mergeVisionLayout(base, L);
    expect(added.buildings).toBe(1);
    expect(added.rejected).toBe(1);
    const b = world.buildings[0];
    expect(b.width).toBeCloseTo(30, 0); // 100 grid units × 0.3 m
    expect(b.depth).toBeCloseTo(18, 0);
  });

  it("does not double-rotate a legacy centre+size box whose long side was put in depth", () => {
    // model said: 41 m wide, 147 m deep, long axis 90° (north-south) — must end up north-south, not east-west
    const L = VisionLayoutSchema.parse({ buildings: [{ u: 800, v: 300, widthM: 20, depthM: 60, rotationDeg: 90 }] });
    const b = mergeVisionLayout({ ...base, roads: [] }, L).world.buildings[0];
    const longAxisX = Math.abs(Math.cos(b.rotation)); // world x component of the local width axis
    expect(b.width).toBe(60);
    expect(longAxisX).toBeLessThan(0.05);
  });
});

describe("compound locator helpers", () => {
  const sq = (lat: number, lon: number, m: number): LL[] => {
    const d = m / 2 / 111320;
    const k = d / Math.cos((lat * Math.PI) / 180);
    return [
      [lat - d, lon - k],
      [lat - d, lon + k],
      [lat + d, lon + k],
      [lat + d, lon - k],
    ];
  };

  it("buffers outward and simplifies to the vertex cap", () => {
    const r = sq(12.97, 77.6, 200);
    expect(ringAreaHa(bufferRing(r, 10))).toBeGreaterThan(ringAreaHa(r));
    const dense: LL[] = Array.from({ length: 300 }, (_, i) => {
      const t = (i / 300) * Math.PI * 2;
      return [12.97 + 0.002 * Math.sin(t), 77.6 + 0.002 * Math.cos(t)];
    });
    expect(simplifyRing(dense, 1, 40).length).toBeLessThanOrEqual(40);
  });

  it("prefers the named residential compound containing the pin over a huge neighbourhood", () => {
    const at: LL = [12.97, 77.6];
    const toGeom = (r: LL[]) => [...r, r[0]].map(([lat, lon]) => ({ lat, lon }));
    const best = pickCompound(
      [
        { type: "way", id: 1, tags: { place: "neighbourhood", name: "Whitefield" }, geometry: toGeom(sq(12.97, 77.6, 1100)) },
        { type: "way", id: 2, tags: { landuse: "residential", name: "Prestige Shantiniketan" }, geometry: toGeom(sq(12.97, 77.6, 450)) },
      ],
      at,
      "Prestige Shantiniketan, Bengaluru"
    );
    expect(best?.name).toBe("Prestige Shantiniketan");
  });

  it("detects a self-intersecting (bow-tie) outline", () => {
    expect(selfIntersects([[0, 0], [0, 0.001], [0.001, 0], [0.001, 0.001]])).toBe(true);
    expect(selfIntersects(sq(12.97, 77.6, 100))).toBe(false);
  });
});

describe("Overture footprint dedupe", () => {
  const box = (lat: number, lon: number, m: number): [number, number][] => {
    const d = m / 2 / 111320;
    return [
      [lat - d, lon - d],
      [lat - d, lon + d],
      [lat + d, lon + d],
      [lat + d, lon - d],
      [lat - d, lon - d],
    ];
  };
  const extra = (id: string, lat: number, lon: number, m: number): ExtraBuilding => ({ id, polygon: box(lat, lon, m), source: "Google Open Buildings" });

  it("drops duplicates of mapped buildings and small clutter in mapped areas, keeps houses in unmapped stretches", () => {
    const mapped = [{ polygon: box(28.5, 77.3, 30) }, { polygon: box(28.5002, 77.3, 30) }];
    const kept = dedupeAgainst(mapped, [
      extra("dup", 28.5, 77.3, 25), // same building as OSM
      extra("kiosk", 28.5001, 77.3003, 6), // 36 m² shed next to mapped towers
      extra("house", 28.51, 77.31, 9), // 81 m² house far from any mapped building
    ]);
    expect(kept.map((k) => k.id)).toEqual(["house"]);
  });
});
