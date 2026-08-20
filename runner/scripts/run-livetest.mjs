#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { assertCurrentMiniApp, inspectCurrentMiniApp, visibleBundleNames } from './layout-identity.mjs';
import { discoverHdcPreviewPools, hdcOutputFailed, parseHdcForwardRules, parseHdcTargets, prioritizeHdcPreviewTargets, reversePortCandidates } from './hdc-target.mjs';
import { acquirePreviewDevice, configuredPreviewPools } from './preview-device-pool.mjs';
import { auditImplementationTrace } from './trace-scope.mjs';
import { writeRunState } from './run-state.mjs';
import { executionDefaults, resolveExecution } from './execution-policy.mjs';
import { repairArtifactName } from './repair-artifact.mjs';
import { readExistingHapResult, runHapPoolBuild } from './hap-build.mjs';
import { verifyImplementation } from './verification.mjs';
import { harmonyGoBundleName, harmonyGoShellHapPath } from './harmony-go-runtime.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const helper = join(root, 'scripts/fast-harmony.mjs');
const dependencies = join(root, 'scripts/dependencies.mjs');
const agentToolsServer = join(root, 'scripts/agent-tools-server.mjs');
const sdk = resolve(root, process.env.EXPO_HARMONY_SDK_ROOT || '../sdk');
const hdc = resolve(process.env.HDC || `${process.env.DEVECO_PATH || '/Applications/DevEco-Studio.app'}/Contents/sdk/default/openharmony/toolchains/hdc`);
const node22 = process.env.EXPO_FAST_NODE || process.execPath;
const claude = process.env.CLAUDE_BIN || 'claude';
const liveClaude = process.env.EXPO_FAST_LIVE_CLAUDE === '1';
const harmonyGoLocalOrigin = 'http://127.0.0.1:3333';
let activeRunState = null;
let activeMetrics = null;
let activeRevision = null;
let activeResultPath = '';

function setRunState(state, detail, context = {}, extra = {}) {
  if (!activeRunState) return null;
  const next = writeRunState(activeRunState.project, state, {
    runId: activeRunState.runId,
    startedAt: activeRunState.startedAt,
    detail,
    context,
    ...extra,
  });
  activeRunState.state = state;
  return next;
}

