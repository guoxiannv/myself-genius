#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { validateSmoke } from './validate-smoke.mjs';
import { assertCurrentMiniApp, inspectCurrentMiniApp } from './layout-identity.mjs';
import { auditImplementationTrace } from './trace-scope.mjs';
import { writeRunState } from './run-state.mjs';
import { canRunRepair, repairArtifactName } from './repair-policy.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const candidates = JSON.parse(readFileSync(join(root, 'config/candidates.json'), 'utf8')).candidates;
const helper = join(root, 'skills/expo-harmony-fast/scripts/fast-harmony.mjs');
const dependencies = join(root, 'scripts/dependencies.mjs');
const verifier = join(root, 'scripts/verify-product.mjs');
const sdk = resolve(process.env.EXPO_HARMONY_SDK_ROOT || join(root, '../devkit_sdk'));
const hdc = resolve(process.env.HDC || `${process.env.DEVECO_PATH || '/Applications/DevEco-Studio.app'}/Contents/sdk/default/openharmony/toolchains/hdc`);
const node22 = process.env.EXPO_FAST_NODE || process.execPath;
const claude = process.env.CLAUDE_BIN || 'claude';
const liveClaude = process.env.EXPO_FAST_LIVE_CLAUDE === '1';
let activeRunState = null;

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
function recoverTrace(project, metrics) {
  const path = join(project, '.expo-fast/agent-trace.jsonl');
  if (!existsSync(path)) return metrics;
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const sessionId = rows.find((row) => row.session_id)?.session_id;
  const result = [...rows].reverse().find((row) => row.type === 'result');
  if (!metrics.sessionId && sessionId) metrics.sessionId = sessionId;
  if (!metrics.stages.claudeMs && result?.duration_ms) metrics.stages.claudeMs = result.duration_ms;
  if (!metrics.traceUsage && result) metrics.traceUsage = { totalCostUsd: result.total_cost_usd, turns: result.num_turns, usage: result.usage, modelUsage: result.modelUsage };
  if (!metrics.modelRouting) {
    const traceModels = [...new Set(rows.filter((row) => row.type === 'assistant' && row.message?.model).map((row) => row.message.model))];
    metrics.modelRouting = { requested: metrics.selection?.model || '', traceModels, billedModels: Object.keys(result?.modelUsage || {}) };
  }
  return metrics;
}
function recoverRepairTrace(project, metrics, path = join(project, '.expo-fast/agent-repair-trace.jsonl')) {
  if (!existsSync(path)) return metrics;
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = [...rows].reverse().find((row) => row.type === 'result');
  if (result) {
    if (!metrics.stages.repairMs && result.duration_ms) metrics.stages.repairMs = result.duration_ms;
    const entry = { trace: basename(path), totalCostUsd: result.total_cost_usd, turns: result.num_turns, usage: result.usage, modelUsage: result.modelUsage };
    const entries = (metrics.repairTraceUsages ||= []);
    const index = entries.findIndex((item) => item.trace === entry.trace);
    if (index >= 0) entries[index] = entry; else entries.push(entry);
    metrics.repairTraceUsage = { totalCostUsd: entries.reduce((sum, item) => sum + (Number(item.totalCostUsd) || 0), 0), turns: entries.reduce((sum, item) => sum + (Number(item.turns) || 0), 0), attempts: entries };
  }
  return metrics;
}
function complexityScore(request) {
  let score = request.length;
  for (const pattern of [/四个 Tab|四个页面|four tabs/i, /导出|导入|迁移/, /周报|环比|历史周/, /连续|休息日|补记|逾期/, /SVG|图表|堆叠/, /删除|二次确认|确认/]) if (pattern.test(request)) score += 1200;
  return score;
}
function digestProductSource(project) {
  const paths = [join(project, 'App.tsx'), ...readdirSync(join(project, 'src'), { recursive: true }).map((entry) => join(project, 'src', String(entry))).filter((path) => existsSync(path) && statSync(path).isFile())].sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path.slice(project.length)).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
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
function buildPrompt(project, mode) {
  const request = readFileSync(join(project, '.expo-fast/request.md'), 'utf8').trim();
  const lines = mode === 'direct' ? 6 : 10;
  const extra = `\nBefore coding, preserve the required model-visible Spec → Plan → Code order: write .expo-fast/brief.json with at most ${lines} short lines total. Include a mini spec (product, primary flow, acceptance), a mini plan (data/state and file order), and a capabilities array containing every REQUIRED package/export plus only the optional AVAILABLE packages actually needed. When the request names multiple device classes, include the responsive device contract in acceptance. Add every REQUIRED and selected AVAILABLE package to package.json dependencies at its exact version. Production icons must be Path-only: encode circles, lines, rectangles, and dots as path commands because direct mixed SVG shape children render incompletely in this Harmony Go host. Charts may use other catalog-supported inline SVG primitives. Continue immediately to code; do not stop after the brief.`;
  return `Build this Expo React Native product from scratch in the current freshly prepared Harmony Go technical scaffold. No prior product implementation is present.\n\nUSER REQUEST:\n${request}\n\nRead only AGENTS.md, package.json, app.json, index.js, tsconfig.json, App.tsx, src/**, .expo-fast/model-capability-index.txt, and .expo-fast/sdk-fingerprint.json. These paths are permission-whitelisted and authoritative; do not attempt any other path, SDK scan, or web access. The model capability index is a deterministic projection of the local compatibility catalog: REQUIRED rows are request-matched AVAILABLE capabilities and must be represented in the brief, package dependencies, and working code; other AVAILABLE rows are optional; UNAVAILABLE rows must never be imported. ${extra}\n\nImplement the complete requested product now; do not collapse requested behavior into placeholders. Derive acceptance rules directly from the user request. Work in vertical slices, not a bottom-up library pass. Write .expo-fast/brief.json, then immediately replace starter App.tsx/app-shell, expose every requested destination, and implement a real primary state mutation. Keep the app runnable as you add data/persistence, complete screens, secondary actions, charts, and polish. Write each complete file as soon as it is ready; never leave entry composition or requested screens until the end.\n\nKeep the implementation compact: prefer 6-10 cohesive product files and avoid rewriting an already complete file unless integration requires it. Reuse the existing theme, local icon factory, and generic UI primitives; extend them only when a requested control truly needs it. Avoid commentary, long comments, duplicate wrappers, and one-file-per-small-component architecture. Treat useWindowDimensions().width as logical layout width; never infer breakpoints from physical pixels or emulator resolution. Use phone <640, tablet 640–1279, and desktop >=1280. For apps with multiple top-level destinations, phone uses bottom navigation and a single content column, tablet uses top horizontal navigation and one or two content columns as space allows, and desktop uses a fixed-width left sidebar plus a flexible main area as siblings inside the same horizontal root container. Never place the desktop sidebar before or outside that row container. Desktop dashboard/list cards must form a real multi-column layout, such as wrapping cards with about 48% basis. Do not invent tabs for a single-destination app; still preserve the same responsive content rules. Add stable literal testID and accessibilityLabel values to tabs, primary actions, and state summaries that change after actions.\n\nUse src/components/icons.tsx as the local Lucide-style icon system with one consistent 2.2 default stroke width. Every production icon and chart must use inline react-native-svg primitives; never use emoji, text glyphs, Unicode symbols, or an external icon library. Resolve native product behavior through the capability index instead of replacing it with text-only UI. For bulk non-sensitive local app state, use REQUIRED AsyncStorage; hydrate before writes, seed only when storage is empty, namespace storage keys with the app slug from app.json, and persist every mutation. Treat dates as local calendar dates and keep domain units separate when aggregating. Validate imported data before any destructive overwrite. Requested direct actions must perform their named system result in that action, and requested animations must actually animate.\n\nUse no package unless it has a REQUIRED or AVAILABLE row in the capability index and declare it in package.json dependencies at that exact version. Preserve all scaffold dependencies and every other package.json field. Do not create prose Spec/Plan, HTML, ArkTS, native files, tests, docs, or subagents. Do not edit other infrastructure. Do not run any shell command, install, Expo, lint, test, typecheck, grep, or build; the orchestrator owns dependency synchronization and verification. After the whole app is connected, spend the remaining pass on missing user-visible behavior, then stop. Do not narrate progress, check formatting, reread the whole project, or perform a late architectural rewrite.`;
}

