"use client";

/**
 * Right inspector: context-sensitive properties for the selected object,
 * or scenario summary when nothing is selected.
 */

import { useEditor } from "@/lib/store/editor";
import { Button } from "@/components/ui/button";
import { nearestRoutableNode, buildNavGraph } from "@/lib/world/graph";
import { legBetween, polylineLength, routeLength } from "@/lib/world/patrol";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { World } from "@/lib/world/types";
import { NumberSlider, RotationControl, XZField, normDeg } from "./controls";
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block py-1" title={hint}>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[#8a8272]">{label}</div>
      {children}
    </label>
  );
}

/** Mix & match routes between guards: use / add / swap / share / reverse. */
function RouteMixer({ guardId, locked }: { guardId: string; locked: boolean }) {
  const world = useEditor((s) => s.project?.world);
  const copyRouteFrom = useEditor((s) => s.copyRouteFrom);
  const addRouteFrom = useEditor((s) => s.addRouteFrom);
  const swapRoutes = useEditor((s) => s.swapRoutes);
  const shareRoute = useEditor((s) => s.shareRoute);
  const reverseRoute = useEditor((s) => s.reverseRoute);
  const others = useMemo(() => {
    if (!world) return [];
    return world.guards
      .filter((g) => g.id !== guardId && g.waypoints.length > 0)
      .map((g) => ({
        id: g.id,
        label: `${g.name} · ${g.waypoints.length} stop${g.waypoints.length === 1 ? "" : "s"} · ${Math.round(routeLength(world, g.waypoints))} m`,
      }));
  }, [world, guardId]);
  const me = world?.guards.find((g) => g.id === guardId);
  const sel = (label: string, fn: (id: string) => void) => (
    <select
      key={label}
      value=""
      disabled={locked || !others.length}
      onChange={(e) => e.target.value && fn(e.target.value)}
      className="h-7 w-full rounded border border-[#dcd6c8] bg-white px-1 text-[11px] disabled:opacity-50"
      title={locked ? "Locked while a simulation is loaded" : label}
    >
      <option value="">{label}</option>
      {others.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
  return (
    <div className="my-1 space-y-1 rounded border border-[#e3ded4] bg-[#faf8f4] p-2">
      <div className="text-[10px] uppercase tracking-wide text-[#8a8272]">Mix &amp; match routes</div>
      {sel("Use route from…", (id) => copyRouteFrom(guardId, id))}
      {sel("Add route from…", (id) => addRouteFrom(guardId, id))}
      {sel("Swap routes with…", (id) => swapRoutes(guardId, id))}
      {sel("Share route with… (offset start)", (id) => shareRoute(guardId, id))}
      <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={locked || (me?.waypoints.length ?? 0) < 2} onClick={() => reverseRoute(guardId)}>
        Reverse direction
      </Button>
      {!others.length && <div className="text-[10px] text-[#8a8272]">Add another guard to reuse its route.</div>}
    </div>
  );
}

function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export default function Inspector() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const mutateWorld = useEditor((s) => s.mutateWorld);
  const deleteSelected = useEditor((s) => s.deleteSelected);
  const moveMode = useEditor((s) => s.moveMode);
  const setMoveMode = useEditor((s) => s.setMoveMode);
  const setTool = useEditor((s) => s.setTool);
  const locked = useEditor((s) => s.activeRun !== null);
  const routeDraw = useEditor((s) => s.routeDraw);
  const startRouteDraw = useEditor((s) => s.startRouteDraw);
  const finishRouteDraw = useEditor((s) => s.finishRouteDraw);
  const autoPatrolGuard = useEditor((s) => s.autoPatrolGuard);
  const clearRoute = useEditor((s) => s.clearRoute);

  const graphInfo = useMemo(() => {
    if (!project) return null;
    try {
      const g = buildNavGraph(project.world);
      return { stats: g.stats, graph: g };
    } catch {
      return null;
    }
  }, [project]);

  if (!project) return null;
  const world = project.world;

  const findSelected = (): { obj: any; kind: string } | null => {
    if (!selection) return null;
    switch (selection.kind) {
      case "streetlight":
        return { obj: world.streetlights.find((o) => o.id === selection.id), kind: selection.kind };
      case "camera":
        return { obj: world.cameras.find((o) => o.id === selection.id), kind: selection.kind };
      case "guard":
        return { obj: world.guards.find((o) => o.id === selection.id), kind: selection.kind };
      case "building":
        return { obj: world.buildings.find((o) => o.id === selection.id), kind: selection.kind };
      case "facility":
        return { obj: world.facilities.find((o) => o.id === selection.id), kind: selection.kind };
      case "road":
        return { obj: world.roads.find((o) => o.id === selection.id), kind: selection.kind };
    }
  };

  const found = findSelected();

  /** Edit the selected object; `field` groups a slider drag into one undo step. */
  const edit = <K extends "streetlights" | "cameras" | "buildings" | "facilities" | "roads">(list: K, field: string, fn: (o: World[K][number]) => void) => {
    if (!selection) return;
    const id = selection.id;
    mutateWorld(
      (d) => {
        const o = (d.world[list] as World[K][number][]).find((x) => x.id === id);
        if (o) fn(o);
      },
      { coalesce: `${id}:${field}` }
    );
  };
  const radToDeg = (r: number) => normDeg((-r * 180) / Math.PI); // three.js Y rotation → clockwise map degrees
  const degToRad = (d: number) => (-d * Math.PI) / 180;
  /** Direction (clockwise map degrees, folded to ±90) of the nearest mapped road to a point. */
  const nearestRoadDeg = (x: number, z: number): number | null => {
    let best: { d: number; deg: number } | null = null;
    for (const r of world.roads) {
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1) continue;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
        const d = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)) + (r.category === "path" ? 15 : 0);
        if (!best || d < best.d) best = { d, deg: (Math.atan2(dz, dx) * 180) / Math.PI };
      }
    }
    if (!best) return null;
    let deg = normDeg(best.deg);
    if (deg > 90) deg -= 180;
    if (deg <= -90) deg += 180;
    return Math.round(deg);
  };
  const isConnected =
    found && graphInfo && found.kind !== "road"
      ? (() => {
          const at = found.kind === "guard" ? (found.obj.waypoints?.[0] ?? { x: 0, z: 0 }) : found.obj;
          return nearestRoutableNode(graphInfo.graph, at.x as number, at.z as number) !== null;
        })()
      : null;

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-[#e3ded4] bg-[#faf8f4]" data-tour="inspector">
      <div className="border-b border-[#e9e4d8] px-3 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8a8272]">Inspector</div>
      </div>

      {locked && (<div className="border-b border-[#e9e4d8] bg-[#fff7e6] px-3 py-1.5 text-[11px] text-[#8a6d1f]">Simulation view — editing locked</div>)}
      <fieldset disabled={locked} className="m-0 min-w-0 flex-1 border-0 p-3">
        {!found && (
          <div className="space-y-3 text-xs text-[#5c6470]">
            <p>
              Nothing selected. Click an object in the 3D view to inspect and edit it, or pick a
              placement tool from the left.
            </p>
            {graphInfo && (
              <div className="rounded-md border border-[#e3ded4] bg-white p-2.5">
                <div className="font-medium text-[#1d2430]">Walkable network</div>
                <div className="mt-1 grid grid-cols-2 gap-1 text-[11px]">
                  <span>Nodes: {graphInfo.stats.nodeCount}</span>
                  <span>Links: {graphInfo.stats.edgeCount}</span>
                  <span className={graphInfo.stats.componentCount > 1 ? "text-[#b98a2f]" : "text-[#2e7d5b]"}>
                    Components: {graphInfo.stats.componentCount}
                  </span>
                  <span>Largest: {graphInfo.stats.largestSize ?? "—"} nodes</span>
                </div>
                {graphInfo.stats.componentCount > 1 && (
                  <p className="mt-1.5 text-[10px] leading-snug text-[#b98a2f]">
                    The pedestrian network has disconnected parts — agents cannot walk between them.
                    Connect them with a path.
                  </p>
                )}
              </div>
            )}
            <div className="rounded-md border border-[#e3ded4] bg-white p-2.5 text-[11px] leading-relaxed">
              <div className="font-medium text-[#1d2430]">Quick start</div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                <li>Inspect lighting & coverage</li>
                <li>Add streetlights on dark paths</li>
                <li>Run the baseline simulation</li>
                <li>Add an intervention & rerun</li>
                <li>Compare and export the report</li>
              </ol>
            </div>
          </div>
        )}

        {found && found.obj && (
          <div className="space-y-1 text-xs">
            <div className="mb-2 flex items-center justify-between">
              <span className="rounded-full bg-[#eef4f0] px-2 py-0.5 text-[10px] font-medium capitalize text-[#2e7d5b]">
                {found.kind.replace(/_/g, " ")}
              </span>
              <span className="font-mono text-[9px] text-[#8a8272]">{(found.obj as { id: string }).id}</span>
            </div>

            {isConnected === false && (
              <div className="mb-2 rounded border border-[#e6c98a] bg-[#fdf6e7] px-2 py-1.5 text-[10px] leading-snug text-[#7a5d1e]">
                This object is more than 30 m from the walkable network — agents may not be able to
                reach it. Move it closer to a road or path.
              </div>
            )}

            {selection?.kind === "streetlight" && (
              <>
                <XZField x={found.obj.x} z={found.obj.z} onChange={(x, z) => useEditor.getState().moveObject({ kind: "streetlight", id: selection.id }, x, z)} />
                <NumberSlider
                  label="Brightness"
                  unit="%"
                  min={10}
                  max={100}
                  value={Math.round(found.obj.brightness * 100)}
                  onChange={(v) => edit("streetlights", "brightness", (o) => void (o.brightness = v / 100))}
                />
                <NumberSlider
                  label="Light radius"
                  unit="m"
                  min={5}
                  max={45}
                  value={found.obj.radius}
                  presets={[
                    { label: "Path 12 m", value: 12 },
                    { label: "Street 20 m", value: 20 },
                    { label: "Flood 32 m", value: 32 },
                  ]}
                  onChange={(v) => edit("streetlights", "radius", (o) => void (o.radius = Math.round(v)))}
                />
                <NumberSlider
                  label="Pole height"
                  unit="m"
                  min={3}
                  max={16}
                  step={0.5}
                  value={found.obj.height}
                  onChange={(v) => edit("streetlights", "height", (o) => void (o.height = v))}
                />
                <div className="flex gap-3 py-1">
                  <label className="flex items-center gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={found.obj.on}
                      onChange={(e) =>
                        mutateWorld((d) => {
                          const o = d.world.streetlights.find((x) => x.id === selection.id);
                          if (o) o.on = e.target.checked;
                        })
                      }
                      className="h-3.5 w-3.5 accent-[#2e7d5b]"
                    />
                    On
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={found.obj.maintenance === "faulty"}
                      onChange={(e) =>
                        mutateWorld((d) => {
                          const o = d.world.streetlights.find((x) => x.id === selection.id);
                          if (o) o.maintenance = e.target.checked ? "faulty" : "ok";
                        })
                      }
                      className="h-3.5 w-3.5 accent-[#2e7d5b]"
                    />
                    Faulty
                  </label>
                </div>
              </>
            )}

            {selection?.kind === "camera" && (
              <>
                <XZField x={found.obj.x} z={found.obj.z} onChange={(x, z) => useEditor.getState().moveObject({ kind: "camera", id: selection.id }, x, z)} />
                <RotationControl
                  label="Facing"
                  value={normDeg(found.obj.orientationDeg)}
                  onChange={(deg) => edit("cameras", "facing", (o) => void (o.orientationDeg = deg))}
                  onAlign={() => {
                    const deg = nearestRoadDeg(found.obj.x, found.obj.z);
                    if (deg === null) return;
                    // look along the road, choosing the direction that points more toward the society centre
                    const toCentre = (Math.atan2(-found.obj.z, -found.obj.x) * 180) / Math.PI;
                    const diff = (a: number) => Math.abs(normDeg(a - toCentre));
                    edit("cameras", "align", (o) => void (o.orientationDeg = diff(deg) <= diff(deg + 180) ? deg : normDeg(deg + 180)));
                  }}
                  alignLabel="Look along road"
                  hint="Direction the camera looks, degrees clockwise from east. Keyboard: [ and ] rotate 15° (Shift = 1°)."
                />
                <NumberSlider
                  label="Field of view"
                  unit="°"
                  min={20}
                  max={360}
                  value={found.obj.fovDeg}
                  presets={[
                    { label: "Narrow 45°", value: 45 },
                    { label: "Standard 90°", value: 90 },
                    { label: "Wide 120°", value: 120 },
                    { label: "Dome 360°", value: 360 },
                  ]}
                  onChange={(v) => edit("cameras", "fov", (o) => void (o.fovDeg = Math.round(v)))}
                />
                <NumberSlider
                  label="Effective range"
                  unit="m"
                  min={5}
                  max={60}
                  value={found.obj.range}
                  onChange={(v) => edit("cameras", "range", (o) => void (o.range = Math.round(v)))}
                />
                <label className="flex items-center gap-1.5 py-1 text-[11px]">
                  <input
                    type="checkbox"
                    checked={found.obj.active}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.cameras.find((x) => x.id === selection.id);
                        if (o) o.active = e.target.checked;
                      })
                    }
                    className="h-3.5 w-3.5 accent-[#2e7d5b]"
                  />
                  Active this night
                </label>
              </>
            )}

            {selection?.kind === "guard" && (
              <>
                <Field label="Name">
                  <input
                    className="w-full rounded border border-[#dcd6c8] bg-white px-1.5 py-1 text-[11px]"
                    value={found.obj.name}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.guards.find((x) => x.id === selection.id);
                        if (o) o.name = e.target.value.slice(0, 40);
                      }, { coalesce: `${selection.id}:name` })
                    }
                  />
                </Field>
                <NumberSlider
                  label="Walking speed"
                  unit="m/s"
                  min={0.4}
                  max={2.5}
                  step={0.05}
                  value={found.obj.speed}
                  presets={[
                    { label: "Slow 0.9", value: 0.9 },
                    { label: "Patrol 1.15", value: 1.15 },
                    { label: "Brisk 1.5", value: 1.5 },
                  ]}
                  onChange={(v) =>
                    mutateWorld(
                      (d) => {
                        const o = d.world.guards.find((x) => x.id === selection.id);
                        if (o) o.speed = v;
                      },
                      { coalesce: `${selection.id}:speed` }
                    )
                  }
                />
                <label className="flex items-center gap-1.5 py-1 text-[11px]">
                  <input
                    type="checkbox"
                    checked={found.obj.active}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.guards.find((x) => x.id === selection.id);
                        if (o) o.active = e.target.checked;
                      })
                    }
                    className="h-3.5 w-3.5 accent-[#2e7d5b]"
                  />
                  Active this night
                </label>
                {(() => {
                  const wps = found.obj.waypoints as { x: number; z: number }[];
                  let len = 0;
                  if (graphInfo && wps.length > 1) {
                    for (let i = 0; i < wps.length; i++) {
                      len += polylineLength(legBetween(graphInfo.graph, wps[i], wps[(i + 1) % wps.length]));
                    }
                  }
                  const secs = found.obj.speed > 0 ? len / found.obj.speed : 0;
                  return (
                    <div className="my-1 rounded border border-[#e3ded4] bg-white p-2 text-[11px] text-[#5c6470]">
                      <div className="flex justify-between"><span>Waypoints</span><span className="font-medium text-[#1d2430]">{wps.length}</span></div>
                      <div className="flex justify-between"><span>Patrol length (loop)</span><span className="font-medium text-[#1d2430]">{Math.round(len)} m</span></div>
                      <div className="flex justify-between"><span>Loop time @ {found.obj.speed} m/s</span><span className="font-medium text-[#1d2430]">{secs >= 60 ? `${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s` : `${Math.round(secs)} s`}</span></div>
                    </div>
                  );
                })()}
                <div className="flex flex-wrap gap-1.5 py-1">
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={locked} onClick={() => startRouteDraw(selection.id)}>
                    Extend route
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={locked} onClick={() => autoPatrolGuard(selection.id)}>
                    Auto patrol
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={locked || found.obj.waypoints.length < 2} onClick={() => clearRoute(selection.id)}>
                    Clear route
                  </Button>
                  {routeDraw?.guardId === selection.id && (
                    <Button size="sm" className="h-7 bg-[#2e7d5b] text-[11px] text-white hover:bg-[#276c4f]" onClick={finishRouteDraw}>
                      Finish route
                    </Button>
                  )}
                </div>
                <RouteMixer guardId={selection.id} locked={locked} />
                <p className="py-0.5 text-[10px] leading-snug text-[#8a8272]">
                  Guard tool (G): right-click drops a new guard, left-click adds stops to the selected guard · Enter to finish · Backspace removes the last stop · Esc deselects. Drag a numbered handle to move it, click the route to insert a stop, right-click or Delete to remove one.
                </p>
                <Field label={`Waypoints — ${found.obj.waypoints.length}`} hint="Patrol loops through these points in order">
                  <div className="space-y-1">
                    {found.obj.waypoints.map((w, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <span className="w-4 text-[10px] text-[#8a8272]">{i + 1}.</span>
                        <input
                          className="w-full rounded border border-[#dcd6c8] bg-white px-1 py-0.5 font-mono text-[10px]"
                          value={num(w.x)}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value) || 0;
                            mutateWorld((d) => {
                              const o = d.world.guards.find((x) => x.id === selection.id);
                              if (o) o.waypoints[i].x = v;
                            });
                          }}
                        />
                        <input
                          className="w-full rounded border border-[#dcd6c8] bg-white px-1 py-0.5 font-mono text-[10px]"
                          value={num(w.z)}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value) || 0;
                            mutateWorld((d) => {
                              const o = d.world.guards.find((x) => x.id === selection.id);
                              if (o) o.waypoints[i].z = v;
                            });
                          }}
                        />
                        <button
                          className="px-1 text-[11px] text-[#8a8272] hover:text-[#c23b3b]"
                          title="Remove waypoint"
                          onClick={() =>
                            mutateWorld((d) => {
                              const o = d.world.guards.find((x) => x.id === selection.id);
                              if (o && o.waypoints.length > 1) o.waypoints.splice(i, 1);
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </Field>
              </>
            )}

            {selection?.kind === "building" && (
              <>
                <Field label="Name">
                  <input
                    className="w-full rounded border border-[#dcd6c8] bg-white px-1.5 py-1 text-[11px]"
                    value={found.obj.name ?? ""}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.buildings.find((x) => x.id === selection.id);
                        if (o) o.name = e.target.value.slice(0, 60);
                      }, { coalesce: `${selection.id}:name` })
                    }
                  />
                </Field>
                <Field label="Category">
                  <select
                    className="w-full rounded border border-[#dcd6c8] bg-white px-1.5 py-1 text-[11px]"
                    value={found.obj.category}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.buildings.find((x) => x.id === selection.id);
                        if (o) o.category = e.target.value as typeof o.category;
                      })
                    }
                  >
                    {["residential", "commercial", "community", "mixed", "other"].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="my-1 rounded-md border border-[#e3ded4] bg-white px-2 py-1">
                  <div className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-[#1d2430]">Shape &amp; placement</div>
                  <XZField
                    x={found.obj.x}
                    z={found.obj.z}
                    onChange={(x, z) => useEditor.getState().moveObject({ kind: "building", id: selection.id }, x, z)}
                  />
                  <NumberSlider
                    label="Width"
                    unit="m"
                    min={2}
                    max={200}
                    sliderMax={120}
                    step={0.5}
                    value={found.obj.width}
                    onChange={(v) => edit("buildings", "width", (o) => void (o.width = v))}
                  />
                  <NumberSlider
                    label="Depth"
                    unit="m"
                    min={2}
                    max={200}
                    sliderMax={120}
                    step={0.5}
                    value={found.obj.depth}
                    onChange={(v) => edit("buildings", "depth", (o) => void (o.depth = v))}
                  />
                  <div className="-mt-0.5 flex justify-end">
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px] text-[#5c6470] hover:bg-[#f4f2ec]"
                      onClick={() =>
                        edit("buildings", "swap", (o) => {
                          [o.width, o.depth] = [o.depth, o.width];
                        })
                      }
                      title="Swap width and depth (same as turning the footprint 90°)"
                    >
                      ⇄ Swap width / depth
                    </button>
                  </div>
                  <RotationControl
                    value={radToDeg(found.obj.rotation)}
                    onChange={(deg) => edit("buildings", "rotation", (o) => void (o.rotation = degToRad(deg)))}
                    onAlign={() => {
                      const deg = nearestRoadDeg(found.obj.x, found.obj.z);
                      if (deg !== null) edit("buildings", "align", (o) => void (o.rotation = degToRad(deg)));
                    }}
                  />
                </div>
                <NumberSlider
                  label="Floors"
                  unit={`fl · ${found.obj.height} m`}
                  min={1}
                  max={45}
                  sliderMax={40}
                  value={found.obj.floors}
                  presets={[
                    { label: "House 2", value: 2 },
                    { label: "Apts 5", value: 5 },
                    { label: "Tower 14", value: 14 },
                    { label: "High-rise 24", value: 24 },
                  ]}
                  onChange={(v) =>
                    edit("buildings", "floors", (o) => {
                      o.floors = Math.round(v);
                      o.height = o.floors * 3;
                    })
                  }
                />
                <NumberSlider
                  label="Overnight occupancy"
                  unit="people"
                  min={0}
                  max={3000}
                  sliderMax={600}
                  hint="Synthetic estimate used to seed simulated residents"
                  value={found.obj.occupancy}
                  onChange={(v) => edit("buildings", "occupancy", (o) => void (o.occupancy = Math.round(v)))}
                />
                {found.obj.inferred && (
                  <p className="py-1 text-[10px] text-[#b98a2f]">
                    Shape or height was estimated during import — correct it here if you know the real building.
                  </p>
                )}
                <p className="pt-1 text-[10px] leading-snug text-[#8a8272]">
                  Drag the building in the 3D view to move it (Edit mode) · <kbd className="rounded bg-[#f1ede4] px-1">[</kbd>{" "}
                  <kbd className="rounded bg-[#f1ede4] px-1">]</kbd> rotate · arrow keys nudge
                </p>
              </>
            )}

            {selection?.kind === "facility" && (
              <>
                <Field label="Name">
                  <input
                    className="w-full rounded border border-[#dcd6c8] bg-white px-1.5 py-1 text-[11px]"
                    value={found.obj.name ?? ""}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.facilities.find((x) => x.id === selection.id);
                        if (o) o.name = e.target.value.slice(0, 60);
                      }, { coalesce: `${selection.id}:name` })
                    }
                  />
                </Field>
                <Field label="Type">
                  <select
                    className="w-full rounded border border-[#dcd6c8] bg-white px-1.5 py-1 text-[11px]"
                    value={found.obj.type}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.facilities.find((x) => x.id === selection.id);
                        if (o) o.type = e.target.value as typeof o.type;
                      })
                    }
                  >
                    {["bus_stop", "park", "community_centre", "market", "school", "clinic", "atm", "place_of_worship", "other"].map((c) => (
                      <option key={c} value={c}>
                        {c.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </Field>
                <XZField x={found.obj.x} z={found.obj.z} onChange={(x, z) => useEditor.getState().moveObject({ kind: "facility", id: selection.id }, x, z)} />
                {found.obj.type === "park" && (
                  <NumberSlider
                    label="Park radius"
                    unit="m"
                    min={5}
                    max={90}
                    value={found.obj.radius ?? 20}
                    onChange={(v) => edit("facilities", "radius", (o) => void (o.radius = Math.round(v)))}
                  />
                )}
              </>
            )}

            {selection?.kind === "road" && (
              <>
                <Field label="Name">
                  <input
                    className="w-full rounded border border-[#dcd6c8] bg-white px-1.5 py-1 text-[11px]"
                    value={found.obj.name ?? ""}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.roads.find((x) => x.id === selection.id);
                        if (o) o.name = e.target.value.slice(0, 60);
                      }, { coalesce: `${selection.id}:name` })
                    }
                  />
                </Field>
                <Field label="Category">
                  <select
                    className="w-full rounded border border-[#dcd6c8] bg-white px-1.5 py-1 text-[11px]"
                    value={found.obj.category}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.roads.find((x) => x.id === selection.id);
                        if (o) o.category = e.target.value as "road" | "path";
                      })
                    }
                  >
                    <option value="road">road</option>
                    <option value="path">pedestrian path</option>
                  </select>
                </Field>
                <NumberSlider
                  label="Width"
                  unit="m"
                  min={1.5}
                  max={16}
                  step={0.5}
                  value={found.obj.width}
                  presets={[
                    { label: "Footpath 2", value: 2 },
                    { label: "Lane 4.5", value: 4.5 },
                    { label: "Road 6.5", value: 6.5 },
                    { label: "Main 10", value: 10 },
                  ]}
                  onChange={(v) => edit("roads", "width", (o) => void (o.width = v))}
                />
                <label className="flex items-center gap-1.5 py-1 text-[11px]">
                  <input
                    type="checkbox"
                    checked={found.obj.pedestrian}
                    onChange={(e) =>
                      mutateWorld((d) => {
                        const o = d.world.roads.find((x) => x.id === selection.id);
                        if (o) o.pedestrian = e.target.checked;
                      })
                    }
                    className="h-3.5 w-3.5 accent-[#2e7d5b]"
                  />
                  Walkable by pedestrians
                </label>
                {(() => {
                  const pts = (found.obj.points ?? []) as { x: number; z: number }[];
                  let len = 0;
                  for (let i = 0; i + 1 < pts.length; i++) {
                    len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
                  }
                  return (
                    <div className="mt-2 rounded border border-[#e3ded4] bg-white p-2 text-[11px] text-[#5c6470]">
                      <div className="flex justify-between">
                        <span>Corridor length:</span>
                        <span className="font-medium text-[#1d2430]">{Math.round(len)} m</span>
                      </div>
                      <div className="mt-0.5 flex justify-between">
                        <span>Waypoints:</span>
                        <span className="font-medium text-[#1d2430]">{pts.length} nodes</span>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}

            {/* actions */}
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[#e9e4d8] pt-3">
              <Button
                size="sm"
                variant="outline"
                className={cn("h-7 text-[11px]", moveMode && "border-[#2e7d5b] bg-[#eef4f0] text-[#2e7d5b]")}
                onClick={() => setMoveMode(!moveMode)}
              >
                {moveMode ? "Click the map…" : "Move"}
              </Button>
              {selection && selection.kind !== "guard" && selection.kind !== "road" && (
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => useEditor.getState().duplicateSelected()} title="Duplicate (Ctrl+D)">
                  Duplicate
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-[#c23b3b]/40 text-[11px] text-[#c23b3b] hover:bg-[#fbf0f0]"
                onClick={() => {
                  setTool("select");
                  deleteSelected();
                }}
              >
                Delete
              </Button>
            </div>
            <p className="mt-2 text-[10px] leading-snug text-[#8a8272]">
              Ctrl+Z undoes any change · Ctrl+D duplicates · arrows nudge 1 m (Shift 5 m)
              {(selection?.kind === "building" || selection?.kind === "camera") && " · [ ] rotate 15° (Shift 1°)"}
            </p>
          </div>
        )}
      </fieldset>
    </aside>
  );
}
