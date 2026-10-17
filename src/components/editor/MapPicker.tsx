"use client";

/**
 * Map picker for the "satellite → 3D twin" import.
 *
 * Leaflet with keyless Esri basemaps and three base layers:
 *   Satellite (World Imagery + faint place labels) · Map (World Street Map) ·
 *   Hybrid (imagery + roads + labels).
 * Selection: a rotatable rectangle (default; corner handles resize, ✥ moves,
 * ↻ rotates) or a free polygon for irregular societies (drag points, click a
 * "+" to insert, right-click / double-click a point to remove, or redraw).
 * Client-only — load via next/dynamic with ssr:false.
 */

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  fromEN,
  rectCorners,
  rectFromBbox,
  ringBbox,
  selectionBbox,
  toEN,
  type Bbox,
  type LatLng,
  type Selection,
} from "@/lib/geo/selection";

export type { Bbox, Selection } from "@/lib/geo/selection";
export type BaseLayer = "satellite" | "map" | "hybrid";
export type ShapeMode = "rect" | "polygon";

interface Props {
  /** Fly here when it changes: to an editable outline when `ring` is given, else an axis-aligned rectangle. */
  focus: { lat: number; lng: number; bbox: Bbox; seq: number; ring?: [number, number][] } | null;
  selection: Selection | null;
  onSelection: (s: Selection) => void;
  onBaseLayer?: (b: BaseLayer) => void;
}

/** Default view: DLF Phase 1, Gurugram (a plotted colony) until the user searches. */
const DEFAULT_BBOX: Bbox = [28.4705, 28.4741, 77.0952, 77.0993];
const MIN_SIDE_M = 20;
const BASE_KEY = "praesidium.mapBase";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ATTR_IMAGERY = "Imagery © Esri, Maxar, Earthstar Geographics";
const ATTR_STREET = "Map © Esri, HERE, Garmin, © OpenStreetMap contributors";

type Controller = {
  fly: (f: NonNullable<Props["focus"]>) => void;
  setBase: (b: BaseLayer) => void;
  setMode: (m: ShapeMode) => void;
  startDraw: () => void;
  finishDraw: () => void;
  cancelDraw: () => void;
  resetRotation: () => void;
};

function readBase(): BaseLayer {
  if (typeof window === "undefined") return "satellite";
  try {
    const v = window.localStorage.getItem(BASE_KEY);
    if (v === "satellite" || v === "map" || v === "hybrid") return v;
  } catch {
    /* storage blocked */
  }
  return "satellite";
}

