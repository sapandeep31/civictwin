"use client";

/**
 * "Pick your society on a satellite map → AI builds the 3D twin".
 * Search → adjust the rectangle on the satellite map → pipeline:
 *   OSM features (bbox-centered) ∥ satellite capture → Gemini vision layout → open editor.
 * Degrades gracefully: Gemini failure → OSM-only; OSM failure → Gemini-only.
 */

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/store/editor";
import type { PraesidiumProject, ProjectGeo, World } from "@/lib/world/types";
import { defaultScenario } from "@/lib/world/types";
import { makeId } from "@/lib/world/ids";
import type { BaseLayer } from "./MapPicker";
import { proceduralSociety } from "@/lib/geo/procedural";
import { prepareImportedWorld } from "@/lib/geo/siteSetup";
import { parseProject } from "@/lib/world/serialize";
import { postApi } from "@/lib/api/client";
import {
  clipWorldToPolygon,
  isAxisAligned,
  rectFromBbox,
  ringAreaM2,
  ringBbox,
  ringToLocal,
  ringToUV,
  selectionBbox,
  selectionRing,
  type Bbox,
  type Selection,
} from "@/lib/geo/selection";

const SAMPLE_URL = "/samples/prestige-shantiniketan.json";

const MapPicker = dynamic(() => import("./MapPicker"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center rounded-md bg-[#2a2f36] text-xs text-[#c9c3b6]">Loading satellite map…</div>,
});

interface SearchResult {
  displayName: string;
  lat: number;
  lon: number;
  boundingbox: [number, number, number, number];
  outline?: [number, number][];
  source?: "osm" | "google";
}

interface CompoundInfo {
  ring: [number, number][];
  source: "geocoder" | "osm" | "gemini";
  name?: string;
  areaHa: number;
  note?: string;
}

const COMPOUND_SOURCE: Record<CompoundInfo["source"], string> = {
  geocoder: "from OpenStreetMap",
  osm: "from OpenStreetMap",
  gemini: "estimated by Gemini from satellite",
};

type StepState = "pending" | "active" | "done" | "skipped" | "failed";
const STEPS = ["Fetching map data", "Capturing satellite + street map", "AI reading the satellite photo", "Building 3D twin"] as const;
const MIN_AREA_M2 = 3000;

interface BuildResult {
  world: World;
  geo: ProjectGeo;
  name: string;
  attribution: string;
  notes: string[];
  added: Record<string, number> | null;
  model: string | null;
}

const MIN_SPAN = 80;
const MAX_SPAN = 1200;

function spanM(b: Bbox) {
  const lat0 = (b[0] + b[1]) / 2;
  return { w: (b[3] - b[2]) * Math.cos((lat0 * Math.PI) / 180) * 111320, d: (b[1] - b[0]) * 111320 };
}

/** Fit a geocoder bbox into a society-sized (~150–600 m) rectangle. */
function societyBox(r: SearchResult): Bbox {
  const [s, n, w, e] = r.boundingbox;
  const lat = (s + n) / 2 || r.lat;
  const lon = (w + e) / 2 || r.lon;
  const sp = spanM([s, n, w, e]);
  // a bare point (Places / node result) says nothing about size: start from a mid-sized 300 m frame
  const floor = sp.w < 30 && sp.d < 30 ? 300 : 200;
  const half = (m: number) => Math.max(floor, Math.min(600, m * 1.15)) / 2;
  const hl = half(sp.d) / 111320;
  const hw = half(sp.w) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat - hl, lat + hl, lon - hw, lon + hw];
}

const postJson = (url: string, body: unknown) => postApi<any>(url, body);

