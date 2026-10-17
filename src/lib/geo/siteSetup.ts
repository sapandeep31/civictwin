/**
 * Post-import site preparation so an imported twin is simulation-ready:
 *  1. connect the walkable network (snap dangling road ends, bridge every
 *     disconnected component to the largest, reach every entrance/facility);
 *  2. seed a plausible "current setup" baseline — guards at gates/booths with
 *     perimeter patrol loops, one inward-facing camera per gate, and streetlights
 *     every ~40 m along internal roads with deliberate gaps in back lanes / dark
 *     zones so the simulation can surface blind spots.
 * Everything added is marked inferred. Deterministic for a given world.
 */

import type { Building, CctvCamera, Guard, Road, SiteGate, Streetlight, Vec2, World } from "../world/types";
import { buildNavGraph, entranceOf, type NavGraph } from "../world/graph";
import { makeRng } from "../sim/rng";

const SNAP_M = 15;

function d2(a: Vec2, b: Vec2) {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}

function closestOnSeg(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return { x: a.x + t * dx, z: a.z + t * dz };
}

function path(id: string, a: Vec2, b: Vec2): Road {
  return { id, name: "Connector path (inferred)", points: [a, b], width: 2, category: "path", pedestrian: true, inferred: true };
}

function components(g: NavGraph): number[] {
  const comp = new Array<number>(g.nodes.length).fill(-1);
  let c = 0;
  for (const n of g.nodes) {
    if (comp[n.id] !== -1) continue;
    const stack = [n.id];
    comp[n.id] = c;
    while (stack.length) {
      for (const e of g.nodes[stack.pop()!].edges) if (comp[e.to] === -1) ((comp[e.to] = c), stack.push(e.to));
    }
    c++;
  }
  return comp;
}

/** Entrance on the footprint edge facing the nearest road point (handles rotation). */
function entranceToward(b: Building, target: Vec2): Vec2 {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  // world -> local (three.js Y rotation: local x axis = (cos, -sin))
  const dx = target.x - b.x;
  const dz = target.z - b.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const hw = b.width / 2;
  const hd = b.depth / 2;
  const k = Math.min(hw / (Math.abs(lx) || 1e-6), hd / (Math.abs(lz) || 1e-6));
  const ex = lx * k * 1.02;
  const ez = lz * k * 1.02;
  return { x: b.x + ex * c + ez * s, z: b.z - ex * s + ez * c };
}

