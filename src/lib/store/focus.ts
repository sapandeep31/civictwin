"use client";

import { create } from "zustand";

/**
 * "Fly the 3D camera to this spot" requests — used when the planner applies
 * or previews a change so the user sees exactly where it landed.
 */
export interface FocusRequest {
  seq: number;
  points: { x: number; z: number }[];
  label: string;
  tone: "added" | "preview";
  /** px of the canvas hidden on the right (e.g. the open planner panel) */
  insetRight: number;
}

interface FocusState {
  request: FocusRequest | null;
  focusOn: (r: Omit<FocusRequest, "seq">) => void;
  clear: () => void;
}

export const useFocus = create<FocusState>((set, get) => ({
  request: null,
  focusOn: (r) => {
    if (!r.points.length) return;
    set({ request: { ...r, seq: (get().request?.seq ?? 0) + 1 } });
  },
  clear: () => set({ request: null }),
}));
