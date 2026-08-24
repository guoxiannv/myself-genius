# Runtime contract

This document is a runner-owned runtime reference, not a model skill. The generated
capability catalog and SDK fingerprint remain the machine-readable authority for each
run. `scripts/fast-harmony.mjs` owns template preparation, catalog generation, and
capability resolution; `scripts/dependencies.mjs` exclusively owns dependency seeding,
synchronization, runtime pins, and Harmony Go export.

As soon as an initial prompt arrives, the runner starts an independent, tool-less HTML
design turn in parallel with scaffold preparation and dependency seeding. It runs on its
own configured model at low effort with a hard deadline below one minute. That deadline is
a budget rather than an estimate: the turn is expected to sometimes exceed it, and failure
is a non-blocking fallback. The turn also thinks, and cannot be told not to -- no Claude
Code knob reaches the `thinking` field of the request body, measured against Claude Code
2.1.241. Valid output is saved as `.expo-fast/design.html`. Killing the turn on its
deadline stops the local client only: the endpoint keeps generating and keeps the
concurrency slot, so the turns behind it may be refused a launch because of it.
The main implementation turn keeps its normal reasoning and translates the reference
into native React Native layout and local Lucide path geometry.

The runner has one execution policy. Main and repair model/effort values come from
command options with `config/execution.json` as the fallback. Deterministic verification
failures resume the same model session for another repair until the `repair.limit`
declared in `config/execution.json` is reached, at which point the last diagnosis is kept
and the run ends. Process/model failures, per-turn deadlines, user cancellation, and
system limits remain terminal conditions.

A launch the upstream refuses is reported as that and not as a model failure. The endpoint
answers "may this turn start" at launch, before any generation and at no token cost:
`403 concurrent request limit`, or the `503` no-channel answer the same event produces for
minutes afterwards. Both are recognized by shape; quota exhaustion, authentication
failures, and every other 403/429/503 are reported as themselves. A refusal arriving after
any assistant content is a turn that ran and then failed, which is a different diagnosis.
The run ends as `admission-refused` in `result.json`, with the endpoint's own words, which
makes "the upstream is short of capacity" a counted event rather than an impression.

Nothing waits for room and nothing relaunches. The refusal is identical whether the slot
being held is this run's own -- a design turn killed on its deadline leaves its upstream
generation running, bounded by the 27-81s such a document takes -- or somebody else's
traffic, bounded by nothing observable. Since the process cannot tell those apart, any wait
would be a number with no stated basis, and waiting would rewrite a capacity shortage as a
slow run. One run asks for at least two concurrent slots by construction, because the
app-icon turn waits for the brief the implementation turn writes and therefore overlaps it.
When a refusal follows this run's own design kill, the report names that request as the
most likely collision.

A refused design or app-icon turn stays non-blocking: both are optional and their fallbacks
are working ones, so the refusal is recorded beside the fallback instead of ending the run.
A refused implementation, follow-up, or repair turn ends it.

The initial 0→1 turn keeps the established product prompt and `Read`/`Write`/`Edit`
tool surface. Repair and user follow-up turns additionally receive two project-bound MCP
tools: `check` (dependency sync, typecheck, source audit) and `build` (check plus export
and artifact audit). They accept no path or command arguments and never expose a shell.
Both tools and the authoritative outer gate call `scripts/verification.mjs`; an Agent tool
success does not bypass final orchestration verification.

The initial turn also starts one independent app-icon task as soon as
`.expo-fast/brief.json` becomes valid JSON. Only the brief's product, primary-flow, and
acceptance semantics are sent to that task; technical plan and capability fields are
excluded. The task asks a tool-less Claude turn for separate 1024×1024 background and
foreground SVG layers, validates the restricted SVG surface, and rasterizes three PNGs
(background, foreground, and composite). It runs concurrently with implementation and
deterministic gates, never consumes the product Agent session, and falls back to the
template icon on timeout, invalid output, or rasterizer failure.

Generated icon source assets live in `assets/app-icon/` in the Expo project. The runner
writes the composite fallback to `expo.icon` and the two layer paths to
`expo.harmony.icon`. The SDK owns native materialization during HAP prebuild: it writes
the layered-image resources into AppScope and the entry module, then points the app and
main `EntryAbility` icons at the generated resource. The start-window icon remains
independently controlled by splash configuration. This keeps the SDK pool's `harmony/`
directory deterministic and avoids product-Agent native edits.

The icon task remains concurrent with the implementation turn. Before the first Harmony
Go export, the orchestrator joins that task so `export:harmony` observes the final icon
declaration. The SDK publishes the single or layered PNG resources beside `bundle.js`,
records their URL, byte size, and SHA-256 in both catalog and manifest metadata, and the
Harmony Go shell renders them from the server or its installed offline asset cache.

After a successful initial run, `--follow-up-file` resumes the original Claude session
and writes revision-scoped trace evidence. `--rebuild` performs deterministic verification
and export without a model turn, while `--preview-only` republishes an existing verified
export. The persisted FIFO controller is `follow-up-control.sh`. Interactive follow-up
refreshes the Bundle/desktop preview by default; HAP rebuild/signing remains an explicit
install-time operation so it does not extend the normal edit loop.