export default function MapPicker({ focus, selection, onSelection, onBaseLayer }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // client-only component (next/dynamic ssr:false), so localStorage is readable on first render
  const [base, setBase] = useState<BaseLayer>(readBase);
  const [mode, setMode] = useState<ShapeMode>(selection?.kind === "polygon" ? "polygon" : "rect");
  const [drawing, setDrawing] = useState<number | null>(null); // vertices placed while drawing
  const [rotation, setRotation] = useState(selection?.kind === "rect" ? selection.rotationDeg : 0);
  const ctl = useRef<Controller | null>(null);
  const onSelRef = useRef(onSelection);
  useEffect(() => {
    onSelRef.current = onSelection;
  }, [onSelection]);
  const initial = useRef({ focus, selection });

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    const b0 = base;
    onBaseLayer?.(b0);
    mountLeaflet(el.current!, initial.current.selection ?? (initial.current.focus ? rectFromBbox(initial.current.focus.bbox) : null), b0, {
      onSelection: (s) => {
        if (s.kind === "rect") setRotation(s.rotationDeg);
        onSelRef.current(s);
      },
      onDrawing: setDrawing,
      onMode: setMode,
    })
      .then((r) => {
        if (cancelled) return r.cleanup();
        ctl.current = r.ctl;
        cleanup = r.cleanup;
        setReady(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      ctl.current = null;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (focus && ctl.current) ctl.current.fly(focus);
  }, [focus]);

  const pickBase = (b: BaseLayer) => {
    setBase(b);
    onBaseLayer?.(b);
    ctl.current?.setBase(b);
    try {
      window.localStorage.setItem(BASE_KEY, b);
    } catch {
      /* ignore */
    }
  };
  const pickMode = (m: ShapeMode) => {
    setMode(m);
    ctl.current?.setMode(m);
  };

  const seg = (active: boolean) =>
    `px-2 py-1 text-[10px] font-medium transition ${active ? "bg-[#1d2430] text-white" : "bg-white/95 text-[#1d2430] hover:bg-[#eef4f0]"}`;
  const hint =
    drawing !== null
      ? drawing < 3
        ? `Click on the map to place the outline points (${drawing} placed, need 3+)`
        : "Keep clicking to add points · click the first point or Done to finish"
      : mode === "rect"
        ? "Drag corners to resize · ✥ to move · ↻ to rotate"
        : "Drag points to adjust · click + to insert · right-click a point to remove";

  return (
    <div className="relative h-full w-full overflow-hidden rounded-md border border-[#dcd6c8] bg-[#2a2f36]">
      <div ref={el} className="absolute inset-0" />
      {!ready && !failed && <div className="absolute inset-0 grid place-items-center text-xs text-[#c9c3b6]">Loading satellite map…</div>}
      {failed && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center text-xs text-[#c9c3b6]">
          The map could not load (network blocked?). You can still try the sample society below.
        </div>
      )}
      {ready && (
        <>
          <div className="absolute right-2 top-2 z-[1000] flex flex-col items-end gap-1.5" data-tour="map-layers">
            <div role="radiogroup" aria-label="Base map" className="flex overflow-hidden rounded-md border border-[#dcd6c8] shadow">
              {(["satellite", "map", "hybrid"] as const).map((b) => (
                <button key={b} role="radio" aria-checked={base === b} className={seg(base === b)} onClick={() => pickBase(b)}>
                  {b === "satellite" ? "Satellite" : b === "map" ? "Map" : "Hybrid"}
                </button>
              ))}
            </div>
            <div role="radiogroup" aria-label="Selection shape" className="flex overflow-hidden rounded-md border border-[#dcd6c8] shadow">
              <button role="radio" aria-checked={mode === "rect"} className={seg(mode === "rect")} onClick={() => pickMode("rect")} title="Rotatable rectangle">
                ▭ Rectangle
              </button>
              <button role="radio" aria-checked={mode === "polygon"} className={seg(mode === "polygon")} onClick={() => pickMode("polygon")} title="Free outline for irregular societies">
                ⬠ Polygon
              </button>
            </div>
            {mode === "rect" && Math.abs(rotation) > 0.5 && drawing === null && (
              <button className="rounded-md border border-[#dcd6c8] bg-white/95 px-2 py-1 text-[10px] text-[#1d2430] shadow hover:bg-[#eef4f0]" onClick={() => ctl.current?.resetRotation()}>
                Rotation {Math.round(rotation)}° · reset
              </button>
            )}
            {mode === "polygon" && drawing === null && (
              <button className="rounded-md border border-[#dcd6c8] bg-white/95 px-2 py-1 text-[10px] text-[#1d2430] shadow hover:bg-[#eef4f0]" onClick={() => ctl.current?.startDraw()}>
                ✎ Redraw outline
              </button>
            )}
            {drawing !== null && (
              <div className="flex gap-1">
                <button
                  className="rounded-md bg-[#2e7d5b] px-2 py-1 text-[10px] font-semibold text-white shadow disabled:opacity-50"
                  disabled={drawing < 3}
                  onClick={() => ctl.current?.finishDraw()}
                >
                  Done
                </button>
                <button className="rounded-md border border-[#dcd6c8] bg-white/95 px-2 py-1 text-[10px] text-[#1d2430] shadow" onClick={() => ctl.current?.cancelDraw()}>
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div className="pointer-events-none absolute bottom-6 left-1/2 z-[1000] -translate-x-1/2 whitespace-nowrap rounded bg-black/60 px-2 py-0.5 text-[10px] text-white/90">
            {hint}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

async function mountLeaflet(
  host: HTMLDivElement,
  start: Selection | null,
  base0: BaseLayer,
  cb: { onSelection: (s: Selection) => void; onDrawing: (n: number | null) => void; onMode: (m: ShapeMode) => void }
): Promise<{ ctl: Controller; cleanup: () => void }> {
  const L = (await import("leaflet")).default;
  const map = L.map(host, { zoomControl: true, attributionControl: true, maxZoom: 19, doubleClickZoom: false });

  const tile = (path: string, opts: Leaflet.TileLayerOptions = {}) => L.tileLayer(`${ESRI}/${path}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, ...opts });
  const layers: Record<BaseLayer, Leaflet.TileLayer[]> = {
    satellite: [tile("World_Imagery", { attribution: ATTR_IMAGERY }), tile("Reference/World_Boundaries_and_Places", { opacity: 0.7 })],
    // street/roads tiles stop at z17 in much of India (z18+ are "no data" placeholders) — upscale beyond that
    map: [tile("World_Street_Map", { maxNativeZoom: 17, attribution: ATTR_STREET })],
    hybrid: [
      tile("World_Imagery", { attribution: ATTR_IMAGERY }),
      tile("Reference/World_Transportation", { opacity: 0.85, maxNativeZoom: 17 }),
      tile("Reference/World_Boundaries_and_Places", { opacity: 0.95, attribution: "Labels © Esri" }),
    ],
  };
  let base = base0;
  layers[base].forEach((l) => l.addTo(map));
  const setBase = (b: BaseLayer) => {
    if (b === base) return;
    layers[base].forEach((l) => map.removeLayer(l));
    base = b;
    layers[b].forEach((l, i) => {
      l.addTo(map);
      l.setZIndex(i + 1);
    });
  };

  const STROKE = "#f5c24b";
  const shape = L.polygon([], { color: STROKE, weight: 2, fillOpacity: 0.08, interactive: false }).addTo(map);
  const draft = L.polyline([], { color: STROKE, weight: 2, dashArray: "5 5", interactive: false }).addTo(map);
  const icon = (html: string) => L.divIcon({ className: "", html, iconSize: [0, 0] });
  const cornerIcon = icon('<div style="width:12px;height:12px;margin:-6px 0 0 -6px;background:#fff;border:2px solid #f5c24b;border-radius:2px;box-shadow:0 0 3px #000a"></div>');
  const vertexIcon = icon('<div style="width:12px;height:12px;margin:-6px 0 0 -6px;background:#fff;border:2px solid #f5c24b;border-radius:50%;box-shadow:0 0 3px #000a"></div>');
  const firstIcon = icon('<div style="width:16px;height:16px;margin:-8px 0 0 -8px;background:#2e7d5b;border:2px solid #fff;border-radius:50%;box-shadow:0 0 3px #000a;cursor:pointer"></div>');
  const midIcon = icon('<div title="Insert a point" style="width:14px;height:14px;margin:-7px 0 0 -7px;background:#ffffffcc;border:1px solid #f5c24b;border-radius:50%;font:bold 11px/12px sans-serif;color:#1d2430;text-align:center;cursor:copy">+</div>');
  const moveIcon = icon('<div title="Move selection" style="width:22px;height:22px;margin:-11px 0 0 -11px;background:#f5c24bcc;border:2px solid #fff;border-radius:50%;box-shadow:0 0 3px #000a;cursor:move;display:grid;place-items:center;font:bold 12px sans-serif;color:#1d2430">✥</div>');
  const rotIcon = icon('<div title="Drag to rotate" style="width:22px;height:22px;margin:-11px 0 0 -11px;background:#fff;border:2px solid #f5c24b;border-radius:50%;box-shadow:0 0 3px #000a;cursor:grab;display:grid;place-items:center;font:bold 13px sans-serif;color:#1d2430">↻</div>');
  const stem = L.polyline([], { color: STROKE, weight: 1.5, dashArray: "3 3", interactive: false });

  let rect = start?.kind === "rect" ? start : rectFromBbox(start ? selectionBbox(start) : DEFAULT_BBOX);
  let ring: LatLng[] = start?.kind === "polygon" ? start.ring.slice() : rectCorners(rect);
  let mode: ShapeMode = start?.kind === "polygon" ? "polygon" : "rect";
  let handles: Leaflet.Marker[] = [];
  let drawRing: LatLng[] | null = null;

  const current = (): Selection => (mode === "rect" ? { ...rect } : { kind: "polygon", ring: ring.slice() });
  const emit = () => cb.onSelection(current());
  const clearHandles = () => {
    handles.forEach((h) => map.removeLayer(h));
    handles = [];
    map.removeLayer(stem);
  };
  const ringCenter = (r: LatLng[]): LatLng => {
    const b = ringBbox(r);
    return [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2];
  };
  const rotHandlePos = (): LatLng => {
    const off = rect.depthM / 2 + Math.max(14, rect.depthM * 0.18);
    const t = (rect.rotationDeg * Math.PI) / 180;
    return fromEN(off * Math.sin(t), off * Math.cos(t), [rect.lat, rect.lng]);
  };
  const topMid = (): LatLng => {
    const c = rectCorners(rect);
    return [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
  };

  /** Re-position the shape + handles; `skip` keeps the marker being dragged where the pointer is. */
  const render = (skip?: Leaflet.Marker) => {
    if (mode === "rect") {
      const c = rectCorners(rect);
      shape.setLatLngs(c);
      handles.forEach((h, i) => {
        if (h === skip) return;
        if (i < 4) h.setLatLng(c[i]);
        else if (i === 4) h.setLatLng([rect.lat, rect.lng]);
        else h.setLatLng(rotHandlePos());
      });
      stem.setLatLngs([topMid(), rotHandlePos()]);
    } else {
      shape.setLatLngs(ring);
      const n = ring.length;
      handles.forEach((h, i) => {
        if (h === skip) return;
        if (i < n) h.setLatLng(ring[i]);
        else if (i < 2 * n) {
          const a = ring[i - n];
          const b = ring[(i - n + 1) % n];
          h.setLatLng([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        } else h.setLatLng(ringCenter(ring));
      });
    }
  };

  const buildRectHandles = () => {
    clearHandles();
    stem.addTo(map);
    const corners = rectCorners(rect);
    corners.forEach((p, i) => {
      const m = L.marker(p, { icon: cornerIcon, draggable: true }).addTo(map);
      m.on("drag", () => {
        const o: LatLng = [rect.lat, rect.lng];
        const opp = toEN(rectCorners(rect)[(i + 2) % 4], o);
        const q = toEN([m.getLatLng().lat, m.getLatLng().lng], o);
        const t = (rect.rotationDeg * Math.PI) / 180;
        const de = q.e - opp.e;
        const dn = q.n - opp.n;
        const w = Math.max(MIN_SIDE_M, Math.abs(de * Math.cos(t) - dn * Math.sin(t)));
        const d = Math.max(MIN_SIDE_M, Math.abs(de * Math.sin(t) + dn * Math.cos(t)));
        const mid = fromEN((q.e + opp.e) / 2, (q.n + opp.n) / 2, o);
        rect = { ...rect, lat: mid[0], lng: mid[1], widthM: w, depthM: d };
        render(m);
        emit();
      });
      m.on("dragend", () => render());
      handles.push(m);
    });
    const mv = L.marker([rect.lat, rect.lng], { icon: moveIcon, draggable: true }).addTo(map);
    mv.on("drag", () => {
      rect = { ...rect, lat: mv.getLatLng().lat, lng: mv.getLatLng().lng };
      render(mv);
      emit();
    });
    handles.push(mv);
    const rot = L.marker(rotHandlePos(), { icon: rotIcon, draggable: true }).addTo(map);
    rot.on("drag", () => {
      const v = toEN([rot.getLatLng().lat, rot.getLatLng().lng], [rect.lat, rect.lng]);
      let deg = (Math.atan2(v.e, v.n) * 180) / Math.PI;
      for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(deg - snap) < 3) deg = snap;
      if (deg <= -180) deg += 360;
      rect = { ...rect, rotationDeg: Math.round(deg * 10) / 10 };
      render(rot);
      emit();
    });
    rot.on("dragend", () => render());
    handles.push(rot);
    render();
  };

  const buildPolyHandles = () => {
    clearHandles();
    const n = ring.length;
    ring.forEach((p, i) => {
      const m = L.marker(p, { icon: vertexIcon, draggable: true }).addTo(map);
      m.on("drag", () => {
        ring[i] = [m.getLatLng().lat, m.getLatLng().lng];
        render(m);
        emit();
      });
      const remove = () => {
        if (ring.length <= 3) return;
        ring.splice(i, 1);
        buildPolyHandles();
        emit();
      };
      m.on("contextmenu", remove);
      m.on("dblclick", remove);
      handles.push(m);
    });
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % n];
      const m = L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { icon: midIcon }).addTo(map);
      m.on("click", () => {
        if (ring.length >= 40) return;
        ring.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        buildPolyHandles();
        emit();
      });
      handles.push(m);
    });
    const mv = L.marker(ringCenter(ring), { icon: moveIcon, draggable: true }).addTo(map);
    let last = ringCenter(ring);
    mv.on("dragstart", () => (last = ringCenter(ring)));
    mv.on("drag", () => {
      const p = mv.getLatLng();
      const dLat = p.lat - last[0];
      const dLng = p.lng - last[1];
      last = [p.lat, p.lng];
      ring = ring.map(([la, lo]) => [la + dLat, lo + dLng]);
      render(mv);
      emit();
    });
    handles.push(mv);
    render();
  };

  const rebuild = () => (mode === "rect" ? buildRectHandles() : buildPolyHandles());

  /* ---- free drawing ---- */
  let firstMarker: Leaflet.Marker | null = null;
  const onMapClick = (e: Leaflet.LeafletMouseEvent) => {
    if (!drawRing) return;
    if (drawRing.length >= 40) return;
    drawRing.push([e.latlng.lat, e.latlng.lng]);
    draft.setLatLngs(drawRing);
    if (drawRing.length === 1) {
      firstMarker = L.marker(drawRing[0], { icon: firstIcon }).addTo(map);
      firstMarker.on("click", () => drawRing && drawRing.length >= 3 && finishDraw());
    }
    cb.onDrawing(drawRing.length);
  };
  map.on("click", onMapClick);
  const endDraw = () => {
    drawRing = null;
    draft.setLatLngs([]);
    if (firstMarker) map.removeLayer(firstMarker);
    firstMarker = null;
    host.style.cursor = "";
    cb.onDrawing(null);
  };
  const startDraw = () => {
    clearHandles();
    shape.setLatLngs([]);
    drawRing = [];
    host.style.cursor = "crosshair";
    cb.onDrawing(0);
  };
  const finishDraw = () => {
    if (!drawRing || drawRing.length < 3) return;
    ring = drawRing.slice();
    endDraw();
    buildPolyHandles();
    emit();
  };
  const cancelDraw = () => {
    endDraw();
    rebuild();
  };

  const setMode = (m: ShapeMode) => {
    if (drawRing) endDraw();
    if (m === mode) return;
    if (m === "polygon") ring = rectCorners(rect); // start editable from the current rectangle
    else {
      const b = ringBbox(ring);
      rect = { ...rectFromBbox(b), rotationDeg: 0 };
    }
    mode = m;
    cb.onMode(m);
    rebuild();
    emit();
  };

  const fit = (b: Bbox) =>
    map.fitBounds(
      [
        [b[0], b[2]],
        [b[1], b[3]],
      ],
      { padding: [30, 30] }
    );

  rebuild();
  fit(selectionBbox(current()));
  if (start) emit();

  const ctl: Controller = {
    fly: (f) => {
      if (drawRing) endDraw();
      rect = rectFromBbox(f.bbox);
      const want: ShapeMode = f.ring && f.ring.length >= 3 ? "polygon" : "rect";
      ring = want === "polygon" ? f.ring!.map((p) => [p[0], p[1]] as LatLng) : rectCorners(rect);
      if (mode !== want) {
        mode = want;
        cb.onMode(want);
      }
      rebuild();
      fit(f.bbox);
      emit();
    },
    setBase,
    setMode,
    startDraw: () => {
      if (mode !== "polygon") setMode("polygon");
      startDraw();
    },
    finishDraw,
    cancelDraw,
    resetRotation: () => {
      if (mode !== "rect") return;
      rect = { ...rect, rotationDeg: 0 };
      render();
      emit();
    },
  };

  // dialogs animate in — fix the size once layout settles
  const t = setTimeout(() => map.invalidateSize(), 250);
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(host);
  return {
    ctl,
    cleanup: () => {
      clearTimeout(t);
      ro.disconnect();
      map.off("click", onMapClick);
      map.remove();
    },
  };
}
