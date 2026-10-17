"use client";

/**
 * Editor application shell: top bar, tool sidebar, 3D canvas, inspector,
 * timeline, and dialogs. Panels collapse to keep the scene primary.
 */

import { useEffect, useState } from "react";
import TopBar from "./TopBar";
import ToolsSidebar from "./ToolsSidebar";
import Inspector from "./Inspector";
import TimelineBar from "./TimelineBar";
import NeighborhoodCanvas from "@/components/three/NeighborhoodCanvas";
import dynamic from "next/dynamic";

// recharts + the replay scene live in this chunk; load it only once a dialog opens
const ResultsDialog = dynamic(() => import("./ResultsDialog").then((m) => m.ResultsDialog), { ssr: false });
const CompareDialog = dynamic(() => import("./ResultsDialog").then((m) => m.CompareDialog), { ssr: false });
import AssistantPanel from "./AssistantPanel";
import NightSummary from "./NightSummary";
import ImportDialog from "./ImportDialog";
import LocalIntelPanel from "./LocalIntelPanel";
import { useEditor } from "@/lib/store/editor";
import { cn } from "@/lib/utils";
import { useAutoIntel } from "@/lib/ai/intelLoader";
import ErrorBoundary from "@/components/ErrorBoundary";
import { EditorTour, HelpDialog, MobileNote } from "./EditorHelp";

export default function EditorShell() {
  useAutoIntel();
  const showScenarioPanel = useEditor((s) => s.showScenarioPanel);
  const setScenarioPanel = useEditor((s) => s.setScenarioPanel);
  const [showInspector, setShowInspector] = useState(true);
  // sticky "has been opened" flags so the dialog chunks load on first open only
  const resultsOpen = useEditor((s) => s.resultsOpen);
  const compareOpen = useEditor((s) => s.compareOpen);
  const [everResults, setEverResults] = useState(false);
  const [everCompare, setEverCompare] = useState(false);
  useEffect(() => { if (resultsOpen) setEverResults(true); }, [resultsOpen]);
  useEffect(() => { if (compareOpen) setEverCompare(true); }, [compareOpen]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") (window as any).__praesidiumEditor = useEditor; // dev/test hook
  }, []);

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // sliders/checkboxes keep focus after use; they have no text undo of their own
      const textField =
        el?.tagName?.match(/TEXTAREA|SELECT/) ||
        (el?.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes((el as HTMLInputElement).type)) ||
        el?.isContentEditable;
      if (textField) return;
      const s = useEditor.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        if (s.selection) {
          e.preventDefault(); // not the browser bookmark
          s.duplicateSelected();
        }
        return;
      }
      // standard object transforms: [ ] rotate (Shift = 1°), arrows nudge (Shift = 5 m)
      if (s.selection && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const rot = { "[": -15, "]": 15, "{": -1, "}": 1 }[e.key];
        if (rot !== undefined) {
          e.preventDefault();
          s.rotateSelected(rot);
          return;
        }
        const step = e.shiftKey ? 5 : 1;
        const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (nudge && s.selection.kind !== "guard" && s.selection.kind !== "road") {
          e.preventDefault();
          s.nudgeSelected(nudge[0], nudge[1]);
          return;
        }
      }
      switch (e.key.toLowerCase()) {
        case "v":
          s.setTool("select");
          break;
        case "r":
          s.setTool("road");
          break;
        case "b":
          s.setTool("building");
          break;
        case "f":
          s.setTool("facility");
          break;
        case "l":
          s.setTool("streetlight");
          break;
        case "c":
          if (!e.ctrlKey && !e.metaKey) s.setTool("camera");
          break;
        case "g":
          s.setTool("guard");
          break;
        case "delete":
        case "backspace":
          if ((s.routeDraw || (s.tool === "guard" && s.selection?.kind === "guard")) && e.key.toLowerCase() === "backspace") s.removeLastWaypoint();
          else if (s.selection?.kind === "guard" && s.waypointSel !== null && s.mode === "edit") {
            s.removeWaypoint(s.selection.id, s.waypointSel);
          } else if (s.selection) s.deleteSelected();
          break;
        case "enter":
          if (s.routeDraw) s.finishRouteDraw();
          else if (s.tool === "guard" && s.selection?.kind === "guard") s.select(null);
          else if (s.tool === "road" && s.roadDraft.length >= 2) s.commitRoad();
          break;
        case "e":
          if (!e.ctrlKey && !e.metaKey && !e.altKey) s.setMode(s.mode === "edit" ? "navigate" : "edit");
          break;
        case "escape":
          if (s.tool === "guard" && (s.routeDraw || s.selection?.kind === "guard")) s.select(null);
          else if (s.routeDraw) s.finishRouteDraw();
          else if (s.roadDraft.length) s.cancelRoad();
          else if (s.mode === "edit") s.setMode("navigate");
          else if (s.selection) s.select(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // warn before leaving with unsaved changes (autosave makes this rare)
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f7f5f1] text-[#1d2430]">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {showScenarioPanel ? (
          <ToolsSidebar />
        ) : (
          <button
            onClick={() => setScenarioPanel(true)}
            className="flex w-8 shrink-0 flex-col items-center gap-2 border-r border-[#e3ded4] bg-[#faf8f4] py-3 text-[10px] text-[#8a8272] hover:bg-[#f1ede4]"
            title="Show tools & scenario"
          >
            <span className="[writing-mode:vertical-lr]">Tools ▸</span>
          </button>
        )}

        <main className="relative min-w-0 flex-1" data-tour="canvas">
          <ErrorBoundary variant="canvas">
            <NeighborhoodCanvas />
          </ErrorBoundary>
          {/* sidebar collapse */}
          <button
            onClick={() => setScenarioPanel(!showScenarioPanel)}
            className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-r-md border border-l-0 border-[#e3ded4] bg-white/90 px-0.5 py-3 text-[10px] text-[#8a8272] hover:bg-white"
            title={showScenarioPanel ? "Hide tools" : "Show tools"}
          >
            {showScenarioPanel ? "◂" : "▸"}
          </button>
          <button
            onClick={() => setShowInspector(!showInspector)}
            className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-l-md border border-r-0 border-[#e3ded4] bg-white/90 px-0.5 py-3 text-[10px] text-[#8a8272] hover:bg-white"
            title={showInspector ? "Hide inspector" : "Show inspector"}
          >
            {showInspector ? "▸" : "◂"}
          </button>
          <NightSummary />
        </main>

        {showInspector && <Inspector />}
      </div>
      <TimelineBar />

      {everResults && <ResultsDialog />}
      {everCompare && <CompareDialog />}
      <ImportDialog />
      <AssistantPanel />
      <LocalIntelPanel />
      <HelpDialog />
      <EditorTour />
      <MobileNote />
    </div>
  );
}