export function connectNetwork(world: World): { world: World; added: number; components: number } {
  const roads = [...world.roads];
  let added = 0;
  const all = () => roads.filter((r) => r.pedestrian && r.points.length >= 2);

  // 1. snap dangling endpoints onto a nearby other road
  for (const r of all().slice()) {
    for (const end of [r.points[0], r.points[r.points.length - 1]]) {
      let best: Vec2 | null = null;
      let bd = SNAP_M * SNAP_M;
      let touching = false;
      for (const o of all()) {
        if (o === r) continue;
        for (let i = 1; i < o.points.length; i++) {
          const q = closestOnSeg(end, o.points[i - 1], o.points[i]);
          const dd = d2(q, end);
          if (dd < 0.25) touching = true;
          if (dd < bd) ((bd = dd), (best = q));
        }
      }
      if (!touching && best) roads.push(path(`rd_snap_${added++}`, end, best));
    }
  }

  // 2. entrances: face the nearest road, bridge long gaps
  const roadPts = () => all().flatMap((r) => r.points);
  const nearestRoadPoint = (p: Vec2): Vec2 | null => {
    let best: Vec2 | null = null;
    let bd = Infinity;
    for (const r of all())
      for (let i = 1; i < r.points.length; i++) {
        const q = closestOnSeg(p, r.points[i - 1], r.points[i]);
        const dd = d2(q, p);
        if (dd < bd) ((bd = dd), (best = q));
      }
    return best;
  };
  const buildings = world.buildings.map((b) => {
    if (b.entrance || !roadPts().length) return b;
    const q = nearestRoadPoint({ x: b.x, z: b.z });
    if (!q) return b;
    const e = entranceToward(b, q);
    if (Math.sqrt(d2(e, q)) > 24) {
      const dir = Math.sqrt(d2(e, q)) || 1;
      roads.push(path(`rd_ent_${added++}`, { x: e.x + ((q.x - e.x) / dir) * 1.5, z: e.z + ((q.z - e.z) / dir) * 1.5 }, q));
    }
    return { ...b, entrance: e };
  });
  for (const f of world.facilities) {
    const q = nearestRoadPoint(f);
    if (q && Math.sqrt(d2(f, q)) > 24) {
      const dir = Math.sqrt(d2(f, q)) || 1;
      roads.push(path(`rd_fac_${added++}`, { x: f.x + ((q.x - f.x) / dir) * 1.5, z: f.z + ((q.z - f.z) / dir) * 1.5 }, q));
    }
  }

  // 3. bridge every remaining component to the largest one
  let out: World = { ...world, roads, buildings };
  let comps = 1;
  for (let iter = 0; iter < 60; iter++) {
    const g = buildNavGraph(out);
    const comp = components(g);
    const sizes = new Map<number, number>();
    for (const c of comp) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    comps = sizes.size;
    if (comps <= 1) break;
    const largest = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const other = [...sizes.entries()].filter(([c]) => c !== largest).sort((a, b) => b[1] - a[1])[0][0];
    let bestA = -1;
    let bestB = -1;
    let bd = Infinity;
    for (const a of g.nodes) {
      if (comp[a.id] !== other) continue;
      for (const b of g.nodes) {
        if (comp[b.id] !== largest || b.connector) continue;
        const dd = d2(a, b);
        if (dd < bd) ((bd = dd), (bestA = a.id), (bestB = b.id));
      }
    }
    if (bestA < 0) break;
    const A = g.nodes[bestA];
    const B = g.nodes[bestB];
    const len = Math.sqrt(bd) || 1;
    // connector nodes can't share a position with a road node — start 1 m out
    const start = A.connector ? { x: A.x + ((B.x - A.x) / len) * Math.min(1, len / 2), z: A.z + ((B.z - A.z) / len) * Math.min(1, len / 2) } : { x: A.x, z: A.z };
    out = { ...out, roads: [...out.roads, path(`rd_link_${added++}`, start, { x: B.x, z: B.z })] };
  }
  return { world: out, added, components: comps };
}

/** Seed guards, cameras and streetlights for a believable baseline night. */
export function seedBaseline(world: World, seed = 1): World {
  const r0 = makeRng(seed);
  const rng = () => r0.next();
  const W = world.bounds.width;
  const D = world.bounds.depth;
  const gates = world.site?.gates ?? [];
  const booths = world.site?.booths ?? [];
  const darks = (world.site?.areas ?? []).filter((a) => a.kind === "dark");
  const inDark = (p: Vec2) => darks.some((a) => Math.abs(p.x - a.x) < a.width / 2 && Math.abs(p.z - a.z) < a.depth / 2);
  const g = buildNavGraph(world);
  const routable = g.nodes.filter((n) => !n.connector && n.edges.length > 0);
  const nearestNode = (p: Vec2): Vec2 => {
    let best: Vec2 = p;
    let bd = Infinity;
    for (const n of routable) {
      const dd = d2(n, p);
      if (dd < bd) ((bd = dd), (best = { x: n.x, z: n.z }));
    }
    return best;
  };

  // streetlights every ~40 m along roads; ~25% gaps, more in paths / dark zones
  const streetlights: Streetlight[] = [...world.streetlights];
  if (!streetlights.length) {
    for (const r of world.roads) {
      if (r.id.startsWith("rd_link_") || r.id.startsWith("rd_snap_")) continue;
      const spacing = r.category === "road" ? 38 + rng() * 6 : 45;
      let carry = spacing / 2;
      for (let i = 1; i < r.points.length && streetlights.length < 240; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        const len = Math.sqrt(d2(a, b));
        let t = carry;
        while (t < len) {
          const p = { x: a.x + ((b.x - a.x) * t) / len, z: a.z + ((b.z - a.z) * t) / len };
          const gap = r.category === "path" ? 0.45 : 0.18;
          if (rng() > (inDark(p) ? 0.65 : gap) && Math.abs(p.x) < W / 2 && Math.abs(p.z) < D / 2) {
            streetlights.push({ id: `sl_inf_${streetlights.length}`, x: p.x, z: p.z, height: 7, brightness: 0.95, radius: 22, on: true, maintenance: rng() < 0.08 ? "faulty" : "ok" });
          }
          t += spacing;
        }
        carry = t - len;
      }
    }
  }

  // one inward-facing camera per gate
  const cameras: CctvCamera[] = [...world.cameras];
  if (!cameras.length) {
    gates.forEach((gt, i) => {
      cameras.push({ id: `cm_inf_${i}`, x: gt.x, z: gt.z, height: 4, range: 28, fovDeg: 90, orientationDeg: (Math.atan2(-gt.z, -gt.x) * 180) / Math.PI, active: true });
    });
  }

  // guards: one per gate/booth (max 3), patrolling a perimeter loop at ~70% of bounds
  const guards: Guard[] = [...world.guards];
  if (!guards.length && routable.length) {
    const posts = [...gates.map((p) => ({ x: p.x, z: p.z })), ...booths.map((p) => ({ x: p.x, z: p.z }))].slice(0, 3);
    if (!posts.length) posts.push({ x: 0, z: D * 0.35 });
    posts.forEach((post, gi) => {
      const ring: Vec2[] = [nearestNode(post)];
      const k = 6;
      const off = Math.atan2(post.z, post.x);
      for (let j = 1; j <= k; j++) {
        const a = off + (j / k) * Math.PI * 2 * (gi % 2 ? -1 : 1);
        const p = nearestNode({ x: Math.cos(a) * W * 0.33, z: Math.sin(a) * D * 0.33 });
        if (!ring.some((q) => d2(q, p) < 100)) ring.push(p);
      }
      guards.push({ id: `gd_inf_${gi}`, name: `Guard ${gi + 1} (${gi < gates.length ? "gate" : "booth"})`, speed: 1.15, waypoints: ring, active: true });
    });
  }

  return { ...world, streetlights, cameras, guards };
}

