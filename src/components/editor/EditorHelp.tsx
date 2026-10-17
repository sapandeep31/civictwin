"use client";

/**
 * Editor onboarding + help:
 *  - EditorTour: 5-step first-run tooltip tour (dismissible; remembered in
 *    localStorage). Skipped for automated browsers (navigator.webdriver) so
 *    capture scripts are unaffected; force it with ?tour=1.
 *  - HelpDialog: keyboard cheat sheet ("?" opens it) + "How it works".
 *  - MobileNote: friendly "best on desktop" note on small screens.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { create } from "zustand";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useEditor } from "@/lib/store/editor";

const TOUR_KEY = "praesidium.tourDone.v1";
const MOBILE_KEY = "praesidium.mobileNoteDismissed.v1";

function store(get: true, key: string): string | null;
function store(get: false, key: string, value: string): void;
function store(get: boolean, key: string, value?: string) {
  try {
    if (get) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value ?? "1");
  } catch {
    /* private mode / blocked storage: tour simply shows again next time */
  }
  return null;
}

type HelpTab = "shortcuts" | "how";
interface HelpState {
  helpOpen: boolean;
  tab: HelpTab;
  tourOpen: boolean;
  openHelp: (tab?: HelpTab) => void;
  closeHelp: () => void;
  startTour: () => void;
  endTour: () => void;
}
export const useHelp = create<HelpState>((set) => ({
  helpOpen: false,
  tab: "shortcuts",
  tourOpen: false,
  openHelp: (tab = "shortcuts") => set({ helpOpen: true, tab }),
  closeHelp: () => set({ helpOpen: false }),
  startTour: () => set({ tourOpen: true, helpOpen: false }),
  endTour: () => {
    store(false, TOUR_KEY, new Date().toISOString());
    set({ tourOpen: false });
  },
}));

/* ------------------------------------------------------------------ */

const STEPS: { target: string; title: string; body: string; side: "right" | "left" | "bottom" | "top" | "center" }[] = [
  {
    target: "canvas",
    title: "Your society, at night",
    body: "This is the 3D twin. Left-drag to pan, right-drag to rotate, scroll to zoom. Click any building, light, camera or guard to inspect it.",
    side: "center",
  },
  {
    target: "tools",
    title: "Tools & scenario",
    body: "Place streetlights, CCTV cameras and guard patrols (press E for edit mode). Below, pick the kind of night to test — typical, low visibility or high risk.",
    side: "right",
  },
  {
    target: "run",
    title: "Run the night",
    body: "Run simulation plays a full, deterministic night: synthetic residents, incidents, guards responding. Same seed + same setup = identical results.",
    side: "bottom",
  },
  {
    target: "timeline",
    title: "Replay & results",
    body: "Scrub the timeline, follow incidents, then open Results to see what went wrong — blind spots, late guards, dark stretches.",
    side: "top",
  },
  {
    target: "assistant",
    title: "Open the AI planner",
    body: "Get ranked fixes with costs in ₹ — apply any mix, watch the map zoom to each one, then re-run the night to compare. Press ? any time for shortcuts.",
    side: "top",
  },
];

type Rect = { top: number; left: number; width: number; height: number };

