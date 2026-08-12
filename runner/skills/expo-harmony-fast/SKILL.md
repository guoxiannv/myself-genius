---
name: expo-harmony-fast
description: Generate a complete Expo React Native application for the local HarmonyOS 22 Expo Harmony Go runtime with a compact capability-selecting brief, one Claude Code implementation pass, exact catalog-pinned Expo and React Native dependencies, deterministic source/build gates, and emulator evidence. Use when the user wants fast zero-to-one Harmony app generation, including multi-tab local-first dashboards, Pomodoro timers, bookkeeping, trackers, or offline apps in this workspace.
---

# Expo Harmony Fast

Use a known Expo SDK 57 + React Native 0.84.1 template and keep the model-visible
workflow small: **brief → implementation → check → Harmony Go export → run**.
The brief is a compact contract, not a prose specification. Do not create an HTML
stage, ArkTS, `harmony/`, `.expo/`, or a subagent lane.

## Required setup

Run from the new orchestration root and use the same Node 22+ runtime for install,
Claude, and the Expo Harmony CLI. Set:

```sh
export EXPO_HARMONY_SDK_ROOT=/Users/stefan/Workspaces/fe-project/devkit_sdk
export DEVECO_PATH=/Applications/DevEco-Studio.app
```

Before implementation, run `scripts/fast-harmony.mjs catalog` and read
`.expo-fast/capability-catalog.json` plus `.expo-fast/sdk-fingerprint.json`. They are
authoritative. The catalog combines package `harmony-support.json`, validated
compatibility contracts, and the selected Harmony Go host runtime. Select only exact
package versions and exports listed there. Never infer support from generic Expo docs.
During the single implementation pass, record required capabilities in
`.expo-fast/brief.json` and add them as exact direct `package.json` dependencies. The
orchestrator resolves that selection and synchronizes packages before typecheck; it
rejects undeclared imports, unavailable packages, version drift, and scaffold changes.

## Candidate modes

The runner exposes three candidates for experimentation plus an automatic selector. Every mode preserves the
model-visible Spec → Plan → Code order; only artifact size and repair policy vary:

| mode | model context | check loop | use |
| --- | --- | --- | --- |
| `direct` | user request + 6-line inline Spec/Plan | typecheck/export once | speed baseline |
| `brief` | direct mode plus a 10-line product brief and implementation checklist | one same-session deterministic repair only on failure | balanced default |
| `repair` | brief mode plus explicit batch-write and deterministic failure repair | typecheck/export; one same-session repair only | reliability comparison |

Use `--candidate auto` (the default) for normal requests. Select `repair` when the
request contains multiple tabs/screens plus import/export, weekly/report logic,
streak/rest-day rules, backfill/overdue states, or chart requirements. Keep `brief`
for focused local apps such as a timer or ledger. The selector is deterministic and
can always be overridden with `--candidate direct|brief|repair`.

Run every candidate on at least one real product scenario before selecting a
default. For serious comparison, run `pomodoro` and `ledger` on each. Do not ask a
separate agent to write a plan or QA report; this avoids context serialization and
subagent startup overhead.

## Implementation contract

Give Claude the request, the catalog path, and these non-negotiable boundaries:

- Build one coherent primary journey with real state changes; make important
  controls use stable `testID` and `accessibilityLabel` values.
- Write ordinary Expo/RN TypeScript only. Keep the app in `App.tsx` and `src/**`.
- Do not edit generated/native directories, Metro config, lockfiles by hand, the
  SDK checkout, or unrelated template files.
- Build a runnable vertical skeleton first: replace starter content, connect the
  entry point and every requested screen, and complete the primary mutation flow
  during the first implementation third. Deepen calculations, persistence,
  secondary actions, charts, and polish afterward. Never leave composition until
  the end. Prefer 6-10 cohesive files and batch writes over many tiny components.
- Read `useWindowDimensions().width` as logical layout width, independent of physical
  screen pixels or emulator resolution. Use phone `<640`, tablet `640–1279`, and
  desktop `>=1280`. For multiple top-level destinations, phone uses bottom navigation
  and a single column, tablet uses top horizontal navigation with one or two columns,
  and desktop uses a fixed-width left sidebar plus a flexible multi-column main area.
  The desktop sidebar and main must be siblings inside the same horizontal root
  container; placing the sidebar above/outside that row is invalid. Do not invent
  navigation destinations for a single-screen product.