export default function ImportDialog() {
  const open = useEditor((s) => s.importOpen);
  const setOpen = useEditor((s) => s.setImportOpen);
  const openProject = useEditor((s) => s.openProject);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [placeName, setPlaceName] = useState("");
  const [focus, setFocus] = useState<{ lat: number; lng: number; bbox: Bbox; seq: number; ring?: [number, number][] } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [baseLayer, setBaseLayer] = useState<BaseLayer | null>(null);
  const bbox: Bbox | null = selection ? selectionBbox(selection) : null;

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepState[]>(STEPS.map(() => "pending"));
  const [stepNotes, setStepNotes] = useState<string[]>(STEPS.map(() => ""));
  const [satImage, setSatImage] = useState<string | null>(null);
  const [streetImage, setStreetImage] = useState<string | null>(null);
  const [previewStreet, setPreviewStreet] = useState(false);
  const [runOutline, setRunOutline] = useState<[number, number][] | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [societyType, setSocietyType] = useState<string | null>(null);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const reset = () => {
    setQuery("");
    setSearchError(null);
    setResults([]);
    setPlaceName("");
    setFocus(null);
    setSelection(null);
    pickSeq.current++;
    setLocating(false);
    setBoundary(null);
    resetRun();
  };
  const resetRun = () => {
    setRunning(false);
    setSteps(STEPS.map(() => "pending"));
    setStepNotes(STEPS.map(() => ""));
    setSatImage(null);
    setStreetImage(null);
    setPreviewStreet(false);
    setRunOutline(null);
    setDescription(null);
    setSocietyType(null);
    setResult(null);
    setFatal(null);
  };

  const search = async () => {
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const data = await postJson("/api/geo/search", { query });
      setResults(data.results ?? []);
      if (!data.results?.length) setSearchError("No places matched. Try the society name with its city, or a nearby landmark.");
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed — the location service may be unreachable.");
    } finally {
      setSearching(false);
    }
  };

  const pickSeq = useRef(0);
  const [locating, setLocating] = useState(false);
  const [boundary, setBoundary] = useState<{ ok: boolean; text: string } | null>(null);

  const pick = async (r: SearchResult) => {
    const b = societyBox(r);
    setPlaceName(r.displayName.split(",")[0]);
    setResults([]);
    setSelection(rectFromBbox(b));
    setFocus({ lat: r.lat, lng: r.lon, bbox: b, seq: Date.now() });
    // then snap the selection to the society's real perimeter (OSM area → Gemini), so the twin covers just the compound
    const seq = ++pickSeq.current;
    setLocating(true);
    setBoundary(null);
    try {
      const d = (await postJson("/api/geo/compound", { lat: r.lat, lon: r.lon, query: query.trim() || r.displayName, outline: r.outline ?? null })) as {
        compound: CompoundInfo | null;
      };
      if (seq !== pickSeq.current) return;
      const c = d.compound;
      if (c && c.ring.length >= 3) {
        setSelection({ kind: "polygon", ring: c.ring });
        setFocus({ lat: r.lat, lng: r.lon, bbox: ringBbox(c.ring), ring: c.ring, seq: Date.now() });
        setBoundary({ ok: true, text: `Society boundary ${COMPOUND_SOURCE[c.source]}${c.name ? ` (“${c.name}”)` : ""} — check it hugs your compound wall, and drag the points if it's off.` });
      } else {
        setBoundary({ ok: false, text: "Couldn't find the society's boundary automatically — fit the rectangle (or draw a polygon) around it." });
      }
    } catch {
      if (seq === pickSeq.current) setBoundary({ ok: false, text: "Boundary lookup failed — fit the rectangle (or draw a polygon) around the society." });
    } finally {
      if (seq === pickSeq.current) setLocating(false);
    }
  };

  const span = bbox ? spanM(bbox) : null;
  const ring = selection ? selectionRing(selection) : null;
  const areaM2 = ring ? ringAreaM2(ring) : 0;
  const spanOk = span
    ? span.w >= MIN_SPAN && span.d >= MIN_SPAN && span.w <= MAX_SPAN && span.d <= MAX_SPAN && areaM2 >= MIN_AREA_M2
    : false;
  const needsClip = selection ? !isAxisAligned(selection) : false;

  const build = async () => {
    if (!bbox || !selection || !spanOk) return;
    resetRun();
    setRunning(true);
    const set = (i: number, st: StepState, note = "") => {
      setSteps((p) => p.map((v, k) => (k === i ? st : v)));
      if (note) setStepNotes((p) => p.map((v, k) => (k === i ? note : v)));
    };
    const [south, north, west, east] = bbox;
    const sp = spanM(bbox);
    const notes: string[] = [];
    // rotated rectangle / polygon: capture the bounding bbox, then tell Gemini the outline and clip to it
    const outlineUV = needsClip ? ringToUV(selectionRing(selection), bbox) : null;
    setRunOutline(outlineUV);
    set(0, "active");
    set(1, "active");

    const osmP = postJson("/api/geo/import", { south, north, west, east, name: placeName, fixToBbox: true })
      .then((d) => {
        set(
          0,
          "done",
          `${d.stats.buildings} buildings${d.stats.extraBuildings ? ` (${d.stats.extraBuildings} machine-traced)` : ""} · ${d.stats.roads} roads mapped in the captured area`
        );
        return d as { world: World; notes: string[]; attribution: string };
      })
      .catch((err: Error) => {
        set(0, "failed", "OpenStreetMap unavailable — continuing with satellite only");
        notes.push(`OpenStreetMap fetch failed (${err.message}); the layout is AI-inferred only.`);
        return null;
      });
    const satP = postJson("/api/geo/satellite", { south, north, west, east, street: true })
      .then((d) => {
        setSatImage(d.image);
        if (d.streetImage) setStreetImage(d.streetImage);
        set(1, "done", `${d.width}×${d.height}px · ${d.provider === "google" ? "Google" : "Esri"} z${d.zoom}${d.streetImage ? " · + street map" : " · street map unavailable"}`);
        return d as { image: string; attribution: string; provider: string; streetImage?: string; streetAttribution?: string };
      })
      .catch((err: Error) => {
        set(1, "failed", `${err.message} — continuing without imagery`);
        return null;
      });
    const [osm, sat] = await Promise.all([osmP, satP]);

    const baseWorld: World = osm?.world ?? {
      bounds: { width: sp.w, depth: sp.d },
      roads: [],
      buildings: [],
      facilities: [],
      streetlights: [],
      cameras: [],
      guards: [],
    };
    if (osm) notes.push(...osm.notes);

    let world = baseWorld;
    let added: Record<string, number> | null = null;
    let model: string | null = null;
    let sType: string | undefined;
    let summary: string | undefined;
    if (sat) {
      set(2, "active");
      try {
        const v = await postJson("/api/ai/vision-layout", {
          image: sat.image,
          streetImage: sat.streetImage ?? null,
          bounds: baseWorld.bounds,
          world: osm?.world ?? null,
          placeName,
          polygon: outlineUV,
        });
        world = v.world;
        added = v.added;
        model = v.model;
        sType = v.societyType;
        summary = v.description;
        setSocietyType(v.societyType);
        setDescription(v.description);
        set(
          2,
          "done",
          `+${v.added.buildings} buildings${v.added.heights ? ` · ${v.added.heights} heights estimated` : ""} · ${v.added.gates} gates · ${v.added.walls ? "boundary wall" : "no wall"} · ${v.added.areas} zones${v.added.rejected ? ` · ${v.added.rejected} unreliable guesses dropped` : ""}`
        );
        notes.push("Walls, gates, dark zones and extra buildings were inferred by Gemini from satellite imagery — verify them on the ground.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Gemini is unavailable.";
        set(2, "failed", `${msg} Importing map data only.`);
        notes.push(`Gemini layout analysis was skipped: ${msg}`);
      }
    } else {
      set(2, "skipped", "No satellite image to analyse");
    }

    set(3, "active");
    if (needsClip) {
      const poly = ringToLocal(selectionRing(selection), bbox, baseWorld.bounds.width, baseWorld.bounds.depth);
      const clipped = clipWorldToPolygon(world, poly);
      world = clipped.world;
      if (clipped.removed) notes.push(`${clipped.removed} mapped item(s) outside your ${selection.kind === "polygon" ? "outline" : "rotated selection"} were left out.`);
    }
    if (!world.roads.length && !world.buildings.length && !world.site?.walls.length) {
      // never dead-end: estimated layout aligned to the bbox (and the satellite ground)
      world = proceduralSociety(baseWorld.bounds, bbox);
      sType = sType ?? "estimated";
      notes.push("Neither OpenStreetMap nor Gemini returned geometry, so an ESTIMATED grid layout (buildings, perimeter wall, main gate) was generated. Edit it to match the satellite ground.");
    }
    // simulation-ready: connected walk network + inferred baseline (guards, gate cameras, lights)
    const prepared = prepareImportedWorld(world, Math.round(Math.abs(south * 1e4 + west * 1e4)));
    world = prepared.world;
    notes.push(...prepared.notes);
    const attribution = [osm?.attribution ?? null, sat?.attribution ?? null, sat?.streetImage ? sat.streetAttribution ?? null : null, model ? `Layout inference: ${model}` : null]
      .filter(Boolean)
      .join(" · ");
    setResult({
      world,
      name: placeName || "Imported Society",
      attribution: attribution || "© OpenStreetMap contributors",
      notes,
      added,
      model,
      geo: {
        lat: (south + north) / 2,
        lng: (west + east) / 2,
        bbox,
        placeName: placeName || undefined,
        societyType: sType,
        summary,
        satelliteImage: sat?.image,
      },
    });
    set(3, "done", `${world.buildings.length} buildings · ${world.roads.length} roads/paths`);
    setRunning(false);
  };

  const [sampleLoading, setSampleLoading] = useState(false);
  const loadSample = async () => {
    setSampleLoading(true);
    setSearchError(null);
    try {
      const res = await fetch(SAMPLE_URL);
      const parsed = parseProject(await res.json());
      if (!parsed.ok || !parsed.project) throw new Error(parsed.error ?? "Sample is unreadable.");
      const now = new Date().toISOString();
      openProject({ ...parsed.project, projectId: makeId("prj"), createdAt: now, modifiedAt: now });
      setOpen(false);
      reset();
    } catch (err) {
      setSearchError(`Could not load the sample society: ${err instanceof Error ? err.message : "error"}`);
    } finally {
      setSampleLoading(false);
    }
  };

  const openTwin = () => {
    if (!result) return;
    const now = new Date().toISOString();
    const w = result.world;
    const project: PraesidiumProject = {
      schemaVersion: 1,
      projectId: makeId("prj"),
      name: result.name,
      description: `${result.geo.summary ? result.geo.summary + " " : ""}Imported from satellite + OpenStreetMap on ${new Date().toLocaleDateString()}: ${w.buildings.length} buildings, ${w.roads.length} roads/paths, ${w.site?.gates.length ?? 0} gates. AI-inferred items are marked as inferred.`,
      createdAt: now,
      modifiedAt: now,
      source: { kind: "osm", attribution: result.attribution, importedAt: now, geo: result.geo },
      world: w,
      scenario: defaultScenario("typical_night"),
      baselineRun: null,
      interventionRun: null,
    };
    // dev hook: lets scripts snapshot a live import (used to build public/samples/*)
    if (process.env.NODE_ENV !== "production") (window as unknown as Record<string, unknown>).__praesidiumLastImport = project;
    openProject(project);
    setOpen(false);
    reset();
  };

  const showPipeline = running || result || fatal;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto bg-[#f7f5f1] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-[#1d2430]">Pick your society on the map</DialogTitle>
          <DialogDescription className="text-xs text-[#5c6470]">
            <span className="font-medium text-[#1d2430]">1</span> Search your society · <span className="font-medium text-[#1d2430]">2</span> check the
            yellow outline we draw around it · <span className="font-medium text-[#1d2430]">3</span> build. AI reads the satellite photo and map
            data to draft your buildings, walls, gates and today&apos;s guards, cameras and lights — you can correct anything afterwards.
          </DialogDescription>
        </DialogHeader>

        {!showPipeline && (
          <div className="space-y-2 text-sm">
            <div className="relative flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && query.trim()) search();
                }}
                placeholder="Society name and city, e.g. Prestige Shantiniketan, Bengaluru"
                autoFocus
                className="flex-1 rounded-md border border-[#dcd6c8] bg-white px-3 py-2 text-xs focus:border-[#2e7d5b] focus:outline-none"
              />
              <Button size="sm" className="h-8 bg-[#1d2430] text-xs text-white hover:bg-[#2c3642]" onClick={search} disabled={searching || !query.trim()}>
                {searching ? "Searching…" : "Search"}
              </Button>
              {results.length > 0 && (
                <div className="absolute left-0 right-20 top-9 z-[1200] max-h-64 overflow-y-auto rounded-md border border-[#dcd6c8] bg-white shadow-lg">
                  {results.map((r, i) => {
                    const [name, ...rest] = r.displayName.split(",");
                    return (
                      <button key={i} onClick={() => pick(r)} className="block w-full border-b border-[#f0ece4] px-3 py-2 text-left hover:bg-[#eef4f0]">
                        <span className="block text-xs font-semibold text-[#1d2430]">{name.trim()}</span>
                        {rest.length > 0 && <span className="block truncate text-[10.5px] text-[#8a8272]">{rest.join(",").trim()}</span>}
                      </button>
                    );
                  })}
                  <div className="px-3 py-1 text-right text-[9px] text-[#8a8272]">
                    {results.some((r) => r.source === "google") ? "Search: Google Places · © OpenStreetMap contributors" : "Search © OpenStreetMap contributors (Nominatim)"}
                  </div>
                </div>
              )}
            </div>
            {searchError && <div className="rounded-md border border-[#e6c98a] bg-[#fdf6e7] px-3 py-1.5 text-xs text-[#7a5d1e]">{searchError}</div>}
            {locating && <div className="animate-pulse rounded-md border border-[#dcd6c8] bg-white px-3 py-1.5 text-xs text-[#5c6470]">Finding the society's boundary…</div>}
            {!locating && boundary && (
              <div className={`rounded-md border px-3 py-1.5 text-xs ${boundary.ok ? "border-[#cfe2d7] bg-[#eef4f0] text-[#2e7d5b]" : "border-[#e6c98a] bg-[#fdf6e7] text-[#7a5d1e]"}`}>
                {boundary.ok ? "✓ " : ""}
                {boundary.text}
              </div>
            )}

            <div className="h-[420px]">
              <MapPicker focus={focus} selection={selection} onSelection={setSelection} onBaseLayer={setBaseLayer} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-[#5c6470]">
                {span && selection ? (
                  <>
                    <span className={spanOk ? "text-[#1d2430]" : "text-[#a33]"}>
                      {selection.kind === "rect"
                        ? `Selection ${Math.round(selection.widthM)} × ${Math.round(selection.depthM)} m${needsClip ? ` · rotated ${Math.round(selection.rotationDeg)}°` : ""}`
                        : `Outline ${selection.ring.length} points · ${(areaM2 / 10000).toFixed(1)} ha`}
                    </span>
                    {needsClip && <span className="text-[#8a8272]"> · captures {Math.round(span.w)} × {Math.round(span.d)} m</span>}
                    {!spanOk && (
                      <span className="text-[#a33]">
                        {areaM2 < MIN_AREA_M2 && span.w >= MIN_SPAN && span.d >= MIN_SPAN
                          ? " — the outline is too small"
                          : ` — keep the captured area between ${MIN_SPAN} and ${MAX_SPAN} m per side`}
                      </span>
                    )}
                    {placeName && <span className="text-[#8a8272]"> · {placeName}</span>}
                  </>
                ) : (
                  "Search for a place to start."
                )}
                {baseLayer && <span className="ml-2 text-[9px] text-[#a39b8b]">Esri {baseLayer} view</span>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-8 text-xs" disabled={sampleLoading} onClick={loadSample} title="Pre-built twin of Prestige Shantiniketan, Bengaluru (cached satellite + Gemini analysis)">
                  {sampleLoading ? "Loading sample…" : "Try a sample society"}
                </Button>
                <Button size="sm" className="h-8 bg-[#2e7d5b] text-xs text-white hover:bg-[#276c4f]" disabled={!spanOk || locating} onClick={build}>
                  {locating ? "Finding boundary…" : "Build my 3D twin →"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {showPipeline && (
          <div className="grid gap-4 text-sm sm:grid-cols-[1fr_260px]">
            <div className="space-y-2">
              {STEPS.map((label, i) => {
                const st = steps[i];
                return (
                  <div key={label} className="flex items-start gap-2.5 rounded-md border border-[#e9e4d8] bg-white px-3 py-2">
                    <span
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                        st === "done"
                          ? "bg-[#2e7d5b] text-white"
                          : st === "active"
                            ? "animate-pulse bg-[#f5c24b] text-[#1d2430]"
                            : st === "failed"
                              ? "bg-[#c45656] text-white"
                              : "bg-[#ece7dc] text-[#8a8272]"
                      }`}
                    >
                      {st === "done" ? "✓" : st === "failed" ? "!" : st === "skipped" ? "–" : i + 1}
                    </span>
                    <div className="min-w-0">
                      <div className={`text-xs font-medium ${st === "pending" ? "text-[#a39b8b]" : "text-[#1d2430]"}`}>
                        {label}
                        {st === "active" && "…"}
                      </div>
                      {stepNotes[i] && <div className="text-[10px] text-[#8a8272]">{stepNotes[i]}</div>}
                    </div>
                  </div>
                );
              })}

              {description && (
                <div className="rounded-md border border-[#cfe2d7] bg-[#eef4f0] px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#2e7d5b]">
                    Gemini · {societyType?.replace(/_/g, " ")}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[#1d2430]">{description}</p>
                </div>
              )}

              {fatal && <div className="rounded-md border border-[#e6c1c1] bg-[#fdf1f1] px-3 py-2 text-xs text-[#a33]">{fatal}</div>}

              {result && (() => {
                const w = result.world;
                const inferredB = w.buildings.filter((b) => b.inferred).length;
                const stat = (n: number, label: string) => (
                  <div className="rounded-md bg-[#f7f5f1] px-2 py-1.5 text-center">
                    <div className="text-sm font-bold text-[#1d2430]">{n}</div>
                    <div className="text-[10px] text-[#8a8272]">{label}</div>
                  </div>
                );
                return (
                  <div className="rounded-md border border-[#e9e4d8] bg-white px-3 py-2.5">
                    <div className="text-xs font-semibold text-[#1d2430]">Your twin is ready</div>
                    <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                      {stat(w.buildings.length, "buildings")}
                      {stat(w.site?.gates.length ?? 0, "gates")}
                      {stat(w.guards.length, "guards")}
                      {stat(w.cameras.length, "cameras")}
                      {stat(w.streetlights.length, "streetlights")}
                      {stat(w.roads.filter((r) => !r.inferred).length, "roads & paths")}
                    </div>
                    <p className="mt-2 text-[11px] leading-snug text-[#5c6470]">
                      <span className="font-medium text-[#7a5d1e]">Check before you rely on it:</span> today&apos;s guards, cameras and lights are a
                      first draft{inferredB ? `, and ${inferredB} building${inferredB === 1 ? "" : "s"} have estimated shape or height` : ""}
                      {w.site?.walls.length ? "; walls and gates were read from the satellite photo" : ""}. Click anything in the 3D view to correct it.
                    </p>
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[10px] text-[#8a8272] hover:text-[#5c6470]">How this was built ({result.notes.length} notes)</summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] leading-snug text-[#8a8272]">
                        {result.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    </details>
                  </div>
                );
              })()}

              <div className="flex gap-2 pt-1">
                {result && (
                  <Button size="sm" className="h-8 bg-[#2e7d5b] text-xs text-white hover:bg-[#276c4f]" onClick={openTwin}>
                    Open 3D twin
                  </Button>
                )}
                {!running && (
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={resetRun}>
                    Back to map
                  </Button>
                )}
              </div>
            </div>

            <div>
              {satImage ? (
                <div>
                  <div className="relative">
                    <img
                      src={previewStreet && streetImage ? streetImage : satImage}
                      alt={previewStreet ? "Street map of the selected area" : "Captured satellite view of the selected area"}
                      className="block w-full rounded-md border border-[#dcd6c8]"
                    />
                    {runOutline && (
                      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
                        <polygon points={runOutline.map(([u, v]) => `${u},${v}`).join(" ")} fill="none" stroke="#f5c24b" strokeWidth={6} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
                      </svg>
                    )}
                  </div>
                  {streetImage && (
                    <div className="mt-1 flex overflow-hidden rounded border border-[#dcd6c8] text-[10px]">
                      <button className={`flex-1 py-0.5 ${!previewStreet ? "bg-[#1d2430] text-white" : "bg-white text-[#1d2430]"}`} onClick={() => setPreviewStreet(false)}>
                        Satellite
                      </button>
                      <button className={`flex-1 py-0.5 ${previewStreet ? "bg-[#1d2430] text-white" : "bg-white text-[#1d2430]"}`} onClick={() => setPreviewStreet(true)}>
                        Street map
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid aspect-square place-items-center rounded-md border border-dashed border-[#dcd6c8] text-[11px] text-[#a39b8b]">
                  {running ? "Capturing satellite…" : "No satellite image"}
                </div>
              )}
              {result?.attribution && <div className="mt-1 text-[9px] leading-snug text-[#8a8272]">{result.attribution}</div>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