function parse(argv) { const o = {}; for (let i = 0; i < argv.length; i += 1) { if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i]; } return o; }
function progress(message) { if (liveClaude) process.stdout.write(`[expo-fast ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}\n`); }
function advisoryTraceScope(scope, label, artifact) {
  const result = { ...scope, enforcement: 'advisory', blocking: false };
  if (result.status !== 'pass') {
    console.warn(`[expo-fast] trace-scope warning · ${label} · ${result.violationCount} violation(s); continuing · see ${artifact}`);
  }
  return result;
}
function summarizeClaudeEvent(row) {
  if (row.type === 'system' && row.subtype === 'init') return [`Claude session ${row.session_id} started · ${row.model}`];
  if (row.type === 'assistant') {
    return (row.message?.content || []).flatMap((block) => {
      if (block.type === 'tool_use') {
        const target = block.input?.file_path || block.input?.path || '';
        return [`Claude ${block.name}${target ? ` · ${target}` : ''}`];
      }
      if (block.type === 'text' && block.text?.trim()) return [`Claude: ${block.text.replace(/\s+/g, ' ').trim().slice(0, 220)}`];
      return [];
    });
  }
  if (row.type === 'result') return [`Claude ${row.subtype || 'completed'} · ${row.num_turns || 0} turns · ${Math.round((row.duration_ms || 0) / 1000)}s`];
  return [];
}
function displayClaudeChunk(chunk, state) {
  state.pending += chunk.toString();
  const lines = state.pending.split(/\r?\n/); state.pending = lines.pop() || '';
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    for (const message of summarizeClaudeEvent(row)) progress(message);
  }
}
function run(cmd, args, options = {}) { const started = Date.now(); const result = spawnSync(cmd, args, { cwd: options.cwd, env: { ...process.env, ...(options.env || {}) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (options.log) writeFileSync(options.log, `${result.stdout || ''}${result.stderr || ''}`); if (result.status !== 0) throw new Error(`${cmd} exited ${result.status}\n${result.stderr || result.stdout || ''}`); return { ms: Date.now() - started, stdout: result.stdout || '' }; }
function writeJson(path, value) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function recoverTrace(project, metrics, path = join(project, '.expo-fast/agent-trace.jsonl')) {
  if (!existsSync(path)) return metrics;
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const sessionId = rows.find((row) => row.session_id)?.session_id;
  const result = [...rows].reverse().find((row) => row.type === 'result');
  if (!metrics.sessionId && sessionId) metrics.sessionId = sessionId;
  if (!metrics.stages.claudeMs && result?.duration_ms) metrics.stages.claudeMs = result.duration_ms;
  if (!metrics.traceUsage && result) metrics.traceUsage = { totalCostUsd: result.total_cost_usd, turns: result.num_turns, usage: result.usage, modelUsage: result.modelUsage };
  if (!metrics.modelRouting) {
    const traceModels = [...new Set(rows.filter((row) => row.type === 'assistant' && row.message?.model).map((row) => row.message.model))];
    metrics.modelRouting = { requested: metrics.execution?.model || '', traceModels, billedModels: Object.keys(result?.modelUsage || {}) };
  }
  return metrics;
}
function traceUsage(path) {
  if (!existsSync(path)) return null;
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = [...rows].reverse().find((row) => row.type === 'result');
  if (!result) return null;
  return { totalCostUsd: result.total_cost_usd, turns: result.num_turns, durationMs: result.duration_ms, usage: result.usage, modelUsage: result.modelUsage };
}
function recoverRepairTrace(project, metrics, path = join(project, '.expo-fast/agent-repair-trace.jsonl')) {
  if (!existsSync(path)) return metrics;
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = [...rows].reverse().find((row) => row.type === 'result');
  if (result) {
    if (!metrics.stages.repairMs && result.duration_ms) metrics.stages.repairMs = result.duration_ms;
    const entry = { trace: relative(project, path), totalCostUsd: result.total_cost_usd, turns: result.num_turns, usage: result.usage, modelUsage: result.modelUsage };
    const entries = (metrics.repairTraceUsages ||= []);
    const index = entries.findIndex((item) => item.trace === entry.trace);
    if (index >= 0) entries[index] = entry; else entries.push(entry);
    metrics.repairTraceUsage = { totalCostUsd: entries.reduce((sum, item) => sum + (Number(item.totalCostUsd) || 0), 0), turns: entries.reduce((sum, item) => sum + (Number(item.turns) || 0), 0), attempts: entries };
  }
  return metrics;
}
function digestProductSource(project) {
  const paths = [join(project, 'App.tsx'), ...readdirSync(join(project, 'src'), { recursive: true }).map((entry) => join(project, 'src', String(entry))).filter((path) => existsSync(path) && statSync(path).isFile())].sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path.slice(project.length)).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function buildFollowUpPrompt(text) {
  return `The user wants to modify the existing product in this same project and conversation. Preserve working behavior that is not part of the request, and do not recreate the app from scratch.\n\nUSER FOLLOW-UP:\n${text.trim()}\n\nImplement the requested change completely in the current App.tsx/src/** and permitted product files. Use only catalog-supported exact dependency versions. After meaningful edits, call expo_fast.check and fix every diagnostic. When the change is complete, call expo_fast.build once and fix any remaining failure before stopping. Do not use arbitrary shell commands or inspect paths outside the product whitelist.`;
}
function ensureInitialRevision(metrics) {
  metrics.revisions ||= [];
  if (metrics.revisions.length) return;
  metrics.revisions.push({
    number: 0,
    kind: 'initial',
    status: metrics.status || 'passed',
    request: metrics.request,
    trace: '.expo-fast/agent-trace.jsonl',
    startedAt: metrics.startedAt,
    completedAt: metrics.generationCompletedAt || metrics.completedAt,
    durationMs: metrics.generationMs,
  });
}
function beginFollowUpRevision(project, metrics, requestPath, startedAt) {
  ensureInitialRevision(metrics);
  for (const revision of metrics.revisions) {
    if (revision.status === 'running') {
      revision.status = 'interrupted';
      revision.completedAt ||= startedAt.toISOString();
    }
  }
  const number = Math.max(...metrics.revisions.map((revision) => Number(revision.number) || 0)) + 1;
  const directory = `.expo-fast/revisions/${String(number).padStart(3, '0')}-follow-up`;
  mkdirSync(join(project, directory), { recursive: true });
  const revision = {
    number,
    kind: 'follow-up',
    status: 'running',
    request: relative(project, requestPath),
    trace: `${directory}/agent-trace.jsonl`,
    startedAt: startedAt.toISOString(),
    repairAttempts: [],
  };
  metrics.revisions.push(revision);
  return { revision, directory: join(project, directory) };
}
function requiredCapabilityPackages(request) {
  const rules = [
    [/@react-native-async-storage|localStorage|持久|即时保存|本机|离线|断网/i, '@react-native-async-storage/async-storage'],
    [/导出|export/i, 'expo-sharing'],
    [/导入|import/i, 'expo-document-picker'],
    [/复制|剪贴板|copy/i, 'expo-clipboard'],
    [/SVG|图标|图表|进度环|柱状图/i, 'react-native-svg'],
    [/渐变|gradient/i, 'expo-linear-gradient'],
  ];
  return new Set(rules.filter(([pattern]) => pattern.test(request)).map(([, packageName]) => packageName));
}
function writeModelCapabilityIndex(project, request) {
  const sourcePath = join(project, '.expo-fast/capability-catalog.json');
  const source = readFileSync(sourcePath, 'utf8');
  const catalog = JSON.parse(source);
  const required = requiredCapabilityPackages(request);
  const lines = [
    '# Deterministic model projection of capability-catalog.json. REQUIRED rows are request-matched AVAILABLE capabilities that must appear in brief, dependencies, and working code. Other AVAILABLE rows are optional.',
    `BASELINE ${JSON.stringify(catalog.baseline || {})}`,
    ...catalog.available.map((entry) => `${required.has(entry.package) ? 'REQUIRED' : 'AVAILABLE'} ${JSON.stringify({ package: entry.package, version: entry.version, supportedExports: entry.supportedExports || [], limitations: entry.limitations || [], implementation: entry.implementation || '', evidence: entry.evidence || '' })}`),
    ...catalog.unavailable.map((entry) => `UNAVAILABLE ${JSON.stringify({ package: entry.package, version: entry.version, reason: entry.reason || entry.limitations || [] })}`),
  ];
  const content = `${lines.join('\n')}\n`;
  const path = join(project, '.expo-fast/model-capability-index.txt');
  writeFileSync(path, content);
  return { path, sha256: sha256(content), sourceSha256: sha256(source), bytes: Buffer.byteLength(content), entries: catalog.available.length, requiredPackages: [...required].sort() };
}
function buildPrompt(project) {
  const request = readFileSync(join(project, '.expo-fast/request.md'), 'utf8').trim();
  const lines = 10;
  const extra = `\nBefore coding, preserve the required model-visible Spec → Plan → Code order: write .expo-fast/brief.json with at most ${lines} short lines total. Include a mini spec (product, primary flow, acceptance), a mini plan (data/state and file order), and a capabilities array containing every REQUIRED package/export plus only the optional AVAILABLE packages actually needed. When the request names multiple device classes, include the responsive device contract in acceptance. Add every REQUIRED and selected AVAILABLE package to package.json dependencies at its exact version. Production icons must be Path-only: encode circles, lines, rectangles, and dots as path commands because direct mixed SVG shape children render incompletely in this Harmony Go host. Charts may use other catalog-supported inline SVG primitives. Continue immediately to code; do not stop after the brief.`;
  return `Build this Expo React Native product from scratch in the current freshly prepared Harmony Go technical scaffold. No prior product implementation is present.\n\nUSER REQUEST:\n${request}\n\nRead only AGENTS.md, package.json, app.json, index.js, tsconfig.json, App.tsx, src/**, .expo-fast/model-capability-index.txt, and .expo-fast/sdk-fingerprint.json. These paths are permission-whitelisted and authoritative; do not attempt any other path, SDK scan, or web access. The model capability index is a deterministic projection of the local compatibility catalog: REQUIRED rows are request-matched AVAILABLE capabilities and must be represented in the brief, package dependencies, and working code; other AVAILABLE rows are optional; UNAVAILABLE rows must never be imported. ${extra}\n\nImplement the complete requested product now; do not collapse requested behavior into placeholders. Derive acceptance rules directly from the user request. Work in vertical slices, not a bottom-up library pass. Write .expo-fast/brief.json, then immediately replace starter App.tsx/app-shell, expose every requested destination, and implement a real primary state mutation. Keep the app runnable as you add data/persistence, complete screens, secondary actions, charts, and polish. Write each complete file as soon as it is ready; never leave entry composition or requested screens until the end.\n\nKeep the implementation compact: prefer 6-10 cohesive product files and avoid rewriting an already complete file unless integration requires it. Reuse the existing theme, local icon factory, and generic UI primitives; extend them only when a requested control truly needs it. Avoid commentary, long comments, duplicate wrappers, and one-file-per-small-component architecture. Treat useWindowDimensions().width as logical layout width; never infer breakpoints from physical pixels or emulator resolution. Use phone <640, tablet 640–1279, and desktop >=1280. For apps with multiple top-level destinations, phone uses bottom navigation and a single content column, tablet uses top horizontal navigation and one or two content columns as space allows, and desktop uses a fixed-width left sidebar plus a flexible main area as siblings inside the same horizontal root container. Never place the desktop sidebar before or outside that row container. Desktop dashboard/list cards must form a real multi-column layout, such as wrapping cards with about 48% basis. Do not invent tabs for a single-destination app; still preserve the same responsive content rules. Add stable literal testID and accessibilityLabel values to tabs, primary actions, and state summaries that change after actions.\n\nUse src/components/icons.tsx as the local Lucide-style icon system with one consistent 2.2 default stroke width. Every production icon and chart must use inline react-native-svg primitives; never use emoji, text glyphs, Unicode symbols, or an external icon library. Resolve native product behavior through the capability index instead of replacing it with text-only UI. For bulk non-sensitive local app state, use REQUIRED AsyncStorage; hydrate before writes, seed only when storage is empty, namespace storage keys with the app slug from app.json, and persist every mutation. Treat dates as local calendar dates and keep domain units separate when aggregating. Validate imported data before any destructive overwrite. Requested direct actions must perform their named system result in that action, and requested animations must actually animate.\n\nUse no package unless it has a REQUIRED or AVAILABLE row in the capability index and declare it in package.json dependencies at that exact version. Preserve all scaffold dependencies and every other package.json field. Do not create prose Spec/Plan, HTML, ArkTS, native files, tests, docs, or subagents. Do not edit other infrastructure. Do not run any shell command, install, Expo, lint, test, typecheck, grep, or build; the orchestrator owns dependency synchronization and verification. After the whole app is connected, spend the remaining pass on missing user-visible behavior, then stop. Do not narrate progress, check formatting, reread the whole project, or perform a late architectural rewrite.`;
}

async function claudeTurn(project, trace, prompt, sessionId, resume = false, timeoutMinutes = 0, acceptDeadline = false, effort = executionDefaults.effort, model = executionDefaults.model, selfVerify = false) {
  const sessionArgs = resume ? ['--resume', sessionId] : ['--session-id', sessionId];
  const allowedTools = [
    'Read(./AGENTS.md)', 'Read(./package.json)', 'Read(./app.json)', 'Read(./index.js)', 'Read(./tsconfig.json)', 'Read(./App.tsx)', 'Read(./src/**)',
    'Read(./.expo-fast/model-capability-index.txt)', 'Read(./.expo-fast/sdk-fingerprint.json)',
    'Read(./.expo-fast/verification-errors.txt)', 'Read(./.expo-fast/capability-selection.json)',
    'Read(./.expo-fast/capability-resolution.log)', 'Read(./.expo-fast/typecheck.log)',
    'Read(./.expo-fast/source-audit.json)', 'Read(./.expo-fast/source-audit.log)',
    'Read(./.expo-fast/export.log)', 'Read(./.expo-fast/build-evidence.json)',
    'Write(./App.tsx)', 'Write(./src/**)', 'Write(./.expo-fast/brief.json)',
    'Edit(./App.tsx)', 'Edit(./src/**)', 'Edit(./.expo-fast/brief.json)', 'Edit(./package.json)',
  ];
  if (selfVerify) allowedTools.push('mcp__expo_fast__check', 'mcp__expo_fast__build');
  const mcpConfig = JSON.stringify({ mcpServers: selfVerify ? {
    expo_fast: { command: node22, args: [agentToolsServer, '--project', project] },
  } : {} });
  const tools = selfVerify ? 'Read,Write,Edit,mcp__expo_fast__check,mcp__expo_fast__build' : 'Read,Write,Edit';
  const args = ['-p', '--permission-mode', 'dontAsk', '--model', model, '--effort', effort, '--mcp-config', mcpConfig, '--strict-mcp-config', '--tools', tools, '--allowedTools', allowedTools.join(','), '--output-format', 'stream-json', '--verbose', ...sessionArgs, prompt];
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 0) throw new Error(`invalid Claude timeout: ${timeoutMinutes}`);
  const started = Date.now();
  const outcome = await new Promise((ok, fail) => {
    const child = spawn(claude, args, { cwd: project, env: { ...process.env, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = createWriteStream(trace, { flags: 'w' });
    const liveState = { pending: '' };
    child.stdout.on('data', (chunk) => { output.write(chunk); if (liveClaude) displayClaudeChunk(chunk, liveState); });
    child.stderr.on('data', (chunk) => { output.write(chunk); if (liveClaude) process.stderr.write(`[expo-fast Claude stderr] ${chunk}`); });
    let timedOut = false;
    const timer = timeoutMinutes > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGINT'); }, timeoutMinutes * 60_000) : null;
    child.on('error', (error) => { if (timer) clearTimeout(timer); output.end(); fail(error); });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer); output.end(() => {
        if (timedOut && acceptDeadline) ok({ deadlineReached: true, exitCode: code });
        else if (timedOut) fail(new Error(`claude exceeded ${timeoutMinutes} minute limit; partial trace saved to ${trace}`));
        else if (code === 0) ok({ deadlineReached: false, exitCode: code });
        else fail(new Error(`claude exited ${code}; partial trace saved to ${trace}`));
      });
    });
  });
  return { ms: Date.now() - started, ...outcome };
}
function hdcRun(args) {
  const r = spawnSync(hdc, args, { encoding: 'utf8' });
  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.status !== 0 || hdcOutputFailed(output)) {
    throw new Error(`hdc ${args.join(' ')} failed\n${output.trim()}`);
  }
  return r.stdout || '';
}
function reverseMappings() { return parseHdcForwardRules(hdcRun(['fport', 'ls'])); }
function clearReverse(target, devicePort, hostPort) {
  for (const mapping of reverseMappings()) {
    if (
      mapping.target !== target ||
      mapping.direction !== 'reverse' ||
      (mapping.devicePort !== devicePort && mapping.hostPort !== hostPort)
    ) continue;
    hdcRun(['-t', target, 'fport', 'rm', `tcp:${mapping.devicePort}`, `tcp:${mapping.hostPort}`]);
  }
}
function ensureReverse(target, devicePort, hostPort) {
  const active = reverseMappings().find((mapping) =>
    mapping.target === target &&
    mapping.direction === 'reverse' &&
    mapping.devicePort === devicePort &&
    mapping.hostPort === hostPort
  );
  if (active) return;
  clearReverse(target, devicePort, hostPort);
  hdcRun(['-t', target, 'rport', `tcp:${devicePort}`, `tcp:${hostPort}`]);
  const verified = reverseMappings().some((mapping) =>
    mapping.target === target &&
    mapping.direction === 'reverse' &&
    mapping.devicePort === devicePort &&
    mapping.hostPort === hostPort
  );
  if (!verified) throw new Error(`HDC reverse mapping did not become active on ${target}: tcp:${devicePort} -> tcp:${hostPort}`);
}
function ensureReverseWithFallback(target, preferredDevicePort, hostPort) {
  let lastError = null;
  for (const devicePort of reversePortCandidates(preferredDevicePort)) {
    try {
      ensureReverse(target, devicePort, hostPort);
      return devicePort;
    } catch (error) {
      lastError = error;
      if (!/TCP Port listen failed/i.test(String(error?.message || error))) throw error;
    }
  }
  throw new Error(
    `no free Harmony Go reverse port on ${target} from tcp:${preferredDevicePort}`,
    { cause: lastError },
  );
}
function harmonyGoUserId(target) {
  const bundleDump = hdcRun(['-t', target, 'shell', 'bm', 'dump', '-n', harmonyGoBundleName]);
  const userId = bundleDump.match(/"userId"\s*:\s*(\d+)/)?.[1];
  if (!userId) throw new Error(`Harmony Go is not installed or has no user profile on ${target}`);
  return userId;
}
function pauseMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms);
}
function ensureHarmonyGoInstalled(target) {
  let installed = true;
  try {
    harmonyGoUserId(target);
  } catch {
    installed = false;
  }
  if (!installed) {
    const hap = harmonyGoShellHapPath();
    if (!hap) {
      throw new Error(`Harmony Go is not installed on ${target} and no shell HAP is available; set EXPO_HARMONY_GO_HAP or build the shell via sdk harmony:go:build`);
    }
    hdcRun(['-t', target, 'install', '-r', hap]);
  }
  const userId = harmonyGoUserId(target);
  // A shell installed outside Runner may not have launched yet either. Ensure
  // its entry files directory exists before configureHarmonyGoOrigin writes it.
  const entryFiles = `/data/app/el2/${userId}/base/${harmonyGoBundleName}/haps/entry/files`;
  let probe = spawnSync(hdc, ['-t', target, 'shell', `test -d ${entryFiles} && echo EXISTS`], { encoding: 'utf8' });
  if (!(probe.stdout || '').includes('EXISTS')) {
    startHarmonyGo(target);
    const deadline = Date.now() + 15000;
    for (;;) {
      probe = spawnSync(hdc, ['-t', target, 'shell', `test -d ${entryFiles} && echo EXISTS`], { encoding: 'utf8' });
      if ((probe.stdout || '').includes('EXISTS')) break;
      if (Date.now() > deadline) throw new Error(`Harmony Go entry files directory did not appear on ${target}: ${entryFiles}`);
      pauseMs(500);
    }
    hdcRun(['-t', target, 'shell', 'aa', 'force-stop', harmonyGoBundleName]);
  }
}
function configureHarmonyGoOrigin(target, devicePort) {
  const bundleName = harmonyGoBundleName;
  const userId = harmonyGoUserId(target);
  const configPath = `/data/app/el2/${userId}/base/${bundleName}/haps/entry/files/miniapp-server.txt`;
  const origin = `http://127.0.0.1:${devicePort}`;
  hdcRun(['-t', target, 'shell', `printf '${origin}\\n' > ${configPath}`]);
  const stored = hdcRun(['-t', target, 'shell', 'cat', configPath]).trim();
  if (stored !== origin) throw new Error(`Harmony Go server origin was not saved on ${target}: ${stored || '<empty>'}`);
  return origin;
}
function frontendRunId(project) {
  const match = basename(project).match(/([a-f0-9]{32})$/i);
  if (!match) throw new Error(`project name does not contain a frontend run id: ${basename(project)}`);
  return match[1].toLowerCase();
}
function previewTargetError(kind, target, error) {
  const wrapped = new Error(
    `Harmony Go ${kind} preview device ${target} failed: ${String(error?.message || error)}`,
    { cause: error },
  );
  wrapped.previewKind = kind;
  wrapped.previewTarget = target;
  return wrapped;
}
function wakeAndUnlockHarmonyTarget(target) {
  hdcRun(['-t', target, 'shell', 'power-shell', 'wakeup']);
  hdcRun([
    '-t', target,
    'shell', 'uitest', 'uiInput', 'swipe',
    '1560', '1700', '1560', '500', '1000',
  ]);
}
function startHarmonyGo(target) {
  const args = ['-t', target, 'shell', 'aa', 'start', '-a', 'EntryAbility', '-b', harmonyGoBundleName];
  try {
    hdcRun(args);
  } catch (error) {
    if (!/10106102|device screen is locked/i.test(String(error?.message || error))) throw error;
    wakeAndUnlockHarmonyTarget(target);
    hdcRun(args);
  }
}
export function prepareHarmonyGoTarget(kind, target, devicePort, gatewayPort) {
  try {
    ensureHarmonyGoInstalled(target);
    const activeDevicePort = ensureReverseWithFallback(target, devicePort, gatewayPort);
    configureHarmonyGoOrigin(target, activeDevicePort);
    wakeAndUnlockHarmonyTarget(target);
    hdcRun(['-t', target, 'shell', 'uitest', 'uiInput', 'keyEvent', 'Home']);
    hdcRun(['-t', target, 'shell', 'aa', 'force-stop', harmonyGoBundleName]);
    startHarmonyGo(target);
    return activeDevicePort;
  } catch (error) {
    throw previewTargetError(kind, target, error);
  }
}
export async function verifyHarmonyGoForeground(project, kind, target) {
  let visible = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    try {
      const layout = dumpLayout(project, target, `launch-shell-${kind}`);
      visible = visibleBundleNames(layout);
      if (visible.includes(harmonyGoBundleName)) return;
    } catch (error) {
      if (attempt === 5) throw previewTargetError(kind, target, error);
    }
  }
  throw previewTargetError(
    kind,
    target,
    new Error(`Harmony Go did not reach the foreground; visible bundle(s): ${visible.join(', ') || 'none'}`),
  );
}
export async function launchHapPreview(project, pools, hap, onWait = () => {}, dependencies = {}) {
  const acquireDevice = dependencies.acquireDevice || acquirePreviewDevice;
  const installPreview = dependencies.installPreview || installHapAndOpen;
  const discoverTargets = dependencies.discoverTargets || (async () => {
    const connected = parseHdcTargets(hdcRun(['list', 'targets']));
    const discovered = discoverHdcPreviewPools(hdc, connected).desktop;
    return prioritizeHdcPreviewTargets(discovered, pools.desktop);
  });
  const excluded = new Set();
  let lastFailure = null;
  for (;;) {
    const availableTargets = async () => (await discoverTargets()).filter((target) => !excluded.has(target));
    if (lastFailure && (await availableTargets()).length === 0) {
      throw new Error(
        `all desktop preview targets failed HAP installation; last failure: ${String(lastFailure?.message || lastFailure)}`,
        { cause: lastFailure },
      );
    }
    const lease = await acquireDevice({
      runId: frontendRunId(project),
      kind: 'desktop',
      availableTargets,
      onWait: (event) => onWait({ ...event, kind: 'desktop' }),
    });
    const target = lease.target;
    try {
      const result = await installPreview(project, target, hap, 'desktop');
      return { target, previews: { desktop: target }, lease, result };
    } catch (error) {
      lastFailure = previewTargetError('desktop', target, error);
      excluded.add(target);
      try {
        await lease.quarantine(target, lastFailure.stack || lastFailure);
        onWait({ status: 'retrying', kind: 'desktop', target, queuedAt: new Date().toISOString() });
      } finally {
        await lease.release();
      }
    }
  }
}
async function installHapAndOpen(project, target, hap, previewKind = 'desktop') {
  const hapPath = String(hap?.hapPath || '').trim();
  const bundleName = String(hap?.bundleName || '').trim();
  if (!hapPath || !existsSync(hapPath)) throw new Error('desktop preview HAP is missing');
  if (!bundleName) throw new Error('desktop preview HAP has no bundleName');
  hdcRun(['-t', target, 'shell', 'aa', 'force-stop', bundleName]);
  try { hdcRun(['-t', target, 'shell', 'bm', 'uninstall', '-n', bundleName]); } catch {}
  hdcRun(['-t', target, 'install', '-r', hapPath]);
  wakeAndUnlockHarmonyTarget(target);
  const startArgs = ['-t', target, 'shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundleName];
  try {
    hdcRun(startArgs);
  } catch (error) {
    if (!/10106102|device screen is locked/i.test(String(error?.message || error))) throw error;
    wakeAndUnlockHarmonyTarget(target);
    hdcRun(startArgs);
  }
  let layout = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    layout = dumpLayout(project, target, `launch-product-${previewKind}`);
    if (visibleBundleNames(layout).includes(bundleName)) break;
  }
  const visible = visibleBundleNames(layout || {});
  if (!visible.includes(bundleName)) {
    throw new Error(`installed HAP did not reach foreground; expected ${bundleName}, visible=${visible.join(', ') || 'none'}`);
  }
  const shotDevice = `/data/local/tmp/expo-fast-${process.pid}-launch-${previewKind}.jpeg`;
  const shotLocal = join(project, `.expo-fast/launch-screenshot-${previewKind}.jpeg`);
  hdcRun(['-t', target, 'shell', 'uitest', 'screenCap', '-p', shotDevice]);
  hdcRun(['-t', target, 'file', 'recv', shotDevice, shotLocal]);
  return { result: 'PASS', target, previewKind, screenshot: shotLocal, bundleName, hapPath };
}
function nodeText(node) { const a = node?.attributes || {}; return a.text || a.originalText || a.description || ''; }
function children(node) { return node.children || []; }
function subtreeHas(node, text) { return nodeText(node) === text || children(node).some((child) => subtreeHas(child, text)); }
function collect(node, predicate, out = []) { if (predicate(node)) out.push(node); for (const child of children(node)) collect(child, predicate, out); return out; }
function boundsCenter(node) { const value = node.attributes?.bounds || ''; const match = value.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); if (!match) throw new Error(`node has invalid bounds: ${value}`); return [Math.round((Number(match[1]) + Number(match[3])) / 2), Math.round((Number(match[2]) + Number(match[4])) / 2)]; }
function catalogProjectCard(layout, identity) {
  const projectId = /^remote-ui-[a-f0-9]{32}$/;
  const actionLabels = new Set(['安装', '打开', '移除']);
  const candidates = collect(layout, (node) => {
    const ids = new Set(collect(node, (child) => projectId.test(nodeText(child))).map(nodeText));
    const hasAction = collect(node, (child) => child.attributes?.type === 'Button' && actionLabels.has(nodeText(child))).length > 0;
    return ids.size === 1 && ids.has(identity) && hasAction;
  });
  candidates.sort((a, b) => JSON.stringify(a).length - JSON.stringify(b).length);
  return candidates[0] || null;
}
function relatedButton(layout, identity, labels) {
  const card = catalogProjectCard(layout, identity);
  return card ? collect(card, (node) => node.attributes?.type === 'Button' && labels.includes(nodeText(node)))[0] || null : null;
}
function dumpLayout(project, target, name) { const device = `/data/local/tmp/expo-fast-${process.pid}-${name}.json`; const local = join(project, '.expo-fast', `${name}.json`); hdcRun(['-t', target, 'shell', 'uitest', 'dumpLayout', '-p', device]); hdcRun(['-t', target, 'file', 'recv', device, local]); return JSON.parse(readFileSync(local, 'utf8')); }
function tapNode(target, node) { const [x, y] = boundsCenter(node); hdcRun(['-t', target, 'shell', 'uitest', 'uiInput', 'click', String(x), String(y)]); return { x, y, bounds: node.attributes.bounds, text: nodeText(node) }; }
function replaceTextInput(target, node, value) {
  const action = tapNode(target, node);
  hdcRun(['-t', target, 'shell', 'uitest', 'uiInput', 'keyEvent', '2072', '2017']);
  hdcRun(['-t', target, 'shell', 'uitest', 'uiInput', 'text', value]);
  hdcRun(['-t', target, 'shell', 'uitest', 'uiInput', 'keyEvent', 'Back']);
  return { ...action, value };
}
function catalogStatus(layout) {
  return collect(layout, (node) => /^(?:正在发现|开发服务)/.test(nodeText(node))).map(nodeText)[0] || 'catalog status unavailable';
}
async function waitForLayout(project, target, name, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let layout;
  do {
    layout = dumpLayout(project, target, name);
    if (predicate(layout)) return layout;
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  return layout;
}
function catalogHasProject(layout, manifestId) {
  return collect(layout, (node) => nodeText(node) === manifestId).length > 0;
}
function catalogVisibleProjectIds(layout) {
  return [...new Set(
    collect(layout, (node) => /^remote-ui-[a-f0-9]{32}$/.test(nodeText(node))).map(nodeText),
  )];
}
function catalogViewport(layout) {
  const candidates = collect(layout, (node) => {
    const match = String(node.attributes?.bounds || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    return node.attributes?.scrollable === 'true' && node.attributes?.visible !== 'false' && match;
  }).map((node) => {
    const match = String(node.attributes.bounds).match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const left = Number(match[1]);
    const top = Number(match[2]);
    const right = Number(match[3]);
    const bottom = Number(match[4]);
    return { node, left, top, right, bottom, area: Math.max(0, right - left) * Math.max(0, bottom - top) };
  }).sort((left, right) => right.area - left.area);
  return candidates[0] || null;
}
function catalogFingerprint(layout) {
  return collect(layout, (node) => /^remote-ui-[a-f0-9]{32}$/.test(nodeText(node)))
    .map((node) => `${nodeText(node)}@${node.attributes?.bounds || ''}`)
    .join('|');
}
async function revealCatalogProject(project, target, manifestId, layout, actions, evidenceName) {
  let current = layout;
  const seen = new Set();
  // Harmony Go renders the catalog as a scroll view. The aggregate gateway can
  // contain more projects than fit in one accessibility dump, so do not treat
  // a connected catalog with a missing first-page card as a missing app.
  for (let step = 0; step < 16 && !catalogHasProject(current, manifestId); step += 1) {
    const visible = catalogVisibleProjectIds(current);
    const signature = catalogFingerprint(current);
    if (seen.has(signature)) break;
    seen.add(signature);
    const viewport = catalogViewport(current);
    if (!viewport) break;
    const width = viewport.right - viewport.left;
    const height = viewport.bottom - viewport.top;
    const action = {
      action: 'scroll-catalog',
      direction: 'down',
      step: step + 1,
      from: { x: Math.round(viewport.left + width * 0.5), y: Math.round(viewport.top + height * 0.82) },
      to: { x: Math.round(viewport.left + width * 0.5), y: Math.round(viewport.top + height * 0.28) },
      visible,
    };
    hdcRun([
      '-t', target,
      'shell', 'uitest', 'uiInput', 'swipe',
      String(action.from.x), String(action.from.y),
      String(action.to.x), String(action.to.y),
      '500',
    ]);
    actions.push(action);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    current = dumpLayout(project, target, evidenceName('launch-catalog'));
  }
  return current;
}
async function prepareCatalog(project, target, manifestId, actions, evidenceName, expectedOrigin) {
  let layout = dumpLayout(project, target, evidenceName('launch-catalog'));
  const foregroundBundles = visibleBundleNames(layout);
  if (!foregroundBundles.includes(harmonyGoBundleName)) {
    throw new Error(`Harmony Go did not reach the foreground on target ${target}; visible bundle(s): ${foregroundBundles.join(', ') || 'none'}`);
  }
  const projectsTab = collect(layout, (node) => node.attributes?.type === 'Button' && nodeText(node) === '项目')[0];
  if (projectsTab) {
    actions.push({ action: 'catalog', ...tapNode(target, projectsTab) });
    await new Promise((r) => setTimeout(r, 500));
  }
  layout = await waitForLayout(project, target, evidenceName('launch-catalog'), (candidate) => {
    const inputReady = collect(candidate, (node) => node.attributes?.type === 'TextInput').length > 0;
    const refreshReady = collect(candidate, (node) => node.attributes?.type === 'Button' && nodeText(node) === '刷新').length > 0;
    return inputReady && refreshReady;
  });
  let serverInput = collect(layout, (node) => node.attributes?.type === 'TextInput')[0];
  if (!serverInput) throw new Error('Harmony Go catalog server input is unavailable');
  if (nodeText(serverInput) !== expectedOrigin) {
    actions.push({ action: 'set-catalog-origin', ...replaceTextInput(target, serverInput, expectedOrigin) });
    await new Promise((r) => setTimeout(r, 500));
    layout = dumpLayout(project, target, evidenceName('launch-catalog'));
    serverInput = collect(layout, (node) => node.attributes?.type === 'TextInput')[0];
    if (!serverInput || nodeText(serverInput) !== expectedOrigin) {
      throw new Error(`could not set Harmony Go catalog origin to ${expectedOrigin}`);
    }
  }
  const refresh = collect(layout, (node) => node.attributes?.type === 'Button' && nodeText(node) === '刷新')[0];
  if (!refresh) throw new Error(`Harmony Go catalog refresh is unavailable; status=${catalogStatus(layout)}`);
  actions.push({ action: 'refresh-catalog', ...tapNode(target, refresh) });
  layout = await waitForLayout(project, target, evidenceName('launch-catalog'), (candidate) => {
    const online = collect(candidate, (node) => nodeText(node).startsWith('开发服务已连接')).length > 0;
    const origin = collect(candidate, (node) => node.attributes?.type === 'TextInput')[0];
    return online && nodeText(origin) === expectedOrigin;
  });
  const catalogConnected = Boolean(
    layout && collect(layout, (node) => nodeText(node).startsWith('开发服务已连接')).length,
  );
  if (!catalogHasProject(layout, manifestId)) {
    layout = await revealCatalogProject(project, target, manifestId, layout, actions, evidenceName);
  }
  if (!catalogConnected || !layout || !catalogHasProject(layout, manifestId)) {
    const origin = collect(layout || {}, (node) => node.attributes?.type === 'TextInput')[0];
    throw new Error(`Harmony Go catalog did not expose mini app ${manifestId} from ${expectedOrigin}; origin=${nodeText(origin) || 'unavailable'}; status=${catalogStatus(layout || {})}`);
  }
  return layout;
}
async function waitForInstalledMiniApp(project, target, manifestId, productMarkers, layout, actions, evidenceName, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let current = layout;
  let identity = inspectCurrentMiniApp(current, manifestId, productMarkers);
  while (Date.now() < deadline) {
    if (identity.ok) return { layout: current, open: null };
    if (!catalogHasProject(current, manifestId)) {
      current = await revealCatalogProject(project, target, manifestId, current, actions, evidenceName);
      identity = inspectCurrentMiniApp(current, manifestId, productMarkers);
      if (identity.ok) return { layout: current, open: null };
    }
    const open = relatedButton(current, manifestId, ['打开']);
    if (open) return { layout: current, open };
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    current = dumpLayout(project, target, evidenceName('launch-installed'));
    identity = inspectCurrentMiniApp(current, manifestId, productMarkers);
  }
  const card = catalogProjectCard(current, manifestId);
  const cardActions = card
    ? collect(card, (node) => node.attributes?.type === 'Button').map(nodeText).filter(Boolean)
    : [];
  throw new Error(`timed out waiting for mini app ${manifestId} to install; target card action(s)=${cardActions.join(', ') || 'unavailable'}; current identity=${identity.errors.join('; ')}`);
}
export async function installAndOpen(project, target, manifestId, previewKind = '', devicePort = 3333, options = {}) {
  const source = [join(project, 'App.tsx'), ...readdirSync(join(project, 'src'), { recursive: true }).filter((entry) => /\.[jt]sx?$/.test(String(entry))).map((entry) => join(project, 'src', String(entry)))].filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8')).join('\n');
  const testIds = [...source.matchAll(/testID=["']([^"']+)["']/g)].map((match) => match[1]);
  const sharedTemplateIds = new Set(['app-shell', 'responsive-navigation', 'primary-action', 'item-count']);
  const productMarkers = testIds.filter((id) => !sharedTemplateIds.has(id) && !/^tab-(?:home|activity|settings)$/.test(id));
  if (!productMarkers.length) throw new Error(`current source has no run-specific literal testID for exact-app identity: ${manifestId}`);
  const evidenceName = (name) => previewKind ? `${name}-${previewKind}` : name;
  const actions = [];
  const expectedOrigin = devicePort === 3333 ? harmonyGoLocalOrigin : `http://127.0.0.1:${devicePort}`;
  let layout = await prepareCatalog(project, target, manifestId, actions, evidenceName, expectedOrigin);
  const remove = relatedButton(layout, manifestId, ['移除']);
  if (remove && options.replaceInstalled !== false) {
    actions.push({ action: 'remove-stale-bundle', ...tapNode(target, remove) });
    await new Promise((r) => setTimeout(r, 2000));
    layout = dumpLayout(project, target, evidenceName('launch-catalog'));
  }
  let install = relatedButton(layout, manifestId, ['安装']);
  if (!install) {
    const refresh = collect(layout, (node) => node.attributes?.type === 'Button' && nodeText(node) === '刷新')[0];
    if (refresh) { tapNode(target, refresh); await new Promise((r) => setTimeout(r, 1500)); layout = dumpLayout(project, target, evidenceName('launch-catalog')); install = relatedButton(layout, manifestId, ['安装']); }
  }
  if (install) actions.push({ action: 'install', ...tapNode(target, install) });
  const installed = await waitForInstalledMiniApp(project, target, manifestId, productMarkers, layout, actions, evidenceName);
  layout = installed.layout;
  if (installed.open) {
    actions.push({ action: 'open', ...tapNode(target, installed.open) });
    layout = await waitForLayout(
      project,
      target,
      evidenceName('launch-product'),
      (candidate) => inspectCurrentMiniApp(candidate, manifestId, productMarkers).ok,
      180_000,
    );
  }
  const identity = assertCurrentMiniApp(layout, manifestId, productMarkers, 'launch-product');
  const shotDevice = `/data/local/tmp/expo-fast-${process.pid}-launch-${previewKind || 'default'}.jpeg`; const shotLocal = join(project, `.expo-fast/launch-screenshot${previewKind ? `-${previewKind}` : ''}.jpeg`); hdcRun(['-t', target, 'shell', 'uitest', 'screenCap', '-p', shotDevice]); hdcRun(['-t', target, 'file', 'recv', shotDevice, shotLocal]);
  return { result: 'PASS', target, previewKind, screenshot: shotLocal, bundleName: harmonyGoBundleName, manifestId, currentProjectTitle: identity.currentProjectTitle, currentProjectBounds: identity.currentProjectBounds, appNode: identity.productMarker, appNodeBounds: identity.productMarkerBounds, actions };
}
async function main() {
  const o = parse(process.argv.slice(2)); const project = resolve(o.project); const request = resolve(o.request || join(project, '.expo-fast/request.md')); const requestText = readFileSync(request, 'utf8'); const invocationStartedAt = new Date();
  activeRunState = { project, runId: randomUUID(), startedAt: invocationStartedAt.toISOString(), state: 'generating_code' };
  if (Object.hasOwn(o, 'candidate')) throw new Error('--candidate is no longer supported; pass --model, --effort, --repairModel, and --repairEffort directly');
  const action = o.action || 'initial';
  if (!['initial', 'follow-up', 'rebuild', 'preview'].includes(action)) throw new Error(`unknown action: ${action}`);
  activeRunState.action = action;
  const isInitial = action === 'initial';
  const isFollowUp = action === 'follow-up';
  const followUpPath = isFollowUp ? resolve(o.followUp || '') : '';
  if (isFollowUp && (!followUpPath || !existsSync(followUpPath))) throw new Error(`follow-up request does not exist: ${followUpPath || '<missing>'}`);
  const { model, effort, repairModel, repairEffort, repairLimit } = resolveExecution(o);
  const execution = { model, effort, repairModel, repairEffort, repairLimit };
  const stateContext = { ...execution, action, resume: !isInitial };
  if (o.launch !== 'false' && (o.smokeAgent === 'true' || o['smoke-agent'] === 'true' || o.validateSmoke === 'true' || o['validate-smoke'] === 'true')) {
    throw new Error('Harmony Go smoke validation is not supported for direct-HAP preview; rerun without --smoke-agent/--validate-smoke');
  }
  progress(`start · action=${action} · model=${model} · effort=${effort} · repair=${repairModel}/${repairEffort} · project=${project}`);
  if (o.baseProject || o['base-project']) throw new Error('Cold-start experiment integrity forbids --baseProject/--base-project. Use a new empty project directory.');
  const oldResultPath = join(project, '.expo-fast/result.json');
  if (!isInitial && !existsSync(oldResultPath)) throw new Error(`${action} requires an existing .expo-fast/result.json`);
  const metrics = !isInitial
    ? JSON.parse(readFileSync(oldResultPath, 'utf8'))
    : { execution, project, request, startedAt: invocationStartedAt.toISOString(), stages: {}, revisions: [] };
  delete metrics.candidate;
  delete metrics.selection;
  metrics.execution = execution;
  metrics.stages ||= {};
  activeMetrics = metrics;
  activeResultPath = oldResultPath;
  if (!isInitial) { setRunState('generating_code', action === 'follow-up' ? 'follow_up' : action, stateContext, { reset: true }); recoverTrace(project, metrics); recoverRepairTrace(project, metrics); }
  let sessionId = metrics.sessionId;
  let currentRevision = null;
  let revisionDirectory = join(project, '.expo-fast');
  let implementationTrace = join(project, '.expo-fast/agent-trace.jsonl');
  if (isInitial) {
    progress('prepare cold-start template and capability index');
    run(node22, [helper, 'prepare', project, request]); setRunState('generating_code', 'preparing', stateContext, { reset: true }); writeFileSync(join(project, 'AGENTS.md'), readFileSync(join(root, 'AGENTS.md'))); writeFileSync(join(project, 'CLAUDE.md'), '@AGENTS.md\n');
    const modelCapabilityIndex = writeModelCapabilityIndex(project, requestText);
    const experiment = { schemaVersion: 1, protocol: 'cold-start-v1', coldStart: true, sourceInheritance: false, requestSha256: sha256(requestText), templateAssetSha256: digestProductSource(join(root, 'templates/expo-harmony')), templateProductSha256: digestProductSource(project), capabilityCatalogSha256: modelCapabilityIndex.sourceSha256, modelCapabilityIndexSha256: modelCapabilityIndex.sha256, modelCapabilityIndexBytes: modelCapabilityIndex.bytes, requiredCapabilities: modelCapabilityIndex.requiredPackages, preparedAt: new Date().toISOString() };
    writeJson(join(project, '.expo-fast/experiment.json'), experiment);
    metrics.experiment = experiment;
    metrics.stages.seedModulesMs = run(node22, [dependencies, 'seed', project]).ms;
    progress(`dependencies prepared · ${metrics.stages.seedModulesMs}ms`);
    sessionId = randomUUID(); metrics.sessionId = sessionId;
    setRunState('generating_code', 'model_generation', { sessionId });
    progress(`implementation turn · session=${sessionId} · model=${model} · effort=${effort}`);
    const implementationTurn = await claudeTurn(project, join(project, '.expo-fast/agent-trace.jsonl'), buildPrompt(project), sessionId, false, Number(o.claudeTimeoutMinutes || 0), o.acceptClaudeDeadline === 'true', effort, model);
    metrics.stages.claudeMs = implementationTurn.ms; metrics.claudeDeadlineReached = implementationTurn.deadlineReached;
    progress(`implementation turn finished · ${metrics.stages.claudeMs}ms`);
    recoverTrace(project, metrics);
    currentRevision = {
      number: 0,
      kind: 'initial',
      status: 'running',
      request: relative(project, request),
      trace: '.expo-fast/agent-trace.jsonl',
      startedAt: invocationStartedAt.toISOString(),
      repairAttempts: [],
    };
    activeRevision = currentRevision;
    metrics.revisions = [currentRevision];
  } else if (isFollowUp) {
    if (!sessionId) throw new Error('follow-up requires the original Claude sessionId in result.json');
    const started = beginFollowUpRevision(project, metrics, followUpPath, invocationStartedAt);
    currentRevision = started.revision;
    activeRevision = currentRevision;
    revisionDirectory = started.directory;
    implementationTrace = join(revisionDirectory, 'agent-trace.jsonl');
    writeJson(oldResultPath, metrics);
    const followUpText = readFileSync(followUpPath, 'utf8').trim();
    if (!followUpText) throw new Error('follow-up request is empty');
    setRunState('generating_code', 'follow_up', { ...stateContext, revision: currentRevision.number, sessionId });
    progress(`follow-up turn · revision=${currentRevision.number} · session=${sessionId} · model=${model} · effort=${effort}`);
    const followUpTurn = await claudeTurn(project, implementationTrace, buildFollowUpPrompt(followUpText), sessionId, true, Number(o.claudeTimeoutMinutes || 0), false, effort, model, true);
    currentRevision.agentMs = followUpTurn.ms;
    currentRevision.usage = traceUsage(implementationTrace);
    progress(`follow-up turn finished · ${followUpTurn.ms}ms`);
  }
  if (existsSync(implementationTrace)) {
    const auditPath = join(revisionDirectory, 'trace-scope-audit.json');
    const auditLabel = isFollowUp ? `follow-up ${currentRevision.number}` : 'implementation';
    const scope = advisoryTraceScope(auditImplementationTrace(project, implementationTrace), auditLabel, relative(project, auditPath));
    if (currentRevision) currentRevision.traceScope = scope;
    if (isInitial) metrics.traceScope = scope;
    writeJson(auditPath, scope);
  }
  const catalogRoot = join(project, 'dist/harmony-go');
  let repairAttempt = 0;
  const verificationBase = isFollowUp ? `FollowUp${currentRevision.number}` : action === 'rebuild' ? `Rebuild${(metrics.operations?.length || 0) + 1}` : '';
  let verificationSuffix = verificationBase;
  while (action !== 'preview') {
    const isRepairVerification = repairAttempt > 0;
    setRunState(isRepairVerification ? 'repairing' : activeRunState.state, isRepairVerification ? 'repair_verification' : 'verification', { repairAttempt, action, revision: currentRevision?.number });
    progress(isRepairVerification ? `deterministic repair verification · attempt=${repairAttempt}` : 'deterministic dependency/typecheck/source/export gates');
    try {
      verifyImplementation({ project, catalogRoot, node: node22, metrics, suffix: verificationSuffix });
      progress(isRepairVerification ? `repair gates passed · attempts=${repairAttempt}` : 'deterministic gates passed');
      break;
    } catch (error) {
      writeFileSync(join(project, '.expo-fast/verification-errors.txt'), `${error.stack || error}\n`);
      if (!isInitial && !isFollowUp) throw error;
      if (repairAttempt >= repairLimit) {
        throw new Error(`deterministic verification still failed after ${repairLimit} repair attempts`, { cause: error });
      }
      repairAttempt += 1;
      setRunState('repairing', 'model_repair', { repairAttempt, repairLimit, action, revision: currentRevision?.number });
      progress(`deterministic gates failed; starting same-session repair ${repairAttempt} · model=${repairModel} · effort=${repairEffort}`);
      const traceName = repairArtifactName('agent-repair-trace', repairAttempt, '.jsonl');
      const auditName = repairArtifactName('repair-trace-scope-audit', repairAttempt, '.json');
      const repairTrace = join(revisionDirectory, traceName);
      const attemptMetrics = { attempt: repairAttempt, model: repairModel, effort: repairEffort, trace: relative(project, repairTrace), startedAt: new Date().toISOString(), status: 'running' };
      (metrics.repairAttempts ||= []).push(attemptMetrics);
      if (currentRevision) currentRevision.repairAttempts.push(attemptMetrics);
      try {
        const repairTurn = await claudeTurn(project, repairTrace, `Deterministic verification failed on repair cycle ${repairAttempt}. Read only .expo-fast/verification-errors.txt and the whitelisted current product source or deterministic diagnostic files needed to understand it. Fix only reported product problems in App.tsx/src/**, .expo-fast/brief.json, or package.json dependencies. Any dependency must use its exact catalog.available version; preserve all scaffold dependencies and other package.json fields. Use expo_fast.check after edits, fix every reported diagnostic, then use expo_fast.build once before stopping. Do not attempt any other path or run arbitrary shell commands.`, sessionId, true, Number(o.repairTimeoutMinutes ?? 0), false, repairEffort, repairModel, true);
        attemptMetrics.ms = repairTurn.ms;
        attemptMetrics.status = 'completed';
        attemptMetrics.completedAt = new Date().toISOString();
        metrics.stages.repairMs = (Number(metrics.stages.repairMs) || 0) + repairTurn.ms;
      } catch (repairError) {
        attemptMetrics.status = 'failed';
        attemptMetrics.completedAt = new Date().toISOString();
        attemptMetrics.error = String(repairError.stack || repairError).slice(0, 4000);
        throw repairError;
      }
      recoverRepairTrace(project, metrics, repairTrace);
      const auditArtifact = relative(project, join(revisionDirectory, auditName));
      const traceScope = advisoryTraceScope(auditImplementationTrace(project, repairTrace), `repair ${repairAttempt}`, auditArtifact);
      attemptMetrics.traceScope = traceScope;
      (metrics.repairTraceScopes ||= []).push({ attempt: repairAttempt, trace: relative(project, repairTrace), ...traceScope });
      if (repairAttempt === 1) metrics.repairTraceScope = traceScope;
      writeJson(join(revisionDirectory, auditName), traceScope);
      verificationSuffix = `${verificationBase}${repairAttempt === 1 ? 'Retry' : `Retry${repairAttempt}`}`;
    }
  }
  if (!isInitial && !metrics.generationMs && metrics.stages.claudeMs) {
    metrics.generationMs = Object.entries(metrics.stages).filter(([name]) => /^(?:seedModules|claude|repair|dependencySync|typecheck|sourceAudit|export|artifactAudit).*Ms$/.test(name)).reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
    metrics.totalMs = metrics.generationMs;
  }
  if (isInitial) {
    metrics.generationCompletedAt = new Date().toISOString();
    metrics.generationMs = Date.now() - invocationStartedAt.getTime();
    metrics.totalMs = metrics.generationMs;
  }
  let hap = readExistingHapResult(project);
  if (o.hap === 'true' && (action === 'rebuild' || hap?.status !== 'ready')) {
    const pool = resolve(o.pool || process.env.EXPO_HARMONY_POOL_ROOT || join(root, '../harmony-pool'));
    const waitSeconds = Number(o.hapWaitSeconds || process.env.EXPO_HARMONY_HAP_WAIT_SECONDS || 3600);
    setRunState(activeRunState.state, 'hap_building', { hap: { status: 'building', pool, startedAt: new Date().toISOString() } });
    progress(`build unsigned HAP through SDK pool · pool=${pool}`);
    const startedAt = Date.now();
    hap = runHapPoolBuild({
      project,
      sdk,
      pool,
      node: node22,
      runId: activeRunState.runId,
      waitSeconds,
      reuseExisting: action !== 'rebuild',
    });
    metrics.stages.hapBuildMs = Date.now() - startedAt;
    progress(hap.status === 'ready'
      ? `unsigned HAP ready · slot=${hap.slotId || 'unknown'} · ${hap.hapPath}`
      : `unsigned HAP failed · ${hap.failureStage || 'unknown'} · ${hap.error || 'see build-result.json'}`);
  } else if (o.hap !== 'true' && isInitial) {
    hap = { status: 'skipped' };
  }
  hap ||= { status: 'skipped' };
  metrics.hap = hap;
  let previewFailure = null;
  let launchPreviewState = {};
  if (o.launch !== 'false') {
    const manifest = JSON.parse(readFileSync(join(project, '.expo-fast/manifest.json'), 'utf8'));
    const splitTargets = (value) => String(value || '').split(/[\s,]+/).map((target) => target.trim()).filter(Boolean);
    const configuredPools = configuredPreviewPools();
    const desktopPreferences = splitTargets(o.desktopTargets).length
      ? splitTargets(o.desktopTargets)
      : configuredPools.desktop;
    const previewPools = { desktop: desktopPreferences };
    try {
      if (hap?.status !== 'ready') throw new Error('PC 模拟器预览需要先生成可安装的 HAP。');
      launchPreviewState = {
        desktop: { status: 'queued', target: '' },
      };
      writeJson(join(project, '.expo-fast/launch-previews.json'), {
        manifestId: manifest.id,
        status: 'queued',
        pools: previewPools,
        previews: launchPreviewState,
      });
      setRunState(activeRunState.state, 'preview_queued', {
        hap,
        preview: { status: 'queued', pools: previewPools },
      });
      progress(`wait for desktop preview device · preferred=[${previewPools.desktop.join(',')}]`);
      const live = await launchHapPreview(project, previewPools, hap, ({ queuedAt }) => {
        setRunState(activeRunState.state, 'preview_queued', {
          preview: { status: 'queued', pools: previewPools, queuedAt },
        });
      });
      try {
        setRunState(activeRunState.state, 'launching', {
          preview: { status: 'running', leaseId: live.lease.leaseId, targets: live.previews },
        });
        launchPreviewState = Object.fromEntries(
          Object.entries(live.previews).map(([kind, target]) => [kind, { status: 'running', target }]),
        );
        writeJson(join(project, '.expo-fast/launch-previews.json'), {
          manifestId: manifest.id,
          status: 'running',
          leaseId: live.lease.leaseId,
          pools: previewPools,
          previews: launchPreviewState,
        });
        progress(`desktop preview lease acquired · target=${live.previews.desktop}`);
        const primaryResult = live.result;
        const previewResults = { desktop: { status: 'complete', ...primaryResult } };
        writeFileSync(join(project, '.expo-fast/launch-screenshot.jpeg'), readFileSync(primaryResult.screenshot));
        progress(`direct HAP desktop preview passed · target=${live.target}`);
        metrics.launch = { ...primaryResult, previews: previewResults };
        metrics.preview = { status: 'complete', failedKinds: [], targets: live.previews };
        writeJson(join(project, '.expo-fast/launch-previews.json'), {
          manifestId: manifest.id,
          status: metrics.preview.status,
          pools: previewPools,
          previews: previewResults,
        });
        launchPreviewState = { ...previewResults };
        progress(`direct HAP preview finished · manifest=${manifest.id} · status=${metrics.preview.status}`);
      } finally {
        await live.lease.release();
      }
    } catch (error) {
      previewFailure = String(error.stack || error);
      metrics.preview = { status: 'failed', error: previewFailure };
      const currentDesktop = launchPreviewState.desktop || { target: '' };
      launchPreviewState = {
        desktop: currentDesktop.status === 'complete'
          ? currentDesktop
          : { ...currentDesktop, status: 'failed', error: previewFailure },
      };
      writeJson(join(project, '.expo-fast/launch-previews.json'), {
        manifestId: manifest.id,
        status: 'failed',
        pools: previewPools,
        previews: launchPreviewState,
        error: previewFailure,
      });
      setRunState(activeRunState.state, 'preview_failed', {
        hap,
        preview: { status: 'failed', error: previewFailure.slice(0, 4000) },
      });
      console.warn(`[expo-fast] preview failed; generated bundle and HAP result remain valid\n${previewFailure}`);
    }
  } else {
    metrics.preview = { status: 'skipped' };
  }
  const completedAt = new Date().toISOString();
  const operationMs = Date.now() - invocationStartedAt.getTime();
  if (!isInitial) (metrics.resumes ||= []).push({ startedAt: invocationStartedAt.toISOString(), completedAt, ms: operationMs, purpose: action });
  metrics.completedAt = completedAt;
  if (isInitial) metrics.totalMs = operationMs;
  else metrics.lastOperationMs = operationMs;
  metrics.status = hap?.status === 'failed' || previewFailure || metrics.preview?.status === 'partial' ? 'partial' : 'passed';
  if (!currentRevision && !isInitial) (metrics.operations ||= []).push({ action, startedAt: invocationStartedAt.toISOString(), completedAt, ms: operationMs, status: metrics.status });
  if (currentRevision) {
    currentRevision.completedAt = completedAt;
    currentRevision.durationMs = operationMs;
    currentRevision.status = metrics.status;
    currentRevision.repairCount = repairAttempt;
  }
  writeJson(join(project, '.expo-fast/result.json'), metrics);
  setRunState('completed', 'done', {
    result: previewFailure
      ? 'bundle-passed-preview-failed'
      : hap?.status === 'failed'
        ? 'bundle-passed-hap-failed'
        : metrics.preview?.status === 'partial'
          ? 'bundle-passed-preview-partial'
          : 'passed',
    hap,
    preview: metrics.preview,
  });
  console.log(JSON.stringify(metrics, null, 2));
  progress(metrics.status === 'partial'
    ? 'build completed with package or preview warnings'
    : 'end-to-end live test passed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    try {
      if (activeRunState?.action === 'follow-up' && activeMetrics && activeRevision?.status === 'running') {
        activeRevision.status = 'failed';
        activeRevision.completedAt = new Date().toISOString();
        activeRevision.durationMs = Math.max(0, Date.now() - Date.parse(activeRevision.startedAt));
        activeRevision.error = String(e.stack || e).slice(0, 4000);
        writeJson(activeResultPath, activeMetrics);
      }
      if (activeRunState?.action === 'follow-up') {
        setRunState('completed', 'follow_up_failed', { action: 'follow-up', result: 'failed' }, { error: e.stack || e });
      } else {
        setRunState('failed', 'error', {}, { error: e.stack || e });
      }
    }
    catch (stateError) { console.error(`could not write .expo-fast/state.json: ${stateError.stack || stateError}`); }
    console.error(e.stack || e); process.exitCode = 1;
  });
}