- Reuse or extend `src/components/icons.tsx`. It provides Lucide-style line icons
  implemented with `react-native-svg`. Keep production icons Path-only: encode
  circles, straight lines, rectangles, and dots as commands in one or more `Path`
  elements because direct mixed SVG shape children are incomplete in the selected
  Harmony Go host. Never use emoji, Unicode glyph icons, text symbols, or an external
  icon package. Keep the shared default stroke width at 2.2, matching the reference
  Lucide visual weight. Charts may use other catalog-supported inline SVG primitives.
- Resolve system behavior with catalog capabilities instead of text-only substitutes.
  Requested JSON/file export uses `expo-sharing`, requested JSON/file import uses
  `expo-document-picker`, and requested copy actions use `expo-clipboard` when those
  exact packages and exports are available. Select haptics, crypto, status-bar,
  gradient, and other Expo capabilities only when driven by the request.
- Map browser-oriented `localStorage` requirements to catalogued AsyncStorage only
  when its Harmony Go host-specific entry is available. Use it for bulk non-sensitive
  state; reserve SecureStore for small secrets and honor its byte limit. Hydrate
  before the first write, seed only when storage is empty, and save all mutations.
- For rich offline dashboards, direct actions must complete their named result,
  imports must be validated before overwrite, requested animations must run, date
  logic must use local calendar dates, and incompatible units must stay separate.
- The runner executes typecheck, source/product audit, export, and runtime/manifest/
  Bundle SHA-256 validation. On any deterministic failure, `brief` and `repair` use
  the same Claude session for one narrow repair, then rerun the complete gate chain.
- Claude has only read/write/edit/search tools—no shell. A main-turn deadline is a
  failure by default; do not accept a partial implementation merely because static
  checks happen to pass.
- After the implementation turn, audit every model tool input. Reading a sibling
  project, prior generated source, dependency source, hidden orchestration artifact,
  or invoking a shell is an experiment-integrity failure even if the resulting app
  builds. The prompt boundary alone is not evidence of isolation.

## Experiment integrity

Treat every orchestration comparison as an independent cold-start experiment.
Prepare a new empty target directory from the same technical template and compatible
dependency cache. Never copy `App.tsx`, `src/**`, a product brief, generated source,
or a product-specific defect checklist from an earlier run. Do not resume a prior
Claude session for a new experiment. The runner records `.expo-fast/experiment.json`
with `coldStart=true`, `sourceInheritance=false`, and the technical template source
digest. `--baseProject` and `--base-project` are rejected.

After each run, inspect its own trace, source, business logic, deterministic build
evidence, and state-changing emulator flow before changing the prompt, skill, or
orchestrator. Carry forward only generalized workflow lessons; the next run must
still derive its product behavior from the user's request. Report cold-start
generation time separately from any repair and manual evaluation time.

## Deterministic acceptance

The runner, not Claude, owns capability validation, dependency preparation, export,
catalog identity, Harmony Go server, HDC reverse/launch, and evidence. It copies only
a compatible dependency cache, records the selected SDK revision/contracts/runtime,
preserves scaffold dependencies, and installs every selected catalog dependency when
absent. A successful
export must include a manifest whose `runtimeVersion` equals the selected devkit
runtime and whose Bundle bytes match the manifest SHA-256. Build evidence also binds
the result to a digest of current React source, `app.json`, and `package.json`.
Do not start a second model turn for QA by default: it can cost longer than the
implementation. A successful deterministic Harmony Go launch is the normal fast
path. Before launch, remove an already-installed mini app with the same manifest id
and reinstall it from the current catalog so a rebuilt Bundle cannot be mistaken for
the previous one. Reject any visible runtime error overlay even when the current
project title and a product marker remain visible behind it. When a product core-flow
smoke is requested, use HDC to capture layout before
the core flow and assert both the exact
manifest id and `bundleName=host.exp.exponent.harmony`. Perform a data/timer/form
state change, capture the layout again, and assert an exact product value changed.
Tab or screen navigation alone is never a pass. Save a screenshot, but do not use
image bytes as the assertion. If launch is not possible, report that explicitly and
retain the build/export evidence.

See [runtime-contract.md](references/runtime-contract.md) for the compact catalog
and evidence schema. Use `scripts/fast-harmony.mjs` rather than retyping setup and
export commands.
