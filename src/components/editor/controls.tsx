"use client";

/**
 * Inspector input controls with one consistent UX:
 *  - NumberSlider: label + typed value (with unit) + slider + optional quick presets.
 *    Typing commits on Enter/blur (clamped); ↑/↓ in the box step the value (Shift = ×10).
 *  - RotationControl: degrees (clockwise from east, like the map), ±15° buttons,
 *    0°/90° presets and an optional "align" action.
 *  - XZField: position pair.
 * Every drag of a slider is a single undo step (callers pass a coalesce key to mutateWorld).
 */

import { useState } from "react";
import { cn } from "@/lib/utils";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const roundTo = (v: number, step: number) => {
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.round(v / step) * step).toFixed(d));
};

function NumberBox({
  value,
  min,
  max,
  step,
  unit,
  onCommit,
  ariaLabel,
  wide,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onCommit: (v: number) => void;
  ariaLabel: string;
  wide?: boolean;
}) {
  // while typing show the draft; otherwise always the live value (slider drags, undo, other edits)
  const [draft, setDraft] = useState<string | null>(null);
  const shown = String(roundTo(value, step));
  const text = draft ?? shown;
  const setText = (t: string) => setDraft(t);
  const setEditing = (on: boolean) => setDraft(on ? shown : null);
  const commit = () => {
    const v = parseFloat(text);
    setDraft(null);
    if (!Number.isFinite(v)) return;
    const next = roundTo(clamp(v, min, max), step);
    if (next !== roundTo(value, step)) onCommit(next); // no-op commits would add empty undo steps
  };
  return (
    <span className={cn("inline-flex items-center rounded border border-[#dcd6c8] bg-white focus-within:border-[#2e7d5b]", wide ? "w-full" : "")}>
      <input
        aria-label={ariaLabel}
        inputMode="decimal"
        className={cn("min-w-0 bg-transparent px-1.5 py-0.5 text-right font-mono text-[11px] text-[#1d2430] focus:outline-none", wide ? "w-full" : "w-14")}
        value={text}
        onFocus={(e) => {
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const v = roundTo(clamp((parseFloat(text) || value) + d, min, max), step);
            setText(String(v));
            onCommit(v);
          }
        }}
      />
      {unit && <span className="pr-1.5 text-[10px] text-[#8a8272]">{unit}</span>}
    </span>
  );
}

export function NumberSlider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  hint,
  presets,
  onChange,
  sliderMax,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  presets?: { label: string; value: number }[];
  onChange: (v: number) => void;
  /** slider range can be shorter than what may be typed (e.g. towers up to 45 floors, slider to 30) */
  sliderMax?: number;
}) {
  const sMax = sliderMax ?? max;
  return (
    <div className="py-1.5" title={hint}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-[#8a8272]">{label}</span>
        <NumberBox value={value} min={min} max={max} step={step} unit={unit} onCommit={onChange} ariaLabel={label} />
      </div>
      <input
        type="range"
        aria-label={`${label} slider`}
        min={min}
        max={sMax}
        step={step}
        value={clamp(value, min, sMax)}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-[#ddd6c8] accent-[#2e7d5b]"
      />
      {presets && (
        <div className="mt-1 flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.value)}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[10px]",
                Math.abs(p.value - value) < step / 2 ? "border-[#2e7d5b] bg-[#eef4f0] text-[#2e7d5b]" : "border-[#e3ded4] bg-white text-[#5c6470] hover:border-[#2e7d5b]"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Normalise degrees into (-180, 180]. */
export const normDeg = (d: number) => {
  let v = ((d % 360) + 360) % 360;
  if (v > 180) v -= 360;
  return Math.round(v * 10) / 10;
};

export function RotationControl({
  label = "Rotation",
  value,
  onChange,
  onAlign,
  alignLabel = "Align to nearest road",
  hint = "Degrees clockwise from east, as seen on the map. Keyboard: [ and ] rotate 15° (Shift = 1°).",
}: {
  label?: string;
  value: number;
  onChange: (deg: number) => void;
  onAlign?: () => void;
  alignLabel?: string;
  hint?: string;
}) {
  const btn = "rounded border border-[#e3ded4] bg-white px-1.5 py-0.5 text-[11px] text-[#1d2430] hover:border-[#2e7d5b]";
  return (
    <div className="py-1.5" title={hint}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-[#8a8272]">{label}</span>
        <NumberBox value={value} min={-180} max={180} step={1} unit="°" onCommit={(v) => onChange(normDeg(v))} ariaLabel={label} />
      </div>
      <div className="flex items-center gap-2">
        {/* compass glyph: the bar shows the long axis direction on the map */}
        <svg viewBox="-12 -12 24 24" className="h-7 w-7 shrink-0" aria-hidden>
          <circle r="11" fill="#fff" stroke="#dcd6c8" />
          <g transform={`rotate(${value})`}>
            <rect x="-8" y="-2" width="16" height="4" rx="1" fill="#2e7d5b" />
            <circle cx="8" r="1.6" fill="#1d2430" />
          </g>
        </svg>
        <input
          type="range"
          aria-label={`${label} slider`}
          min={-180}
          max={180}
          step={1}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded bg-[#ddd6c8] accent-[#2e7d5b]"
        />
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <button type="button" className={btn} onClick={() => onChange(normDeg(value - 15))} title="Rotate 15° anticlockwise ( [ )">
          ↺ 15°
        </button>
        <button type="button" className={btn} onClick={() => onChange(normDeg(value + 15))} title="Rotate 15° clockwise ( ] )">
          ↻ 15°
        </button>
        <button type="button" className={btn} onClick={() => onChange(0)}>
          0°
        </button>
        <button type="button" className={btn} onClick={() => onChange(normDeg(value + 90))} title="Quarter turn">
          +90°
        </button>
        {onAlign && (
          <button type="button" className={cn(btn, "text-[#2e7d5b]")} onClick={onAlign}>
            ⟂ {alignLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export function XZField({ x, z, onChange }: { x: number; z: number; onChange: (x: number, z: number) => void }) {
  return (
    <div className="py-1.5" title="Local metres from the centre of the map: x = east, z = south. Arrow keys nudge 1 m (Shift = 5 m).">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[#8a8272]">Position (m)</div>
      <div className="flex gap-1.5">
        <label className="flex flex-1 items-center gap-1 text-[10px] text-[#8a8272]">
          x
          <NumberBox wide value={x} min={-3000} max={3000} step={0.5} onCommit={(v) => onChange(v, z)} ariaLabel="Position x" />
        </label>
        <label className="flex flex-1 items-center gap-1 text-[10px] text-[#8a8272]">
          z
          <NumberBox wide value={z} min={-3000} max={3000} step={0.5} onCommit={(v) => onChange(x, v)} ariaLabel="Position z" />
        </label>
      </div>
    </div>
  );
}