function measure(target: string): Rect | null {
  const el = document.querySelector(`[data-tour="${target}"]`) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function EditorTour() {
  const open = useHelp((s) => s.tourOpen);

  // first run: auto-start once the editor has painted (desktop only, not for automation)
  useEffect(() => {
    const force = /[?&]tour=1\b/.test(window.location.search);
    const automated = typeof navigator !== "undefined" && navigator.webdriver;
    if (!force && (automated || window.innerWidth < 1024 || store(true, TOUR_KEY))) return;
    const t = setTimeout(() => useHelp.setState({ tourOpen: true }), force ? 600 : 1400);
    return () => clearTimeout(t);
  }, []);

  // remounts on every open, so the tour always starts at step 1
  return open ? <TourOverlay /> : null;
}

function TourOverlay() {
  const endTour = useHelp((s) => s.endTour);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(190);
  const cardRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setCardH(el.getBoundingClientRect().height);
  }, []);

  const s = STEPS[step];
  useLayoutEffect(() => {
    const update = () => setRect(measure(s.target));
    const raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    const t = setInterval(update, 500); // panels can collapse/expand underneath
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      clearInterval(t);
    };
  }, [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        endTour();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (step >= STEPS.length - 1) endTour();
        else setStep(step + 1);
      } else if (e.key === "ArrowLeft") setStep(Math.max(0, step - 1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, endTour]);

  if (!s) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const CARD_W = 300;
  const pad = 8;
  let cardStyle: React.CSSProperties = { left: vw / 2 - CARD_W / 2, top: vh / 2 - 90 };
  if (rect && s.side !== "center") {
    if (s.side === "right") cardStyle = { left: rect.left + rect.width + 14, top: Math.min(vh - 220, rect.top + 40) };
    if (s.side === "left") cardStyle = { left: rect.left - CARD_W - 14, top: Math.min(vh - 220, rect.top + 40) };
    if (s.side === "bottom") cardStyle = { left: Math.min(vw - CARD_W - 12, Math.max(12, rect.left + rect.width / 2 - CARD_W / 2)), top: rect.top + rect.height + 14 };
    if (s.side === "top") cardStyle = { left: Math.min(vw - CARD_W - 12, Math.max(12, rect.left + rect.width / 2 - CARD_W / 2)), top: Math.max(12, rect.top - cardH - 14) };
  } else if (rect && s.side === "center") {
    cardStyle = { left: rect.left + rect.width / 2 - CARD_W / 2, top: rect.top + rect.height / 2 - 90 };
  }
  const last = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Editor tour">
      {/* dim everything except the highlighted target */}
      {rect && s.side !== "center" ? (
        <div
          className="pointer-events-none fixed rounded-lg ring-2 ring-[#f5c24b] transition-all duration-200"
          style={{ top: rect.top - pad / 2, left: rect.left - pad / 2, width: rect.width + pad, height: rect.height + pad, boxShadow: "0 0 0 9999px rgba(10,14,22,0.55)" }}
        />
      ) : (
        <div className="pointer-events-none fixed inset-0 bg-[rgba(10,14,22,0.35)]" />
      )}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />
      <div key={step} ref={cardRef} className="fixed rounded-xl border border-[#dcd6c8] bg-white p-4 text-[#1d2430] shadow-2xl" style={{ ...cardStyle, width: CARD_W }}>
        <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[#2e7d5b]">
          <span>
            Quick tour · {step + 1}/{STEPS.length}
          </span>
          <button onClick={endTour} className="rounded px-1 text-[11px] font-normal normal-case tracking-normal text-[#8a8272] hover:bg-[#f1ede4]" aria-label="Skip tour">
            Skip
          </button>
        </div>
        <div className="mt-1.5 text-sm font-semibold">{s.title}</div>
        <p className="mt-1 text-xs leading-relaxed text-[#5c6470]">{s.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <span key={i} className={`h-1.5 w-1.5 rounded-full ${i === step ? "bg-[#2e7d5b]" : "bg-[#dcd6c8]"}`} />
            ))}
          </div>
          <div className="flex gap-1.5">
            {step > 0 && (
              <button onClick={() => setStep(step - 1)} className="rounded-md border border-[#dcd6c8] px-2.5 py-1 text-xs hover:bg-[#f1ede4]">
                Back
              </button>
            )}
            <button onClick={() => (last ? endTour() : setStep(step + 1))} className="rounded-md bg-[#1d2430] px-3 py-1 text-xs font-medium text-white hover:bg-[#2c3642]" autoFocus>
              {last ? "Got it" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const SHORTCUTS: [string, string][] = [
  ["V", "Select / inspect"],
  ["R", "Road or path tool"],
  ["B", "Building tool"],
  ["F", "Public facility tool"],
  ["L", "Streetlight tool"],
  ["C", "CCTV camera tool"],
  ["G", "Guard patrol tool"],
  ["E", "Toggle edit / navigate mode"],
  ["Enter", "Finish road or patrol route"],
  ["Esc", "Cancel drawing · leave edit mode · deselect"],
  ["Delete", "Delete the selected object"],
  ["Backspace", "Remove last waypoint while drawing"],
  ["Ctrl + Z", "Undo"],
  ["Ctrl + Y", "Redo"],
  ["Ctrl + Shift + Z", "Redo"],
  ["?", "Open this help"],
];

const MOUSE: [string, string][] = [
  ["Left drag", "Pan"],
  ["Right drag", "Rotate"],
  ["Scroll", "Zoom"],
  ["Click", "Select / place (edit mode)"],
];

const HOW: { t: string; d: string }[] = [
  { t: "1 · Build the twin", d: "Start from the demo society, a blank canvas, or pick your society on a satellite map — OpenStreetMap plus Gemini vision add buildings, walls, gates and likely dark zones." },
  { t: "2 · Simulate a night", d: "A deterministic agent simulation plays residents, commuters, synthetic offenders and guards. TypeSafe Jev supplies fast behaviour judgments; everything replays identically from the seed." },
  { t: "3 · See what went wrong", d: "Results show blind spots, unlit stretches, late or dozing guards, and each incident's debrief." },
  { t: "4 · Try a fix, compare", d: "Add lights, cameras or patrols yourself or accept an AI proposal, then Run intervention on the same night to see the measured difference and its cost in ₹." },
  { t: "5 · Share", d: "Export a PDF report for the RWA meeting, or Export the project JSON so others can open the exact same setup." },
];

export function HelpDialog() {
  const open = useHelp((s) => s.helpOpen);
  const tab = useHelp((s) => s.tab);
  const close = useHelp((s) => s.closeHelp);
  const startTour = useHelp((s) => s.startTour);

  // "?" opens the cheat sheet (ignored while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?") return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName?.match(/INPUT|TEXTAREA|SELECT/) || el?.isContentEditable) return;
      e.preventDefault();
      const st = useHelp.getState();
      if (st.helpOpen) st.closeHelp();
      else st.openHelp("shortcuts");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tabBtn = (t: HelpTab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === t}
      onClick={() => useHelp.setState({ tab: t })}
      className={`rounded-md px-3 py-1 text-xs ${tab === t ? "bg-[#1d2430] text-white" : "text-[#5c6470] hover:bg-[#f1ede4]"}`}
    >
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? useHelp.setState({ helpOpen: true }) : close())}>
      <DialogContent className="max-h-[88vh] overflow-y-auto bg-[#f7f5f1] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[#1d2430]">Help</DialogTitle>
          <DialogDescription className="text-xs text-[#5c6470]">Keyboard shortcuts and a one-minute overview of Praesidium.</DialogDescription>
        </DialogHeader>
        <div role="tablist" className="flex gap-1">
          {tabBtn("shortcuts", "Shortcuts")}
          {tabBtn("how", "How it works")}
        </div>
        {tab === "shortcuts" ? (
          <div className="grid gap-4 text-xs sm:grid-cols-[1fr_auto]">
            <table className="w-full">
              <tbody>
                {SHORTCUTS.map(([k, d]) => (
                  <tr key={k} className="border-b border-[#ece7dc] last:border-0">
                    <td className="w-px py-1 pr-3 align-top">
                      <kbd className="whitespace-nowrap rounded border border-[#dcd6c8] bg-white px-1.5 py-0.5 font-mono text-[10px] text-[#1d2430]">{k}</kbd>
                    </td>
                    <td className="py-1 text-[#5c6470]">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#8a8272]">3D view</div>
              {MOUSE.map(([k, d]) => (
                <div key={k} className="flex justify-between gap-3 py-0.5">
                  <span className="text-[#1d2430]">{k}</span>
                  <span className="text-[#5c6470]">{d}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <ol className="space-y-2.5 text-xs">
            {HOW.map((h) => (
              <li key={h.t} className="rounded-md border border-[#e9e4d8] bg-white px-3 py-2">
                <div className="font-semibold text-[#1d2430]">{h.t}</div>
                <p className="mt-0.5 leading-relaxed text-[#5c6470]">{h.d}</p>
              </li>
            ))}
            <li className="text-[10px] leading-snug text-[#8a8272]">All incidents are fictional scenario models for planning — not crime predictions. No real people are tracked.</li>
          </ol>
        )}
        <div className="flex justify-end">
          <button onClick={startTour} className="rounded-md border border-[#dcd6c8] bg-white px-3 py-1.5 text-xs text-[#1d2430] hover:bg-[#eef4f0]">
            ↺ Replay the quick tour
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

export function MobileNote() {
  // the editor is client-only (next/dynamic ssr:false), so window is available here
  const [show, setShow] = useState(() => typeof window !== "undefined" && window.innerWidth < 900 && !store(true, MOBILE_KEY));
  if (!show) return null;
  return (
    <div role="status" className="fixed inset-x-3 bottom-3 z-[55] rounded-xl border border-[#dcd6c8] bg-white/95 p-3 text-[#1d2430] shadow-xl backdrop-blur md:hidden">
      <div className="text-sm font-semibold">Best on a desktop or laptop</div>
      <p className="mt-0.5 text-xs leading-relaxed text-[#5c6470]">
        The planning workspace needs a bigger screen for its panels and 3D view. You can look around here, but editing and results are much easier on desktop.
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <button onClick={() => useEditor.getState().openWelcome()} className="rounded-md border border-[#dcd6c8] px-2.5 py-1 text-xs">
          Back to start
        </button>
        <button
          onClick={() => {
            store(false, MOBILE_KEY, "1");
            setShow(false);
          }}
          className="rounded-md bg-[#1d2430] px-3 py-1 text-xs font-medium text-white"
        >
          Continue anyway
        </button>
      </div>
    </div>
  );
}