The selected devkit is Expo SDK 57.0.9, React 19.2.3, React Native 0.84.1,
RNOH 0.84.2, Harmony API 22. The live host is Expo Harmony Go; it consumes a
Metro bundle/catalog and avoids rebuilding the native host for each app.
The host bundle identity is resolved once from `EXPO_HARMONY_GO_BUNDLE_NAME`,
then the configured shell HAP's embedded `module.json`, and finally the current
SDK fallback `com.example.myapplication1.ide`; every HDC and layout gate uses the
same resolved value.

The deterministic catalog generated by the runner combines the complete
`harmony-support.json` view, `tools/harmony/support/compatibility/*.json`, and the
Harmony Go runtime contract. For product code, start with RN core (`View`, `Text`,
`Pressable`, `ScrollView`, `TextInput`, `Modal`, `useWindowDimensions`) and local
state. Current safe optional packages include exact versions from the catalog such
as `expo-linear-gradient`, `expo-status-bar`, `expo-secure-store`, `expo-clipboard`,
`expo-document-picker`, `expo-sharing`, `expo-crypto`, and `expo-haptics`; confirm
the package and export in the generated catalog before adding one.

The technical scaffold selects `react-native-svg@15.15.4` because its local icon
system imports it. Production icons use Path-only geometry because directly mixed
`Circle`, `Line`, and `Rect` children render incompletely in the selected Harmony Go
host; charts may still use catalog-supported shape primitives. All other product
capabilities are selected per request during the compact brief and written as exact
direct `package.json` dependencies. The selected Harmony Go runtime exposes a
host-specific AsyncStorage 1.24 compatibility entry backed by
`@react-native-oh-tpl/async-storage@1.21.0-0.2.2`; this does not claim that the upstream
AsyncStorage 2.2 contract is generally supported. Use this override only for bulk
non-sensitive app state. Use SecureStore only for bounded secrets.

## Responsive layout contract

Breakpoints use the logical width returned by `useWindowDimensions()`, never the
physical panel resolution or Harmony emulator pixel dimensions.

| logical width | product structure |
| --- | --- |
| phone `<640` | single content column; bottom navigation when the product has multiple top-level destinations |
| tablet `640–1279` | top horizontal navigation; one or two content columns according to available space |
| desktop `>=1280` | fixed-width left sidebar and flexible main as siblings in one horizontal root; real multi-column dashboard/list content (typically wrapping cards near 48% basis) |

Design references target logical canvases `390x844`, `1024x640`, and `1440x900`.
Their CSS media queries remain the source of truth, while a tiny `matchMedia` monitor
exposes `html[data-viewport]`, `data-logical-width`, and `data-logical-height` only for
inspection. Native code reproduces those breakpoints without browser APIs.

The desktop navigation must not precede or sit outside the horizontal root container,
because that stacks the supposed sidebar above the content. Single-destination apps
keep the responsive content behavior without inventing tabs.

After the implementation pass, `fast-harmony.mjs resolve-capabilities` rejects
unavailable or unpinned dependencies and preserves the scaffold manifest.
`dependencies.mjs sync` then installs the selected set before typecheck. The source
gate checks package presence and named
imports against the catalog's `supportedExports`. It also rejects text-only substitutes
for explicitly requested JSON export/import and requires the corresponding sharing and
document-picker capabilities. The artifact gate reconciles product imports, exact
`package.json` pins, manifest `requiredPackageVersions`, and catalog-selected versions
before accepting a Bundle.

Evidence written per run:

```text
.expo-fast/
  state.json
  request.md
  experiment.json
  capability-catalog.json
  model-capability-index.txt
  scaffold-package.json
  capability-selection.json
  sdk-fingerprint.json
  module-cache.json
  brief.json              # compact Spec → Plan → Code brief
  design.html             # optional low-effort visual reference
  design-trace.jsonl
  app-icon/
    result.json           # ready/fallback status, timing, model, source, asset paths,
                          # and whether the upstream refused the launch
    background.svg
    foreground.svg
    icon.svg
  agent-trace.jsonl
  agent-repair-trace*.jsonl
  trace-scope-audit*.json
  capability-resolution.log
  typecheck.log
  export.log
  source-audit.json
  build-evidence.json
  sdk-cli.json
  runtime.json
  manifest.json
  smoke/
    layout-before.json
    layout-after.json
    action.json
    screenshot.jpeg
  hap/
  result.json
  revisions/
    NNN-follow-up/
      agent-trace.jsonl
      agent-repair-trace*.jsonl
      trace-scope-audit*.json
```

Never claim full end-to-end success from `manifest.json` alone. The minimum smoke
assertion is an app-specific accessibility node/value change after a form
submission, timer transition, list mutation, toggle, or value edit, with layout
captured before and after. Navigation-only evidence is invalid.

The final unsigned HAP build is intentionally independent from the earlier Harmony Go
path. A HAP failure is recorded as a partial failure and must not erase already-passing
generation, source audit, artifact audit, or runtime evidence.
