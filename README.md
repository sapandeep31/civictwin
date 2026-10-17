# Praesidium

**Neighborhood safety simulation & planning** — an India-first, globally extensible, browser-based platform for community safety planning exercises.

Build or import a neighborhood, populate it with synthetic residents and safety personnel, run a deterministic nighttime simulation, test interventions, compare outcomes against a preserved baseline, and export a professional PDF report.

> **Important:** Praesidium models *fictional scenarios* with *synthetic agents*. It does not predict actual crime, does not profile real people.

---

## Quick start

```bash
bun install          # or: npm install
bun run dev          # development server on http://localhost:3000
bun run lint         # ESLint
bunx vitest run      # simulation / coverage / metrics / serialization test suite (56 tests)
```

Open **http://localhost:3000** → *Explore the demo neighborhood* → *Run simulation*.
No API keys, no accounts, no cloud database are required for the core product.

## What works out of the box (no credentials)

| Capability | How |
|---|---|
| Deterministic simulation engine | Pure TypeScript, fixed 1 s timestep, seeded PRNG (`src/lib/sim`) |
| A* pedestrian routing | Walkable graph built from roads/paths, split at intersections (`src/lib/world/graph.ts`) |
| Nighttime 3D editor | React Three Fiber isometric scene, placement/drag/move/delete, undo–redo (`src/components/three`) |
| Demo society | "Shanti Vihar RWA" — gated 3×3 society (8 blocks around a park + Shiv Mandir), compound wall, main + service gate; procedural, deterministic, fully editable (`src/lib/world/demo.ts`) |
| Scenario templates | Typical Night / Low-Visibility Night, fully parameterized |
| Metrics | Modeled lighting & CCTV coverage, reachability, patrol & response analytics, costs |
| Baseline vs intervention | Same-seed comparison, preserved immutable baseline, percentage-point deltas |
| Timeline playback | Precomputed deterministic frames — scrubbing restores exact simulated state |
| PDF report | jsPDF, vector tables + bar charts, methodology & limitations included |
| Local persistence | IndexedDB autosave, project JSON export/import with schema validation |
| Planning assistant | z-ai model or Gemini (server key) with strict allowlist validation + deterministic rule-based fallback |

## Optional configuration

Copy `.env.example` → `.env` and fill in what you need. Everything is optional.

```bash
GEMINI_API_KEY=...            # enables the Gemini planning provider (server-side only)
OSM_OVERPASS_URL=...          # alternate Overpass mirror
OSM_NOMINATIM_URL=...         # alternate geocoder
```

**Never** put secrets in `VITE_`-prefixed (or any client-exposed) variables. The frontend talks to `/api/ai/*`; the key never leaves the server.

## Architecture

```
src/
  lib/
    world/        # typed, versioned domain model (schema v1), nav graph, demo, serialization
    sim/          # deterministic engine, seeded RNG, scenarios, coverage, metrics, runner
    storage/      # IndexedDB wrapper + project repository (autosave)
    store/        # Zustand editor state + playback clock (frame-driven, no re-render storms)
    report/       # jsPDF report generator
    geo/          # OSM fetch + world-model conversion (server-side)
    ai/           # proposal schema (zod), allowlist validation, deterministic recommendations
  app/
    page.tsx      # single-route app: welcome ⇄ editor (client-side screens)
    api/          # health · geo/search · geo/import · ai/propose (Next.js route handlers)
  components/
    three/        # R3F scene, layers, playback, interactions
    editor/       # shell, top bar, tools, inspector, timeline, dialogs, assistant
  tests/          # vitest suite (engine, coverage, metrics, graph, serialization, proposals)
```

### Determinism

`runSimulation(world, scenario)` consumes a `mulberry32` PRNG in a fixed order. Identical
world + scenario + seed + engine version ⇒ identical frames, events, and metrics. All 1-second
frames are precomputed when a run starts, so playback/scrubbing restores exact simulated state.
Stored runs keep a full world snapshot + seed + engine version; edits never silently rewrite a
preserved baseline.

### Lighting / CCTV coverage model (disclosed assumptions)

- Illumination at a sample = Σ brightness · (1 − d/radius)^1.5 over active lamps; the "lit"
  threshold rises as ambient visibility falls. Sampled every 5 m of walkable network.
- CCTV coverage = sample within range × range-scale AND within the horizontal FOV cone.
- Guard response = simulated network travel distance ÷ configured guard speed. Unreachable or
  unguarded events are recorded explicitly (`unreachable`, `no_guard`) and never averaged into
  response times.

## Backend API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health + feature/provider status (no secret values) |
| `POST /api/geo/search` | Place search via configurable OSM-compatible geocoder |
| `POST /api/geo/import` | Fetch bounded OSM features → internal world model (caps + timeouts) |
| `POST /api/ai/propose` | Structured intervention proposal; strict allowlist validation; falls back to rule-based recommendations |

The deterministic simulation is entirely client-side; the backend only serves geo + AI features.

### Deviations from the original spec (and why)

- **FastAPI → Next.js route handlers.** The runtime is a single Next.js 16 app (bun) behind one
  gateway port; a separate Python service would add deployment complexity for three endpoints.
  The contract (typed request/response, consistent `{ok, data|error}` envelope, timeouts,
  request limits) is unchanged.
- **Gemini → provider adapter.** If `GEMINI_API_KEY` is set, the backend calls Gemini directly
  (structured JSON output). Otherwise it uses the bundled z-ai SDK. If neither is available it
  returns clearly-labeled rule-based recommendations computed from real application metrics.
  Model output is always validated against an operation allowlist + world bounds before the UI
  offers it for explicit approval.

## Privacy & responsible use

- Synthetic agent IDs only; no personal data is collected or importable.
- No account, no cloud database: projects live in your browser's IndexedDB and are **not**
  synchronized across devices.
- AI proposals require explicit approval; nothing is applied automatically.
- No secrets in client bundles, logs, or reports. Uploaded project files are validated before use.
- Reports and UI state clearly that results are simplified simulations, not predictions.

## Testing

```bash
bunx vitest run
```

Covers: PRNG reproducibility, identical-config ⇒ identical-results, A* on connected/disconnected
graphs, agent movement & arrivals, guard patrol & response timing, event generation under fixed
seed, zero-event / zero-guard cases, unreachable destinations, lighting/CCTV coverage math,
outage stability, metrics & comparison math (no NaN/∞ on zero denominators), project
serialization round-trip, malformed/unsupported-version rejection, and AI proposal allowlist
validation.

## Known limitations

- **Geographic import** requires a reachable Overpass endpoint. Some networks block public
  instances (HTTP 406 / timeouts); configure `OSM_OVERPASS_URL` with a mirror in that case.
  Search (Nominatim) and every other feature remain fully usable.
- Building footprints from OSM are simplified to bounding rectangles; heights may be inferred
  (marked as inferred, never presented as authoritative).
- Headless-browser note: Chromium blocks *multiple automatic downloads* in one session — the
  PDF report (first download) works; subsequent JSON exports may need a fresh page in automated
  environments. Normal browsers are unaffected.
- 3D labels use drei `<Html>`, which logs a benign React 19 StrictMode warning in dev.
- Agents do not avoid each other (no crowd collision); roads carry a small pedestrian cost
  penalty but vehicles are not simulated.
