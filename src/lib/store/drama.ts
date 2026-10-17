"use client";

/**
 * Incident-drama store.
 *
 * - `activeBeats`: beats whose time falls in the current playback window
 *   (default 4 s). Mirrored from the module-level playback clock by
 *   <DramaDriver/> inside the Canvas, and only updated when the *set* of
 *   active beats changes, so subscribers re-render rarely.
 * - `followIncident`: cinematic camera toggle.
 *
 * Consumers (toasts, bubbles) use `useActiveBeats()`.
 * Beats are read defensively: `result.beats` may be absent.
 */

import { create } from "zustand";
import type { IncidentBeat } from "@/lib/sim/incidents";

export const BEAT_WINDOW_SEC = 4;

/** A beat plus its stable index in `result.beats` (usable as a React key). */
export type ActiveBeat = IncidentBeat & { key: number };

interface DramaState {
  followIncident: boolean;
  setFollowIncident: (v: boolean) => void;
  /** Beats within (t - windowSec, t], oldest first. */
  activeBeats: ActiveBeat[];
  /** Most recent beat that has already fired (for toasts). */
  latestBeat: ActiveBeat | null;
  setActiveBeats: (b: ActiveBeat[], latest: ActiveBeat | null) => void;
  /** Show Jev decision thought bubbles during playback. */
  showThinking: boolean;
  setShowThinking: (v: boolean) => void;
  /** Use a TypeSafe Jev behaviour policy for new baseline runs. */
  jevBehaviour: boolean;
  setJevBehaviour: (v: boolean) => void;
  /** Where the last policy table came from. */
  policyInfo: { from: string; latencyMs: number; entries: number } | null;
  setPolicyInfo: (v: DramaState["policyInfo"]) => void;
}

/** Factory so secondary canvases (split replay) get an isolated drama store. */
export const createDramaStore = () =>
  create<DramaState>((set) => ({
    // on by default: a first-time viewer should SEE the incidents, not a tiny far-away map;
    // grabbing the camera cancels the current fly, and the timeline toggle turns it off
    followIncident: true,
    setFollowIncident: (v) => set({ followIncident: v }),
    activeBeats: [],
    latestBeat: null,
    setActiveBeats: (activeBeats, latestBeat) => set({ activeBeats, latestBeat }),
    showThinking: true,
    setShowThinking: (v) => set({ showThinking: v }),
    jevBehaviour: true,
    setJevBehaviour: (v) => set({ jevBehaviour: v }),
    policyInfo: null,
    setPolicyInfo: (policyInfo) => set({ policyInfo }),
  }));
export type DramaStore = ReturnType<typeof createDramaStore>;

export const useDrama: DramaStore = createDramaStore();

/** Beats currently within the playback window. Re-renders only when the set changes. */
export function useActiveBeats(): ActiveBeat[] {
  return useDrama((s) => s.activeBeats);
}

/** Subscribe imperatively (e.g. toasts): called when a *new* beat starts. */
export function subscribeNewBeats(cb: (beat: ActiveBeat) => void, store: DramaStore = useDrama): () => void {
  let seen = new Set<number>();
  return store.subscribe((s, prev) => {
    if (s.activeBeats === prev.activeBeats) return;
    if (s.activeBeats.length === 0) seen = new Set();
    for (const b of s.activeBeats) {
      if (!seen.has(b.key)) {
        seen.add(b.key);
        cb(b);
      }
    }
  });
}

/** Defensive beat accessor for a run's result. */
export function beatsOf(result: { beats?: IncidentBeat[] } | null | undefined): IncidentBeat[] {
  return result?.beats ?? [];
}
