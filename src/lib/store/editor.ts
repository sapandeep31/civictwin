"use client";

/**
 * Central editor state (Zustand).
 *
 * Canvas playback time lives in a module-level mutable clock that the 3D
 * scene reads every frame without triggering React re-renders. UI components
 * that display time poll the clock on a light interval instead.
 */

import { create } from "zustand";
import type {
  CctvCamera,
  Facility,
  FacilityType,
  Guard,
  PraesidiumProject,
  ScenarioConfig,
  Streetlight,
  Building,
  Road,
} from "@/lib/world/types";
import { defaultScenario } from "@/lib/world/types";
import { makeId, deepClone } from "@/lib/world/ids";
import { makeDemoProject, DEMO_PROJECT_ID, DEMO_NAME, LEGACY_DEMO_NAMES, isLegacyDemo } from "@/lib/world/demo";
import { makeBlankProject } from "@/lib/world/blank";
import type { ActiveRun } from "@/lib/sim/runner";
import { saveProject } from "@/lib/storage/projects";
import { snapToWalkable, autoPatrol,appendRoutes, reverseRoute as reversePts, rotateRoute, halfLoopOffset } from "@/lib/world/patrol";

export type Tool =
  | "select"
  | "road"
  | "building"
  | "facility"
  | "streetlight"
  | "camera"
  | "guard";

export type Selection =
  | { kind: "streetlight"; id: string }
  | { kind: "camera"; id: string }
  | { kind: "guard"; id: string }
  | { kind: "building"; id: string }
  | { kind: "facility"; id: string }
  | { kind: "road"; id: string }
  | null;

export type Screen = "welcome" | "editor";

export interface LayerVisibility {
  lighting: boolean;
  cctv: boolean;
  coverage: boolean;
  labels: boolean;
  /** Satellite ground texture (geo imports only). */
  satellite?: boolean;
  /** Compound walls, gates, parking & dark-zone overlays. */
  site?: boolean;
}

/** Module-level playback clock — read every animation frame by the 3D scene. */
export const playbackClock = { t: 0 };

/** Module-level live drag position — read every animation frame by dragged objects. */
export const liveMove: { id: string | null; x: number; z: number } = { id: null, x: 0, z: 0 };

export type EditMode = "navigate" | "edit";

/** True while a simulation run is loaded: the society must not be edited. */
export const isLocked = (s: { activeRun: unknown }) => s.activeRun !== null;

export type DragKind = "streetlight" | "camera" | "facility" | "guard" | "building";

export interface DragState {
  kind: DragKind;
  id: string;
  offsetX: number;
  offsetZ: number;
  moved: boolean;
  origin: { x: number; z: number };
}

interface EditorState {
  screen: Screen;
  project: PraesidiumProject | null;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: string | null;

  mode: EditMode;
  setMode: (m: EditMode) => void;
  exitSimulation: () => void;
  tool: Tool;
  selection: Selection;
  roadDraft: { x: number; z: number }[];
  facilityType: FacilityType;
  dragState: DragState | null;

  layers: LayerVisibility;
  sceneTheme: "night" | "sunset" | "daylight";
  showScenarioPanel: boolean;
  resultsOpen: boolean;
  compareOpen: boolean;
  assistantOpen: boolean;
  importOpen: boolean;

  history: { past: PraesidiumProject[]; future: PraesidiumProject[] };

  // playback
  activeRun: ActiveRun | null;
  runKind: "baseline" | "intervention" | "preview" | null;
  playing: boolean;
  speed: number;
  displayT: number; // throttled mirror of playbackClock for UI

  // actions
  openWelcome: () => void;
  openDemo: () => void;
  newBlank: () => void;
  openProject: (p: PraesidiumProject) => void;
  resetDemo: () => void;
  setScreen: (s: Screen) => void;

  setTool: (t: Tool) => void;
  setFacilityType: (t: FacilityType) => void;
  select: (s: Selection) => void;
  beginDrag: (kind: DragKind, id: string, offsetX: number, offsetZ: number) => void;
  updateDrag: (x: number, z: number) => void;
  endDrag: () => void;
  moveMode: boolean;
  setMoveMode: (v: boolean) => void;
  setRoadDraft: (pts: { x: number; z: number }[]) => void;
  pushRoadPoint: (p: { x: number; z: number }) => void;
  commitRoad: () => void;
  cancelRoad: () => void;

