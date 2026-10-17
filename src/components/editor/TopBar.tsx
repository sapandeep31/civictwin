"use client";

/**
 * Editor top bar: identity, project name, save status, undo/redo,
 * import/export, run simulation, report export.
 */

import { useRef, useState } from "react";
import { useEditor } from "@/lib/store/editor";
import { Button } from "@/components/ui/button";
import { exportProjectJson, parseProject } from "@/lib/world/serialize";
import { downloadJson } from "@/lib/storage/projects";
import { runIntervention, runBaseline, prepareReportData, setupChangedSinceBaseline } from "@/lib/run-actions";
import { useToast } from "@/hooks/use-toast";
import { useIntel } from "@/lib/ai/intelStore";
import { useNarration, useNarrationDriver } from "@/lib/captions/narrate";
import { useHelp } from "./EditorHelp";

export default function TopBar() {
  const project = useEditor((s) => s.project);
  const dirty = useEditor((s) => s.dirty);
  const saving = useEditor((s) => s.saving);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const openWelcome = useEditor((s) => s.openWelcome);
  const setImportOpen = useEditor((s) => s.setImportOpen);
  const resetDemo = useEditor((s) => s.resetDemo);
  const renameProject = useEditor((s) => s.renameProject);
  const openProject = useEditor((s) => s.openProject);
  const activeRun = useEditor((s) => s.activeRun);
  const { toast } = useToast();
  const setIntelOpen = useIntel((s) => s.setOpen);
  useNarrationDriver();
  const lang = useNarration((s) => s.lang);
  const setLang = useNarration((s) => s.setLang);
  const narrStatus = useNarration((s) => s.status);

  const [busy, setBusy] = useState<"baseline" | "intervention" | "report" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!project) return null;
  const isDemo = project.source.kind === "demo";

  const handleRun = async (kind: "baseline" | "intervention") => {
    // re-running the baseline after edits makes the edits "today's setup" and drops the comparison —
    // easy to do by accident right after adding fixes, so ask first
    const p = useEditor.getState().project;
    if (kind === "baseline" && p && setupChangedSinceBaseline(p)) {
      const ok = window.confirm(
        "You've changed the society since the last run.\n\nOK = make these changes the new “today's setup” (the old baseline and comparison are replaced).\nCancel = keep the baseline — use “Run intervention” to test your changes against it."
      );
      if (!ok) return;
    }
    setBusy(kind);
    // yield a frame so the UI can show the busy state
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (kind === "baseline") await runBaseline();
      else await runIntervention();
    } catch (err) {
      toast({ title: "Simulation failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleReport = async () => {
    setBusy("report");
    try {
      const data = prepareReportData();
      if (!data) {
        toast({ title: "No simulation results yet", description: "Run a baseline simulation first." });
        return;
      }
      const { generateReportPdf } = await import("@/lib/report/pdf");
      generateReportPdf(data);
      toast({ title: "Report downloaded", description: "The PDF report has been generated and downloaded." });
    } catch (err) {
      toast({ title: "Report failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <header className="flex h-14 items-center gap-2 border-b border-[#e3ded4] bg-white px-3">
      <button onClick={openWelcome} className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[#f1ede4]" title="Back to welcome">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="" width={28} height={28} className="h-7 w-7" />
        <span className="hidden text-sm font-bold tracking-tight sm:inline">Praesidium</span>
      </button>

      <div className="mx-1 h-6 w-px bg-[#e3ded4]" />

      <input
        value={project.name}
        onChange={(e) => renameProject(e.target.value.slice(0, 80))}
        className="w-40 min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium hover:border-[#dcd6c8] focus:border-[#2e7d5b] focus:outline-none 2xl:w-56"
        title="Project name"
        aria-label="Project name"
      />

      {/* save status */}
      <span
        className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-[#8a8272] md:flex"
        title={saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved locally on this device"}
      >
        {saving ? (
          <>Saving…</>
        ) : dirty ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-[#b98a2f]" /> <span className="hidden min-[1440px]:inline">Unsaved changes</span>
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-[#2e7d5b]" /> <span className="hidden min-[1440px]:inline">Saved locally</span>
          </>
        )}
      </span>

      <div className="mx-1 h-6 w-px bg-[#e3ded4]" />

      <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        ↶
      </Button>
      <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
        ↷
      </Button>
      <button
        onClick={() => useHelp.getState().openHelp("shortcuts")}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[#dcd6c8] text-[11px] font-semibold text-[#5c6470] hover:bg-[#f1ede4]"
        title="Help, shortcuts & how it works (?)"
        aria-label="Help"
      >
        ?
      </button>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setIntelOpen(true)} title="Local safety intel (Gemini + Google Search)">
          ◎ Local intel
        </Button>
        <button
          onClick={() => setLang(lang === "en" ? "hinglish" : "en")}
          className="flex items-center gap-1 rounded-md border border-[#dcd6c8] px-1.5 py-1 text-[10px] font-medium text-[#5c6470] hover:bg-[#f1ede4]"
          title={
            (lang === "en" ? "Captions: English — click for Hinglish" : "Captions: Hinglish — click for English") +
            (narrStatus === "gemini" ? " · lines rewritten by Gemini" : narrStatus === "loading" ? " · Gemini is writing lines…" : narrStatus === "idle" ? "" : " · using built-in lines")
          }
        >
          {lang === "en" ? "EN" : "हिं/EN"}
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              narrStatus === "gemini" ? "bg-[#2e7d5b]" : narrStatus === "loading" ? "animate-pulse bg-[#b98a2f]" : "bg-[#cfc8ba]"
            }`}
          />
        </button>
        {isDemo && (
          <Button variant="ghost" size="sm" onClick={resetDemo} title="Reset demo to its original state">
            Reset demo
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          Import…
        </Button>
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} title="Open a saved project (.json)">
          Open
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.currentTarget.value = "";
            if (!f) return;
            try {
              const parsed = parseProject(JSON.parse(await f.text()));
              if (parsed.ok && parsed.project) {
                openProject(parsed.project);
                toast({ title: "Project loaded", description: parsed.project.name });
              } else {
                toast({ title: "Could not open project", description: parsed.error, variant: "destructive" });
              }
            } catch {
              toast({ title: "Could not open project", description: "The file is not valid JSON.", variant: "destructive" });
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            downloadJson(
              `${project.name.replace(/[^a-z0-9-_ ]/gi, "").replace(/\s+/g, "_")}.praesidium.json`,
              exportProjectJson(project)
            );
            toast({ title: "Project exported", description: "A versioned JSON copy was downloaded — share it and anyone can open it with Open." });
          }}
          title="Download / share this project as a .json file (others can load it with Open)"
        >
          Export
        </Button>

        <div className="mx-1 h-6 w-px bg-[#e3ded4]" />

        <Button
          size="sm"
          className="bg-[#1d2430] text-white hover:bg-[#2c3642]"
          onClick={() => handleRun("baseline")}
          disabled={busy !== null}
          data-tour="run"
        >
          {busy === "baseline" ? "Running…" : "Run simulation"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-[#2e7d5b] text-[#2e7d5b] hover:bg-[#eef4f0]"
          onClick={() => handleRun("intervention")}
          disabled={busy !== null}
          title="Run the intervention with the same seed and compare"
        >
          {busy === "intervention" ? "Running…" : "Run intervention"}
        </Button>
        <Button size="sm" variant="outline" onClick={handleReport} disabled={busy !== null} title="Export PDF report">
          {busy === "report" ? "Preparing…" : "PDF report"}
        </Button>
      </div>

      {activeRun === null && <span className="sr-only">No simulation loaded</span>}
    </header>
  );
}