function verifyImplementation(project, catalogRoot, metrics, suffix = '') {
  const stage = (name) => `${name}${suffix}`;
  const diagnostics = [];
  const check = (name, cmd, args, log) => {
    const started = Date.now();
    try { metrics.stages[stage(name)] = run(cmd, args, { cwd: project, log }).ms; }
    catch (error) {
      metrics.stages[stage(name)] = Date.now() - started;
      diagnostics.push(`${name}:\n${error.stack || error}`);
    }
  };
  check('dependencySyncMs', node22, [dependencies, 'sync', project], join(project, '.expo-fast/capability-resolution.log'));
  if (existsSync(join(project, '.expo-fast/capability-selection.json'))) metrics.capabilities = JSON.parse(readFileSync(join(project, '.expo-fast/capability-selection.json'), 'utf8'));
  check('typecheckMs', node22, [join(project, 'node_modules/typescript/bin/tsc'), '--noEmit'], join(project, '.expo-fast/typecheck.log'));
  check('sourceAuditMs', node22, [verifier, 'audit', project], join(project, '.expo-fast/source-audit-command.log'));
  if (diagnostics.length) throw new Error(`Deterministic product diagnostics failed (${diagnostics.length}):\n\n${diagnostics.join('\n\n')}`);
  metrics.stages[stage('exportMs')] = run(node22, [dependencies, 'export', project, catalogRoot], { cwd: project }).ms;
  metrics.stages[stage('artifactAuditMs')] = run(node22, [verifier, 'artifacts', project, catalogRoot], { cwd: project, log: join(project, '.expo-fast/artifact-audit-command.log') }).ms;
}
async function claudeTurn(project, mode, trace, prompt, sessionId, resume = false, timeoutMinutes = 0, acceptDeadline = false, effort = candidates[mode].effort, model = candidates[mode].model) {
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
  ].join(',');
  const emptyMcpConfig = JSON.stringify({ mcpServers: {} });
  const args = ['-p', '--permission-mode', 'dontAsk', '--model', model, '--effort', effort, '--mcp-config', emptyMcpConfig, '--strict-mcp-config', '--tools', 'Read,Write,Edit', '--allowedTools', allowedTools, '--output-format', 'stream-json', '--verbose', ...sessionArgs, prompt];
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
function mime(path) { return ({ '.json': 'application/json', '.js': 'application/javascript', '.map': 'application/json', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg' })[extname(path)] || 'application/octet-stream'; }
async function serve(folder, port) { const server = createServer((req, res) => { const rel = decodeURIComponent((req.url || '/').split('?')[0] === '/' ? '/catalog.json' : req.url.split('?')[0]); const path = resolve(folder, `.${rel}`); if (!path.startsWith(resolve(folder)) || !existsSync(path) || !statSync(path).isFile()) { res.statusCode = 404; res.end('not found'); return; } res.setHeader('Content-Type', mime(path)); createReadStream(path).pipe(res); }); await new Promise((ok, fail) => { const onError = (error) => fail(error); server.once('error', onError); server.listen(port, '127.0.0.1', () => { server.off('error', onError); ok(); }); }); return server; }
function hdcRun(args) { const r = spawnSync(hdc, args, { encoding: 'utf8' }); if (r.status !== 0 || /\[Fail\]/i.test(`${r.stdout}\n${r.stderr}`)) throw new Error(`hdc ${args.join(' ')} failed\n${r.stdout}${r.stderr}`); return r.stdout || ''; }
function clearReverse(target) { const list = spawnSync(hdc, ['-t', target, 'fport', 'ls'], { encoding: 'utf8' }).stdout || ''; for (const line of list.split(/\r?\n/)) { const match = line.match(/tcp:(\d+)\s+tcp:(\d+)\s+\[Reverse\]/); if (match && match[1] === '3333') spawnSync(hdc, ['-t', target, 'fport', 'rm', `tcp:${match[1]}`, `tcp:${match[2]}`], { encoding: 'utf8' }); } }
function copyEvidence(project, catalogRoot) { const catalog = JSON.parse(readFileSync(join(catalogRoot, 'catalog.json'), 'utf8')); const manifest = resolve(catalogRoot, catalog[0].manifestUrl.replace(/^\//, '')); for (const [src, name] of [[join(catalogRoot, 'runtime.json'), 'runtime.json'], [manifest, 'manifest.json']]) writeFileSync(join(project, '.expo-fast', name), readFileSync(src)); }
async function launch(project, catalogRoot, port) { const targets = hdcRun(['list', 'targets']).trim().split(/\s+/).filter(Boolean); if (!targets.length) throw new Error('no Harmony target'); const target = targets[0]; const server = await serve(catalogRoot, port); try { clearReverse(target); hdcRun(['-t', target, 'rport', 'tcp:3333', `tcp:${port}`]); hdcRun(['-t', target, 'shell', 'aa', 'force-stop', 'host.exp.exponent.harmony']); hdcRun(['-t', target, 'shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'host.exp.exponent.harmony']); return { target, server }; } catch (e) { server.close(); throw e; } }
function nodeText(node) { const a = node.attributes || {}; return a.text || a.originalText || a.description || ''; }
function children(node) { return node.children || []; }
function subtreeHas(node, text) { return nodeText(node) === text || children(node).some((child) => subtreeHas(child, text)); }
function collect(node, predicate, out = []) { if (predicate(node)) out.push(node); for (const child of children(node)) collect(child, predicate, out); return out; }
function boundsCenter(node) { const value = node.attributes?.bounds || ''; const match = value.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); if (!match) throw new Error(`node has invalid bounds: ${value}`); return [Math.round((Number(match[1]) + Number(match[3])) / 2), Math.round((Number(match[2]) + Number(match[4])) / 2)]; }
function relatedButton(layout, identity, labels) {
  const candidates = collect(layout, (node) => subtreeHas(node, identity) && collect(node, (child) => child.attributes?.type === 'Button' && labels.includes(nodeText(child))).length > 0);
  candidates.sort((a, b) => JSON.stringify(a).length - JSON.stringify(b).length);
  return candidates.length ? collect(candidates[0], (node) => node.attributes?.type === 'Button' && labels.includes(nodeText(node)))[0] : null;
}
function dumpLayout(project, target, name) { const device = `/data/local/tmp/expo-fast-${process.pid}-${name}.json`; const local = join(project, '.expo-fast', `${name}.json`); hdcRun(['-t', target, 'shell', 'uitest', 'dumpLayout', '-p', device]); hdcRun(['-t', target, 'file', 'recv', device, local]); return JSON.parse(readFileSync(local, 'utf8')); }
function tapNode(target, node) { const [x, y] = boundsCenter(node); hdcRun(['-t', target, 'shell', 'uitest', 'uiInput', 'click', String(x), String(y)]); return { x, y, bounds: node.attributes.bounds, text: nodeText(node) }; }
async function installAndOpen(project, target, manifestId) {
  const source = [join(project, 'App.tsx'), ...readdirSync(join(project, 'src'), { recursive: true }).filter((entry) => /\.[jt]sx?$/.test(String(entry))).map((entry) => join(project, 'src', String(entry)))].filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8')).join('\n');
  const testIds = [...source.matchAll(/testID=["']([^"']+)["']/g)].map((match) => match[1]);
  const sharedTemplateIds = new Set(['app-shell', 'responsive-navigation', 'primary-action', 'item-count']);
  const productMarkers = testIds.filter((id) => !sharedTemplateIds.has(id) && !/^tab-(?:home|activity|settings)$/.test(id));
  if (!productMarkers.length) throw new Error(`current source has no run-specific literal testID for exact-app identity: ${manifestId}`);
  let layout = dumpLayout(project, target, 'launch-catalog');
  const actions = [];
  const projectsTab = collect(layout, (node) => node.attributes?.type === 'Button' && nodeText(node) === '项目')[0];
  if (projectsTab) {
    actions.push({ action: 'catalog', ...tapNode(target, projectsTab) });
    await new Promise((r) => setTimeout(r, 1500));
    layout = dumpLayout(project, target, 'launch-catalog');
  }
  const remove = relatedButton(layout, manifestId, ['移除']);
  if (remove) {
    actions.push({ action: 'remove-stale-bundle', ...tapNode(target, remove) });
    await new Promise((r) => setTimeout(r, 2000));
    layout = dumpLayout(project, target, 'launch-catalog');
  }
  let install = relatedButton(layout, manifestId, ['安装']);
  if (!install) {
    const refresh = collect(layout, (node) => node.attributes?.type === 'Button' && nodeText(node) === '刷新')[0];
    if (refresh) { tapNode(target, refresh); await new Promise((r) => setTimeout(r, 1500)); layout = dumpLayout(project, target, 'launch-catalog'); install = relatedButton(layout, manifestId, ['安装']); }
  }
  if (install) { actions.push({ action: 'install', ...tapNode(target, install) }); await new Promise((r) => setTimeout(r, 3000)); layout = dumpLayout(project, target, 'launch-installed'); }
  const alreadyProduct = inspectCurrentMiniApp(layout, manifestId, productMarkers).ok;
  if (!alreadyProduct) {
    const identityButton = collect(layout, (node) => node.attributes?.type === 'Button' && nodeText(node) === manifestId)[0];
    const open = identityButton || relatedButton(layout, manifestId, ['打开']);
    if (!open) throw new Error(`could not locate installed mini app ${manifestId}`);
    actions.push({ action: 'open', ...tapNode(target, open) }); await new Promise((r) => setTimeout(r, 3000));
  }
  const product = dumpLayout(project, target, 'launch-product');
  const shotDevice = `/data/local/tmp/expo-fast-${process.pid}-launch.jpeg`; const shotLocal = join(project, '.expo-fast/launch-screenshot.jpeg'); hdcRun(['-t', target, 'shell', 'uitest', 'screenCap', '-p', shotDevice]); hdcRun(['-t', target, 'file', 'recv', shotDevice, shotLocal]);
  const identity = assertCurrentMiniApp(product, manifestId, productMarkers, 'launch-product');
  return { result: 'PASS', target, bundleName: 'host.exp.exponent.harmony', manifestId, currentProjectTitle: identity.currentProjectTitle, currentProjectBounds: identity.currentProjectBounds, appNode: identity.productMarker, appNodeBounds: identity.productMarkerBounds, actions };
}
function promptSmoke(project) { const manifest = JSON.parse(readFileSync(join(project, '.expo-fast/manifest.json'), 'utf8')); return `The current run's exact Harmony Go mini app identity is id=${manifest.id}, name=${manifest.name}. The app has exported and the Harmony Go shell is foreground. Use HDC only. First inspect layout and locate the catalog card whose visible id/name equals that exact identity; install it if needed and open that exact card. Do not open any other cached mini app. Dump layout again and require root bundleName=host.exp.exponent.harmony, the Host header current-project title exactly equal to this mini-app id, and a run-specific literal testID from current source inside product content before treating the product as open. A project-list button containing the id is not identity proof.

Exercise one CORE product flow that mutates product data or time. Navigation by itself is forbidden. Valid categories are form-submit, timer-progress, list-mutation, toggle, or value-edit. For a form, capture the summary before, navigate to the form, enter a value, save, and capture the updated summary after. For a timer, capture the clock before, start it, wait, and capture the changed clock/button after. Use accessibility layout bounds for every action. Before and after the complete flow, re-assert bundleName and the visible current mini-app id. Never press Back and never open another app.

After the mutation, force-stop Harmony Go, reopen this exact installed mini app, and dump the restarted layout. Require the same current-project title, the same product testID, and the exact post-mutation value after restart.

Save only final valid evidence under .expo-fast/smoke: layout-before.json, layout-after.json, layout-restarted.json, action.json, and screenshot.jpeg. action.json must use this exact shape: {"result":"PASS|FAIL","manifestId":"${manifest.id}","identityNode":{"before":"${manifest.id}","after":"${manifest.id}","restarted":"${manifest.id}"},"action":{"category":"form-submit|timer-progress|list-mutation|toggle|value-edit","steps":["..."]},"assertion":{"target":"stable literal testID","before":"exact value present in layout-before","after":"different exact value present in layout-after","restarted":"same exact value as after"}}. A tab/screen change is FAIL. Do not edit source unless this exact mini app shows a visible app error.`; }
async function main() {
  const o = parse(process.argv.slice(2)); const project = resolve(o.project); const request = resolve(o.request || join(project, '.expo-fast/request.md')); const requestText = readFileSync(request, 'utf8'); const requestedMode = o.candidate || 'auto'; const mode = requestedMode === 'auto' ? (complexityScore(requestText) >= 4000 ? 'repair' : 'brief') : requestedMode; if (!candidates[mode]) throw new Error(`unknown candidate ${mode}`); const invocationStartedAt = new Date();
  const model = o.model || candidates[mode].model;
  const effort = o.effort || candidates[mode].effort;
  const repairModel = o.repairModel || o.model || candidates[mode].repairModel || model;
  const repairEffort = o.repairEffort || o.effort || candidates[mode].repairEffort || effort;
  activeRunState = { project, runId: randomUUID(), startedAt: invocationStartedAt.toISOString(), state: 'generating_code' };
  const stateContext = { requestedMode, candidate: mode, model, effort, repairModel, repairEffort, resume: o.resume === 'true' };
  if (!['low', 'medium', 'high', 'max'].includes(effort) || !['low', 'medium', 'high', 'max'].includes(repairEffort)) throw new Error(`unknown effort main=${effort} repair=${repairEffort}`);
  progress(`start · candidate=${mode} · model=${model} · effort=${effort} · repair=${repairModel}/${repairEffort} · project=${project}`);
  if (o.baseProject || o['base-project']) throw new Error('Cold-start experiment integrity forbids --baseProject/--base-project. Use a new empty project directory.');
  const resume = o.resume === 'true';
  const oldResultPath = join(project, '.expo-fast/result.json');
  const metrics = resume && existsSync(oldResultPath)
    ? JSON.parse(readFileSync(oldResultPath, 'utf8'))
    : { candidate: mode, selection: { requested: requestedMode, complexityScore: complexityScore(requestText), model, effort, repairModel, repairEffort }, project, request, startedAt: invocationStartedAt.toISOString(), stages: {} };
  metrics.stages ||= {};
  if (resume) { setRunState('generating_code', 'verification', stateContext, { reset: true }); recoverTrace(project, metrics); recoverRepairTrace(project, metrics); }
  let sessionId = metrics.sessionId;
  if (!resume) {
    progress('prepare cold-start template and capability index');
    run(node22, [helper, 'prepare', project, request]); setRunState('generating_code', 'preparing', stateContext, { reset: true }); writeFileSync(join(project, 'AGENTS.md'), readFileSync(join(root, 'AGENTS.md'))); writeFileSync(join(project, 'CLAUDE.md'), '@AGENTS.md\n');
    const modelCapabilityIndex = writeModelCapabilityIndex(project, requestText);
    const experiment = { schemaVersion: 1, protocol: 'cold-start-v1', coldStart: true, sourceInheritance: false, requestSha256: sha256(requestText), templateAssetSha256: digestProductSource(join(root, 'skills/expo-harmony-fast/assets/expo-harmony-template')), templateProductSha256: digestProductSource(project), capabilityCatalogSha256: modelCapabilityIndex.sourceSha256, modelCapabilityIndexSha256: modelCapabilityIndex.sha256, modelCapabilityIndexBytes: modelCapabilityIndex.bytes, requiredCapabilities: modelCapabilityIndex.requiredPackages, preparedAt: new Date().toISOString() };
    writeJson(join(project, '.expo-fast/experiment.json'), experiment);
    metrics.experiment = experiment;
    metrics.stages.seedModulesMs = run(node22, [dependencies, 'seed', project]).ms;
    progress(`dependencies prepared · ${metrics.stages.seedModulesMs}ms`);
    sessionId = randomUUID(); metrics.sessionId = sessionId;
    setRunState('generating_code', 'model_generation', { sessionId });
    progress(`implementation turn · session=${sessionId} · model=${model} · effort=${effort}`);
    const implementationTurn = await claudeTurn(project, mode, join(project, '.expo-fast/agent-trace.jsonl'), buildPrompt(project, mode), sessionId, false, Number(o.claudeTimeoutMinutes || 0), o.acceptClaudeDeadline === 'true', effort, model);
    metrics.stages.claudeMs = implementationTurn.ms; metrics.claudeDeadlineReached = implementationTurn.deadlineReached;
    progress(`implementation turn finished · ${metrics.stages.claudeMs}ms`);
    recoverTrace(project, metrics);
  }
  const implementationTrace = join(project, '.expo-fast/agent-trace.jsonl');
  if (existsSync(implementationTrace)) {
    metrics.traceScope = advisoryTraceScope(auditImplementationTrace(project, implementationTrace), 'implementation', '.expo-fast/trace-scope-audit.json');
    writeJson(join(project, '.expo-fast/trace-scope-audit.json'), metrics.traceScope);
  }
  const catalogRoot = join(project, 'dist/harmony-go');
  const repairPolicy = candidates[mode].repairTurns;
  let repairAttempt = 0;
  let verificationSuffix = '';
  for (;;) {
    const isRepairVerification = repairAttempt > 0;
    setRunState(isRepairVerification ? 'repairing' : activeRunState.state, isRepairVerification ? 'repair_verification' : 'verification', { repairAttempt });
    progress(isRepairVerification ? `deterministic repair verification · attempt=${repairAttempt}` : 'deterministic dependency/typecheck/source/export gates');
    try {
      verifyImplementation(project, catalogRoot, metrics, verificationSuffix);
      progress(isRepairVerification ? `repair gates passed · attempts=${repairAttempt}` : 'deterministic gates passed');
      break;
    } catch (error) {
      writeFileSync(join(project, '.expo-fast/verification-errors.txt'), `${error.stack || error}\n`);
      if (!canRunRepair(repairPolicy, repairAttempt)) throw error;
      repairAttempt += 1;
      setRunState('repairing', 'model_repair', { repairAttempt, repairPolicy });
      progress(`deterministic gates failed; starting same-session repair ${repairAttempt}/${repairPolicy} · model=${repairModel} · effort=${repairEffort}`);
      const traceName = repairArtifactName('agent-repair-trace', repairAttempt, '.jsonl');
      const auditName = repairArtifactName('repair-trace-scope-audit', repairAttempt, '.json');
      const repairTrace = join(project, '.expo-fast', traceName);
      const attemptMetrics = { attempt: repairAttempt, model: repairModel, effort: repairEffort, trace: `.expo-fast/${traceName}`, startedAt: new Date().toISOString(), status: 'running' };
      (metrics.repairAttempts ||= []).push(attemptMetrics);
      try {
        const repairTurn = await claudeTurn(project, mode, repairTrace, `Deterministic verification failed on repair cycle ${repairAttempt}. Read only .expo-fast/verification-errors.txt and the whitelisted current product source or deterministic diagnostic files needed to understand it. Fix only reported product problems in App.tsx/src/**, .expo-fast/brief.json, or package.json dependencies. Any dependency must use its exact catalog.available version; preserve all scaffold dependencies and other package.json fields. Do not attempt any other path or run commands; stop after the narrow repair.`, sessionId, true, Number(o.repairTimeoutMinutes ?? 0), false, repairEffort, repairModel);
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
      const traceScope = advisoryTraceScope(auditImplementationTrace(project, repairTrace), `repair ${repairAttempt}`, `.expo-fast/${auditName}`);
      attemptMetrics.traceScope = traceScope;
      (metrics.repairTraceScopes ||= []).push({ attempt: repairAttempt, trace: `.expo-fast/${traceName}`, ...traceScope });
      if (repairAttempt === 1) metrics.repairTraceScope = traceScope;
      writeJson(join(project, '.expo-fast', auditName), traceScope);
      verificationSuffix = repairAttempt === 1 ? 'Retry' : `Retry${repairAttempt}`;
    }
  }
  if (resume && !metrics.generationMs && metrics.stages.claudeMs) {
    metrics.generationMs = Object.entries(metrics.stages).filter(([name]) => /^(?:seedModules|claude|repair|dependencySync|typecheck|sourceAudit|export|artifactAudit).*Ms$/.test(name)).reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
    metrics.totalMs = metrics.generationMs;
  }
  if (!resume) {
    metrics.generationCompletedAt = new Date().toISOString();
    metrics.generationMs = Date.now() - invocationStartedAt.getTime();
    metrics.totalMs = metrics.generationMs;
  }
  if (o.launch !== 'false') {
    setRunState(activeRunState.state, 'launching');
    progress('launch Harmony Go and verify exact app identity');
    const port = Number(o.port || 3340); const live = await launch(project, catalogRoot, port);
    try {
      await new Promise((r) => setTimeout(r, 5000));
      const manifest = JSON.parse(readFileSync(join(project, '.expo-fast/manifest.json'), 'utf8'));
      metrics.launch = { ...(await installAndOpen(project, live.target, manifest.id)), port };
      progress(`Harmony Go launch passed · manifest=${manifest.id}`);
      // Model-driven UI QA is deliberately opt-in: experiments showed that a
      // second Claude turn can cost longer than the whole implementation. The
      // default path launches deterministically and leaves optional core-flow
      // evidence to HDC or an explicit smoke-agent run.
      if (o.smokeAgent === 'true') {
        const smokeTurn = await claudeTurn(project, mode, join(project, `.expo-fast/smoke-agent-trace${resume ? '-resume' : ''}.jsonl`), promptSmoke(project), randomUUID());
        metrics.stages.smokeClaudeMs = smokeTurn.ms;
        metrics.smoke = validateSmoke(project);
      }
    } finally { live.server.close(); clearReverse(live.target); }
  }
  if (o.validateSmoke === 'true') metrics.smoke = validateSmoke(project);
  const completedAt = new Date().toISOString();
  if (resume) (metrics.resumes ||= []).push({ startedAt: invocationStartedAt.toISOString(), completedAt, ms: Date.now() - invocationStartedAt.getTime(), purpose: o.launch === 'false' ? 'reverify' : 'core-smoke' });
  metrics.completedAt = completedAt; metrics.status = 'passed'; writeJson(join(project, '.expo-fast/result.json'), metrics); setRunState('completed', 'done', { result: 'passed' }); console.log(JSON.stringify(metrics, null, 2));
  progress('end-to-end live test passed');
}
main().catch((e) => {
  try { setRunState('failed', 'error', {}, { error: e.stack || e }); }
  catch (stateError) { console.error(`could not write .expo-fast/state.json: ${stateError.stack || stateError}`); }
  console.error(e.stack || e); process.exitCode = 1;
});