  /** `coalesce`: edits with the same key within ~1 s merge into one undo step (slider drags). */
  mutateWorld: (fn: (draft: PraesidiumProject) => void, opts?: { silent?: boolean; coalesce?: string }) => void;
  addStreetlight: (x: number, z: number) => void;
  addCamera: (x: number, z: number) => void;
  addGuard: (x: number, z: number) => void;
  /** Patrol-route editing (all undoable, blocked while a simulation is loaded). */
  routeDraw: { guardId: string } | null;
  waypointSel: number | null;
  setWaypointSel: (i: number | null) => void;
  startRouteDraw: (guardId: string) => void;
  finishRouteDraw: () => void;
  appendWaypoint: (guardId: string, p: { x: number; z: number }) => void;
  insertWaypoint: (guardId: string, index: number, p: { x: number; z: number }) => void;
  moveWaypoint: (guardId: string, index: number, p: { x: number; z: number }) => void;
  removeWaypoint: (guardId: string, index: number) => void;
  removeLastWaypoint: () => void;
  clearRoute: (guardId: string) => void;
  autoPatrolGuard: (guardId: string) => void;
  /** Mix & match routes between guards (undoable, blocked while locked). */
  copyRouteFrom: (guardId: string, sourceId: string) => void;
  addRouteFrom: (guardId: string, sourceId: string) => void;
  swapRoutes: (guardId: string, otherId: string) => void;
  reverseRoute: (guardId: string) => void;
  shareRoute: (guardId: string, sourceId: string) => void;
  /** Transient on-canvas hint (auto-clears). */
  guardToolClick: (p: { x: number; z: number }) => void;
  canvasHint: string | null;
  flashHint: (msg: string) => void;
  addBuilding: (x: number, z: number) => void;
  addFacility: (x: number, z: number) => void;
  moveObject: (sel: NonNullable<Selection>, x: number, z: number) => void;
  deleteSelected: () => void;

  /** Copy the selected light/camera/building/facility beside the original and select the copy. */
  duplicateSelected: () => void;
  /** Move the selected object by (dx, dz) metres. */
  nudgeSelected: (dx: number, dz: number) => void;
  /** Rotate the selected building / camera by `deg` (clockwise on the map). */
  rotateSelected: (deg: number) => void;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;
  markSaved: () => void;
  renameProject: (name: string) => void;

  toggleLayer: (k: keyof LayerVisibility) => void;
  setScenarioPanel: (v: boolean) => void;
  setSceneTheme: (t: "night" | "sunset" | "daylight") => void;
  setResultsOpen: (v: boolean) => void;
  setCompareOpen: (v: boolean) => void;
  setAssistantOpen: (v: boolean) => void;
  setImportOpen: (v: boolean) => void;

  updateScenario: (patch: Partial<ScenarioConfig>) => void;

  setActiveRun: (run: ActiveRun | null, kind: EditorState["runKind"]) => void;
  setPlaying: (v: boolean) => void;
  setSpeed: (v: number) => void;
  seek: (t: number) => void;
  tickDisplay: () => void;
}

const HISTORY_LIMIT = 50;
let lastCoalesce: { key: string; at: number } | null = null;