/**
 * Gates where mapped roads cross the compound wall — used when the vision model
 * returned none (it varies run to run), so every walled twin has entrances and
 * gate cameras/guards. Widest road = main gate; crossings < 25 m apart merge.
 */
export function inferGates(world: World, max = 3): SiteGate[] {
  const wall = world.site?.walls.find((w) => w.closed && w.points.length >= 3);
  if (!wall) return [];
  const ring = wall.points;
  const hits: { x: number; z: number; width: number; name?: string }[] = [];
  for (const r of world.roads) {
    if (r.inferred || r.category === "path") continue;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1];
      const b = r.points[i];
      for (let k = 0; k < ring.length; k++) {
        const c = ring[k];
        const d = ring[(k + 1) % ring.length];
        const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
        if (Math.abs(den) < 1e-9) continue;
        const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
        const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) hits.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z), width: r.width, name: r.name });
      }
    }
  }
  const picked: typeof hits = [];
  for (const h of hits.sort((p, q) => q.width - p.width)) {
    if (picked.length >= max) break;
    if (picked.some((p) => d2(p, h) < 25 * 25)) continue;
    picked.push(h);
  }
  return picked.map((p, i) => ({
    id: `gt_inf_${i}`,
    name: i === 0 ? `Main gate${p.name ? ` (${p.name})` : ""}` : `Gate ${i + 1}${p.name ? ` (${p.name})` : ""}`,
    kind: i === 0 ? ("main" as const) : ("service" as const),
    x: p.x,
    z: p.z,
    inferred: true,
  }));
}

export function prepareImportedWorld(world: World, seed = 1): { world: World; notes: string[] } {
  const gateNotes: string[] = [];
  if (world.site && !world.site.gates.length) {
    const gates = inferGates(world);
    if (gates.length) {
      world = { ...world, site: { ...world.site, gates } };
      gateNotes.push(`${gates.length} gate${gates.length === 1 ? "" : "s"} placed where mapped roads cross the compound wall — move them to the real entrances if needed.`);
    }
  }
  const conn = connectNetwork(world);
  const seeded = seedBaseline(conn.world, seed);
  const notes = [
    ...gateNotes,
    `Walkable network auto-connected (${conn.added} inferred connector paths, ${conn.components} component${conn.components === 1 ? "" : "s"}).`,
    `Inferred "current setup" baseline: ${seeded.guards.length} guards, ${seeded.cameras.length} gate cameras, ${seeded.streetlights.length} streetlights with deliberate gaps in back lanes and dark zones — edit to match reality.`,
  ];
  return { world: seeded, notes };
}