export const useEditor = create<EditorState>((set, get) => ({
  screen: "welcome",
  project: null,
  dirty: false,
  saving: false,
  lastSavedAt: null,

  mode: "navigate",
  tool: "select",
  selection: null,
  roadDraft: [],
  facilityType: "bus_stop",
  dragState: null,
  moveMode: false,

  layers: { lighting: true, cctv: true, coverage: false, labels: true, satellite: true, site: true },
  sceneTheme: "night",
  showScenarioPanel: true,
  resultsOpen: false,
  compareOpen: false,
  assistantOpen: false,
  importOpen: false,

  history: { past: [], future: [] },

  activeRun: null,
  runKind: null,
  playing: false,
  speed: 1,
  displayT: 0,

  openWelcome: () => set({ screen: "welcome" }),
  setScreen: (s) => set({ screen: s }),

  openDemo: () => {
    const p = makeDemoProject();
    set({
      screen: "editor",
      project: p,
      dirty: false,
      selection: null,
      tool: "select",
      mode: "navigate",
      roadDraft: [],
      history: { past: [], future: [] },
      activeRun: null,
      runKind: null,
      playing: false,
    });
    playbackClock.t = 0;
    void get().save();
  },

  newBlank: () => {
    const p = makeBlankProject();
    set({
      screen: "editor",
      project: p,
      dirty: false,
      selection: null,
      tool: "select",
      mode: "navigate",
      roadDraft: [],
      history: { past: [], future: [] },
      activeRun: null,
      runKind: null,
      playing: false,
    });
    playbackClock.t = 0;
    void get().save();
  },

  openProject: (raw) => {
    // a saved copy of an older bundled demo is migrated to the current demo society
    let p = raw;
    if (isLegacyDemo(raw)) {
      const fresh = makeDemoProject();
      fresh.projectId = raw.projectId;
      p = fresh;
    }
    set({
      screen: "editor",
      project: p,
      dirty: false,
      selection: null,
      tool: "select",
      mode: "navigate",
      roadDraft: [],
      history: { past: [], future: [] },
      activeRun: null,
      runKind: null,
      playing: false,
    });
    playbackClock.t = 0;
  },

  resetDemo: () => {
    const cur = get().project;
    if (!cur) return;
    const fresh = makeDemoProject();
    fresh.projectId = cur.projectId; // replace in place
    fresh.name = cur.name === DEMO_NAME || LEGACY_DEMO_NAMES.includes(cur.name) ? fresh.name : cur.name;
    set((s) => ({
      project: fresh,
      dirty: true,
      history: { past: [...s.history.past, deepClone(s.project!)].slice(-HISTORY_LIMIT), future: [] },
      activeRun: null,
      runKind: null,
      playing: false,
      selection: null,
    }));
    playbackClock.t = 0;
  },

  setMode: (m) => {
    const s = get();
    if (m === "edit" && isLocked(s)) return;
    if (m === "navigate") {
      if (s.dragState) get().endDrag();
      set({ mode: "navigate", tool: "select", roadDraft: [], moveMode: false, routeDraw: null, waypointSel: null });
    } else set({ mode: "edit" });
  },
  exitSimulation: () => {
    playbackClock.t = 0;
    set({ activeRun: null, runKind: null, playing: false, displayT: 0, mode: "edit" });
  },

  setTool: (t) => {
    if (isLocked(get()) && t !== "select") return;
    set({ tool: t, roadDraft: [], moveMode: false, routeDraw: null, waypointSel: null, ...(t !== "select" ? { mode: "edit" as const } : {}) });
  },
  setFacilityType: (t) => set({ facilityType: t }),
  select: (sel) => {
    const rd = get().routeDraw;
    const keep = rd && sel?.kind === "guard" && sel.id === rd.guardId;
    set({ selection: sel, tool: sel ? "select" : get().tool, moveMode: false, waypointSel: null, ...(keep ? {} : { routeDraw: null }) });
  },

  beginDrag: (kind, id, offsetX, offsetZ) => {
    if (isLocked(get()) || get().mode !== "edit") return;
    const sel =
      kind === "streetlight"
        ? get().project?.world.streetlights.find((o) => o.id === id)
        : kind === "camera"
          ? get().project?.world.cameras.find((o) => o.id === id)
          : kind === "guard"
            ? get().project?.world.guards.find((o) => o.id === id)
            : kind === "building"
              ? get().project?.world.buildings.find((o) => o.id === id)
              : get().project?.world.facilities.find((o) => o.id === id);
    const origin = sel ? { x: (sel as { x: number; z: number }).x, z: (sel as { x: number; z: number }).z } : { x: 0, z: 0 };
    liveMove.id = null;
    set({ dragState: { kind, id, offsetX, offsetZ, moved: false, origin } });
  },

  updateDrag: (x, z) => {
    const ds = get().dragState;
    if (!ds) return;
    liveMove.id = ds.id;
    liveMove.x = x + ds.offsetX;
    liveMove.z = z + ds.offsetZ;
    if (!ds.moved && (Math.abs(liveMove.x - ds.origin.x) > 0.5 || Math.abs(liveMove.z - ds.origin.z) > 0.5)) {
      set({ dragState: { ...ds, moved: true } });
    }
  },

  endDrag: () => {
    const ds = get().dragState;
    set({ dragState: null });
    if (!ds) return;
    if (liveMove.id === ds.id && ds.moved) {
      const { x, z } = liveMove;
      liveMove.id = null;
      get().moveObject({ kind: ds.kind, id: ds.id } as never, x, z);
    } else {
      liveMove.id = null;
    }
  },

  setMoveMode: (v) => {
    if (v && isLocked(get())) return;
    set(v ? { moveMode: true, mode: "edit" } : { moveMode: false });
  },
  setRoadDraft: (pts) => set({ roadDraft: pts }),
  pushRoadPoint: (p) => set((s) => ({ roadDraft: [...s.roadDraft, p] })),
  commitRoad: () => {
    const { roadDraft, project } = get();
    if (isLocked(get())) return;
    if (!project || roadDraft.length < 2) return;
    const road: Road = {
      id: makeId("rd"),
      name: undefined,
      points: deepClone(roadDraft),
      width: 4,
      category: "road",
      pedestrian: true,
    };
    get().mutateWorld((d) => {
      d.world.roads.push(road);
    });
    set({ roadDraft: [], selection: { kind: "road", id: road.id }, tool: "select" });
  },
  cancelRoad: () => set({ roadDraft: [] }),

  mutateWorld: (fn, opts) => {
    const { project } = get();
    if (!project) return;
    const draft = deepClone(project);
    fn(draft);
    draft.modifiedAt = new Date().toISOString();
    // a slider drag (same control, quick succession) is ONE undo step, not one per tick
    const now = Date.now();
    const merged = !!opts?.coalesce && lastCoalesce?.key === opts.coalesce && now - lastCoalesce.at < 900;
    lastCoalesce = opts?.coalesce ? { key: opts.coalesce, at: now } : null;
    if (!opts?.silent && !merged) {
      set((s) => ({
        project: draft,
        dirty: true,
        history: { past: [...s.history.past, project].slice(-HISTORY_LIMIT), future: [] },
      }));
    } else {
      set({ project: draft, dirty: true });
    }
    scheduleAutosave(get, set);
  },

  addStreetlight: (x, z) => {
    if (isLocked(get())) return;
    const l: Streetlight = {
      id: makeId("sl"),
      x,
      z,
      height: 8,
      brightness: 0.85,
      radius: 18,
      on: true,
      maintenance: "ok",
    };
    get().mutateWorld((d) => {
      d.world.streetlights.push(l);
    });
    set({ selection: { kind: "streetlight", id: l.id } });
  },

  addCamera: (x, z) => {
    if (isLocked(get())) return;
    const c: CctvCamera = {
      id: makeId("cam"),
      x,
      z,
      height: 6.5,
      range: 28,
      fovDeg: 80,
      orientationDeg: 0,
      active: true,
    };
    get().mutateWorld((d) => {
      d.world.cameras.push(c);
    });
    set({ selection: { kind: "camera", id: c.id } });
  },

  addGuard: (x, z) => {
    if (isLocked(get())) return;
    const g: Guard = {
      id: makeId("gd"),
      name: `Guard ${get().project?.world.guards.length ? get().project!.world.guards.length + 1 : 1}`,
      speed: 1.1,
      waypoints: [{ x, z }],
      active: true,
    };
    get().mutateWorld((d) => {
      d.world.guards.push(g);
    });
    set({ selection: { kind: "guard", id: g.id }, routeDraw: { guardId: g.id }, waypointSel: null });
  },

  routeDraw: null,
  waypointSel: null,
  setWaypointSel: (i) => set({ waypointSel: i }),

  startRouteDraw: (guardId) => {
    if (isLocked(get())) return;
    set({ routeDraw: { guardId }, selection: { kind: "guard", id: guardId }, mode: "edit", waypointSel: null, moveMode: false });
  },
  finishRouteDraw: () => {
    if (!get().routeDraw) return;
    // Guard tool stays armed (and deselects) so the next right-click drops another guard.
    if (get().tool === "guard") set({ routeDraw: null, selection: null, waypointSel: null });
    else set({ routeDraw: null, tool: "select" });
  },
  guardToolClick: (p) => {
    const s = get();
    if (isLocked(s) || !s.project) return;
    const id = s.routeDraw?.guardId ?? (s.selection?.kind === "guard" ? s.selection.id : null);
    if (!id) {
      get().flashHint("Right-click to drop a guard first");
      return;
    }
    if (!s.routeDraw) get().startRouteDraw(id);
    get().appendWaypoint(id, snapToWalkable(s.project.world, p));
  },
  canvasHint: null,
  flashHint: (msg) => {
    set({ canvasHint: msg });
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => set({ canvasHint: null }), 2600);
  },
  appendWaypoint: (guardId, p) => {
    if (isLocked(get())) return;
    const g = get().project?.world.guards.find((o) => o.id === guardId);
    if (!g) return;
    const last = g.waypoints[g.waypoints.length - 1];
    if (last && Math.hypot(last.x - p.x, last.z - p.z) < 1.5) return; // double-click / duplicate
    get().mutateWorld((d) => {
      d.world.guards.find((o) => o.id === guardId)?.waypoints.push({ x: p.x, z: p.z });
    });
  },
  insertWaypoint: (guardId, index, p) => {
    if (isLocked(get())) return;
    get().mutateWorld((d) => {
      const o = d.world.guards.find((x) => x.id === guardId);
      if (o) o.waypoints.splice(Math.max(0, Math.min(index, o.waypoints.length)), 0, { x: p.x, z: p.z });
    });
    set({ waypointSel: Math.max(0, index) });
  },
  moveWaypoint: (guardId, index, p) => {
    if (isLocked(get())) return;
    get().mutateWorld((d) => {
      const o = d.world.guards.find((x) => x.id === guardId);
      if (o && o.waypoints[index]) o.waypoints[index] = { x: p.x, z: p.z };
    });
  },
  removeWaypoint: (guardId, index) => {
    if (isLocked(get())) return;
    const g = get().project?.world.guards.find((o) => o.id === guardId);
    if (!g || g.waypoints.length <= 1 || !g.waypoints[index]) return;
    get().mutateWorld((d) => {
      d.world.guards.find((x) => x.id === guardId)?.waypoints.splice(index, 1);
    });
    set({ waypointSel: null });
  },
  removeLastWaypoint: () => {
    const s = get();
    const id = s.routeDraw?.guardId ?? (s.tool === "guard" && s.selection?.kind === "guard" ? s.selection.id : null);
    if (!id) return;
    const g = s.project?.world.guards.find((o) => o.id === id);
    if (g) get().removeWaypoint(id, g.waypoints.length - 1);
  },
  copyRouteFrom: (guardId, sourceId) => {
    const s = get();
    if (isLocked(s) || guardId === sourceId) return;
    const src = s.project?.world.guards.find((o) => o.id === sourceId);
    if (!src || !src.waypoints.length) return;
    get().mutateWorld((d) => {
      const o = d.world.guards.find((x) => x.id === guardId);
      if (o) o.waypoints = src.waypoints.map((w) => ({ x: w.x, z: w.z }));
    });
    set({ waypointSel: null, routeDraw: null });
  },
  addRouteFrom: (guardId, sourceId) => {
    const s = get();
    if (isLocked(s) || guardId === sourceId) return;
    const src = s.project?.world.guards.find((o) => o.id === sourceId);
    const g = s.project?.world.guards.find((o) => o.id === guardId);
    if (!src || !g || !src.waypoints.length) return;
    const merged = appendRoutes(g.waypoints, src.waypoints);
    get().mutateWorld((d) => {
      const o = d.world.guards.find((x) => x.id === guardId);
      if (o) o.waypoints = merged;
    });
    set({ waypointSel: null, routeDraw: null });
  },
  swapRoutes: (guardId, otherId) => {
    const s = get();
    if (isLocked(s) || guardId === otherId) return;
    const a = s.project?.world.guards.find((o) => o.id === guardId);
    const b = s.project?.world.guards.find((o) => o.id === otherId);
    if (!a || !b) return;
    const wa = a.waypoints.map((w) => ({ x: w.x, z: w.z }));
    const wb = b.waypoints.map((w) => ({ x: w.x, z: w.z }));
    get().mutateWorld((d) => {
      const oa = d.world.guards.find((x) => x.id === guardId);
      const ob = d.world.guards.find((x) => x.id === otherId);
      if (oa && ob) {
        oa.waypoints = wb;
        ob.waypoints = wa;
      }
    });
    set({ waypointSel: null, routeDraw: null });
  },
  reverseRoute: (guardId) => {
    const s = get();
    if (isLocked(s)) return;
    const g = s.project?.world.guards.find((o) => o.id === guardId);
    if (!g || g.waypoints.length < 2) return;
    get().mutateWorld((d) => {
      const o = d.world.guards.find((x) => x.id === guardId);
      if (o) o.waypoints = reversePts(o.waypoints);
    });
    set({ waypointSel: null });
  },
  shareRoute: (guardId, sourceId) => {
    const s = get();
    if (isLocked(s) || guardId === sourceId) return;
    const src = s.project?.world.guards.find((o) => o.id === sourceId);
    if (!src || !src.waypoints.length) return;
    const shared = rotateRoute(src.waypoints, halfLoopOffset(src.waypoints));
    get().mutateWorld((d) => {
      const o = d.world.guards.find((x) => x.id === guardId);
      if (o) o.waypoints = shared;
    });
    set({ waypointSel: null, routeDraw: null });
  },
  clearRoute: (guardId) => {
    if (isLocked(get())) return;
    get().mutateWorld((d) => {
      const o = d.world.guards.find((x) => x.id === guardId);
      if (o && o.waypoints.length > 1) o.waypoints = [o.waypoints[0]];
    });
    set({ waypointSel: null });
  },
  autoPatrolGuard: (guardId) => {
    const s = get();
    if (isLocked(s) || !s.project) return;
    const g = s.project.world.guards.find((o) => o.id === guardId);
    if (!g || !g.waypoints.length) return;
    const route = autoPatrol(s.project, g.waypoints[0]);
    if (route.length < 2) return;
    get().mutateWorld((d) => {
      const o = d.world.guards.find((x) => x.id === guardId);
      if (o) o.waypoints = route;
    });
    set({ waypointSel: null, routeDraw: null });
  },

  addBuilding: (x, z) => {
    if (isLocked(get())) return;
    const b: Building = {
      id: makeId("bd"),
      name: "New Building",
      x,
      z,
      width: 12,
      depth: 10,
      rotation: 0,
      height: 9,
      floors: 3,
      category: "residential",
      occupancy: 24,
    };
    get().mutateWorld((d) => {
      d.world.buildings.push(b);
    });
    set({ selection: { kind: "building", id: b.id } });
  },

  addFacility: (x, z) => {
    if (isLocked(get())) return;
    const f: Facility = {
      id: makeId("fc"),
      name: "New Facility",
      type: get().facilityType,
      x,
      z,
      radius: get().facilityType === "park" ? 24 : undefined,
    };
    get().mutateWorld((d) => {
      d.world.facilities.push(f);
    });
    set({ selection: { kind: "facility", id: f.id } });
  },

  moveObject: (sel, x, z) => {
    if (isLocked(get())) return;
    get().mutateWorld((d) => {
      if (sel.kind === "streetlight") {
        const o = d.world.streetlights.find((o) => o.id === sel.id);
        if (o) {
          o.x = x;
          o.z = z;
        }
      } else if (sel.kind === "camera") {
        const o = d.world.cameras.find((o) => o.id === sel.id);
        if (o) {
          o.x = x;
          o.z = z;
        }
      } else if (sel.kind === "guard") {
        // move nearest waypoint; guards move via waypoints
        const o = d.world.guards.find((o) => o.id === sel.id);
        if (o && o.waypoints.length) {
          let best = 0;
          let bd = Infinity;
          o.waypoints.forEach((w, i) => {
            const dd = (w.x - x) ** 2 + (w.z - z) ** 2;
            if (dd < bd) {
              bd = dd;
              best = i;
            }
          });
          o.waypoints[best] = { x, z };
        }
      } else if (sel.kind === "building") {
        const o = d.world.buildings.find((o) => o.id === sel.id);
        if (o) {
          const dx = x - o.x;
          const dz = z - o.z;
          o.x = x;
          o.z = z;
          if (o.entrance) {
            o.entrance.x += dx;
            o.entrance.z += dz;
          }
        }
      } else if (sel.kind === "facility") {
        const o = d.world.facilities.find((o) => o.id === sel.id);
        if (o) {
          o.x = x;
          o.z = z;
        }
      } else if (sel.kind === "road") {
        const o = d.world.roads.find((o) => o.id === sel.id);
        if (o && o.points.length > 0) {
          const cx = o.points.reduce((sum, p) => sum + p.x, 0) / o.points.length;
          const cz = o.points.reduce((sum, p) => sum + p.z, 0) / o.points.length;
          const dx = x - cx;
          const dz = z - cz;
          o.points = o.points.map((p) => ({
            x: Math.round((p.x + dx) * 10) / 10,
            z: Math.round((p.z + dz) * 10) / 10,
          }));
        }
      }
    });
  },

  duplicateSelected: () => {
    const sel = get().selection;
    if (!sel || isLocked(get()) || sel.kind === "guard" || sel.kind === "road") return;
    const listKey = ({ streetlight: "streetlights", camera: "cameras", building: "buildings", facility: "facilities" } as const)[sel.kind];
    const src = (get().project?.world[listKey] as { id: string; x: number; z: number }[] | undefined)?.find((o) => o.id === sel.id);
    if (!src) return;
    // offset by the object's own size so the copy lands beside it, not on top
    const b = src as unknown as { width?: number; depth?: number };
    const off = sel.kind === "building" ? Math.max(b.width ?? 10, b.depth ?? 10) + 4 : 6;
    const id = makeId(({ streetlight: "sl", camera: "cam", building: "bd", facility: "fc" } as const)[sel.kind]);
    get().mutateWorld((d) => {
      const copy = { ...deepClone(src), id, x: src.x + off, z: src.z } as never;
      const c = copy as unknown as { entrance?: { x: number; z: number }; inferred?: boolean };
      if (c.entrance) c.entrance = { x: c.entrance.x + off, z: c.entrance.z };
      c.inferred = false;
      (d.world[listKey] as unknown[]).push(copy);
    });
    set({ selection: { kind: sel.kind, id } as Selection });
  },

  nudgeSelected: (dx, dz) => {
    const s = get();
    const sel = s.selection;
    if (!sel || isLocked(s) || sel.kind === "guard" || sel.kind === "road" || !s.project) return;
    const listKey = ({ streetlight: "streetlights", camera: "cameras", building: "buildings", facility: "facilities" } as const)[sel.kind];
    const o = (s.project.world[listKey] as { id: string; x: number; z: number }[]).find((x) => x.id === sel.id);
    if (o) s.moveObject(sel, o.x + dx, o.z + dz);
  },

  rotateSelected: (deg) => {
    const s = get();
    const sel = s.selection;
    if (!sel || isLocked(s)) return;
    s.mutateWorld(
      (d) => {
        if (sel.kind === "building") {
          const o = d.world.buildings.find((x) => x.id === sel.id);
          // map degrees are clockwise; three.js Y rotation is counter-clockwise from above
          if (o) o.rotation = o.rotation - (deg * Math.PI) / 180;
        } else if (sel.kind === "camera") {
          const o = d.world.cameras.find((x) => x.id === sel.id);
          if (o) o.orientationDeg = ((((o.orientationDeg + deg + 180) % 360) + 360) % 360) - 180;
        }
      },
      { coalesce: `${sel.id}:rotate-key` }
    );
  },

  deleteSelected: () => {
    const sel = get().selection;
    if (!sel || isLocked(get())) return;
    get().mutateWorld((d) => {
      if (sel.kind === "streetlight") d.world.streetlights = d.world.streetlights.filter((o) => o.id !== sel.id);
      else if (sel.kind === "camera") d.world.cameras = d.world.cameras.filter((o) => o.id !== sel.id);
      else if (sel.kind === "guard") d.world.guards = d.world.guards.filter((o) => o.id !== sel.id);
      else if (sel.kind === "building") d.world.buildings = d.world.buildings.filter((o) => o.id !== sel.id);
      else if (sel.kind === "facility") d.world.facilities = d.world.facilities.filter((o) => o.id !== sel.id);
      else if (sel.kind === "road") d.world.roads = d.world.roads.filter((o) => o.id !== sel.id);
    });
    set({ selection: null });
  },

  undo: () => {
    const { history, project } = get();
    if (!history.past.length || !project) return;
    // Undo is an edit: leave the (read-only) simulation view instead of silently ignoring it.
    if (isLocked(get())) get().exitSimulation();
    if (get().dragState) set({ dragState: null });
    const prev = history.past[history.past.length - 1];
    set((s) => ({
      project: prev,
      dirty: true,
      selection: null,
      roadDraft: [],
      routeDraw: null,
      waypointSel: null,
      history: { past: s.history.past.slice(0, -1), future: [project, ...s.history.future].slice(0, HISTORY_LIMIT) },
    }));
    scheduleAutosave(get, set);
  },

  redo: () => {
    const { history, project } = get();
    if (!history.future.length || !project) return;
    if (isLocked(get())) get().exitSimulation();
    const next = history.future[0];
    set((s) => ({
      project: next,
      dirty: true,
      selection: null,
      routeDraw: null,
      waypointSel: null,
      history: { past: [...s.history.past, project].slice(-HISTORY_LIMIT), future: s.history.future.slice(1) },
    }));
    scheduleAutosave(get, set);
  },

  save: async () => {
    const { project } = get();
    if (!project) return;
    set({ saving: true });
    try {
      await saveProject(project);
      set({ dirty: false, lastSavedAt: new Date().toISOString() });
    } finally {
      set({ saving: false });
    }
  },

  markSaved: () => set({ dirty: false, lastSavedAt: new Date().toISOString() }),

  renameProject: (name) => {
    get().mutateWorld((d) => {
      d.name = name;
    });
  },

  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  setSceneTheme: (t) => set({ sceneTheme: t }),
  setScenarioPanel: (v) => set({ showScenarioPanel: v }),
  setResultsOpen: (v) => set({ resultsOpen: v }),
  setCompareOpen: (v) => set({ compareOpen: v }),
  setAssistantOpen: (v) => set({ assistantOpen: v }),
  setImportOpen: (v) => set({ importOpen: v }),

  updateScenario: (patch) => {
    get().mutateWorld((d) => {
      d.scenario = { ...d.scenario, ...patch };
    });
  },

  setActiveRun: (run, kind) => {
    playbackClock.t = 0;
    set(
      run
        ? { activeRun: run, runKind: kind, playing: true, displayT: 0, mode: "navigate", tool: "select", roadDraft: [], moveMode: false, dragState: null, routeDraw: null, waypointSel: null }
        : { activeRun: run, runKind: kind, playing: false, displayT: 0 }
    );
  },
  setPlaying: (v) => set({ playing: v }),
  setSpeed: (v) => set({ speed: v }),
  seek: (t) => {
    playbackClock.t = t;
    set({ displayT: t });
  },
  tickDisplay: () => set({ displayT: playbackClock.t }),
}));


/* ------------------------------------------------------------------ */
/* Autosave (debounced)                                                */
/* ------------------------------------------------------------------ */

let hintTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveTimer:ReturnType<typeof setTimeout> | null = null;

function scheduleAutosave(
  get: () => EditorState,
  set: (partial: Partial<EditorState>) => void
) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    const { project, saving } = get();
    if (!project) return;
    if (saving) return;
    set({ saving: true });
    try {
      await saveProject(project);
      set({ dirty: false, lastSavedAt: new Date().toISOString() });
    } catch {
      // storage failure is non-fatal; the dirty flag stays true
    } finally {
      set({ saving: false });
    }
  }, 900);
}

export { defaultScenario };


