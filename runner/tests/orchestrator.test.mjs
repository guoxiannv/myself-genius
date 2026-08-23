import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateSmoke } from '../scripts/validate-smoke.mjs';
import {
  buildIdentityNodeId,
  catalogFingerprint,
  catalogHasProject,
  catalogProjectCard,
  catalogVisibleProjectIds,
  harmonyGoActiveMiniAppNodeId,
  harmonyGoCatalogMiniAppNodeId,
  hasBuildIdentity,
  inspectCurrentMiniApp,
  observedBuildStamps,
  visibleBundleNames,
} from '../scripts/layout-identity.mjs';
import { HDC_DEVICE_TIMEOUT_MS, HDC_SESSION_TIMEOUT_MS, HDC_TRANSFER_TIMEOUT_MS, assignHdcPreviewPorts, configuredHdcPreviewTargets, configuredHdcTarget, discoverHdcPreviewPools, hdcCommandKind, hdcCommandTarget, hdcCommandTimeoutMs, hdcForceStopBundleAbsent, hdcOutputFailed, hdcTimeoutMessage, hdcUninstallBundleAbsent, parseHdcForwardRules, parseHdcTargets, prioritizeHdcPreviewTargets, reversePortCandidates, selectHdcPreviewTargets, selectHdcTarget } from '../scripts/hdc-target.mjs';
import { auditImplementationTrace } from '../scripts/trace-scope.mjs';
import { auditProductSource, verifyHarmonyGoArtifacts } from '../scripts/verify-product.mjs';
import { writeRunState } from '../scripts/run-state.mjs';
import {
  executionConfig,
  resolveExecution,
  resolveRole,
  roleEnv,
  roleNames,
  roleOwnedEnvironmentKeys,
  validateExecutionConfig,
} from '../scripts/execution-policy.mjs';
import { readModelCache, verifyConfiguredModels } from '../scripts/preflight-models.mjs';
import { probeContextWindow, probeEfforts, probeThinking, windowLadder } from '../scripts/model-probes.mjs';
import { windowFromApiError, windowFromRejection } from '../scripts/endpoint-limits.mjs';
import { parseArguments as parseTimingArguments } from '../scripts/probe-turn-timing.mjs';
import { repairArtifactName } from '../scripts/repair-artifact.mjs';
import { assertDependencyRuntime, installProjectDependencies, pinRuntimeDependencies, stageHarmonyCli } from '../scripts/dependencies.mjs';
import { BUILD_IDENTITY_FILE, HAP_DEVICE_TYPES, buildIdentityModule, buildStampFromJobId, runHapPoolBuild } from '../scripts/hap-build.mjs';
import {
  designTurnInvocation,
  flushClaudeTraceChunk,
  launchHapPreview,
  normalizeClaudeTraceChunk,
} from '../scripts/run-livetest.mjs';
import { acquirePreviewDevice, acquirePreviewDevices, configuredPreviewPools } from '../scripts/preview-device-pool.mjs';
import { bundleNameFromModuleJson, DEFAULT_HARMONY_GO_BUNDLE_NAME, resolveHarmonyGoBundleName } from '../scripts/harmony-go-runtime.mjs';
import {
  APP_ICON_SIZE,
  APP_SPLASH_ICON_SIZE,
  composeIconSvg,
  generateAppIconAfterBrief,
  installGeneratedIcon,
  selectIconContext,
  validateIconSvg,
} from '../scripts/app-icon.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const script = join(root, 'scripts/fast-harmony.mjs');
const dependencyController = join(root, 'scripts/dependencies.mjs');

test('Claude trace rows receive timestamps without breaking chunked JSONL', () => {
  const state = { pending: '' };
  let tick = 0;
  const now = () => `2026-08-22T10:14:0${++tick}.000Z`;
  const first = JSON.stringify({ type: 'assistant', message: { content: [] } });
  const second = JSON.stringify({ type: 'result', timestamp: '2026-08-22T10:15:00.000Z' });

  assert.deepEqual(normalizeClaudeTraceChunk(first.slice(0, 12), state, { now }), []);
  const records = normalizeClaudeTraceChunk(
    `${first.slice(12)}\nnot-json\n${second}\n`,
    state,
    { now },
  );

  assert.equal(records[0].row.timestamp, '2026-08-22T10:14:01.000Z');
  assert.equal(records[1].raw, 'not-json');
  assert.equal(records[2].row.timestamp, '2026-08-22T10:15:00.000Z');

  normalizeClaudeTraceChunk('{"type":"assistant"}', state, { now });
  const flushed = flushClaudeTraceChunk(state, { now });
  assert.equal(flushed[0].row.timestamp, '2026-08-22T10:14:02.000Z');
});

const iconBackgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="bg_gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF9A62"/><stop offset="1" stop-color="#F04462"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#bg_gradient)"/></svg>`;
const iconForegroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="250" fill="#FFFFFF"/><path d="M512 315V512L650 590" fill="none" stroke="#F04462" stroke-width="72" stroke-linecap="round"/></svg>`;

function writeFakeIconPng(path, size = APP_ICON_SIZE) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(size, 16);
  data.writeUInt32BE(size, 20);
  data[24] = 8;
  data[25] = 6;
  writeFileSync(path, data);
  return { rasterizer: 'test', width: size, height: size, bytes: data.length };
}

test('app icon context prefers product semantics from flexible brief shapes', () => {
  const structured = selectIconContext({
    spec: { product: '番茄钟', primaryFlow: '专注后休息', acceptance: '记录完成次数' },
    plan: { files: ['ignored.ts'] },
    capabilities: ['ignored-package'],
  }, 'raw prompt');
  assert.equal(structured.source, 'brief');
  assert.match(structured.text, /Product: 番茄钟/);
  assert.match(structured.text, /Primary flow: 专注后休息/);
  assert.doesNotMatch(structured.text, /ignored/);

  const compact = selectIconContext({ spec: '单页简单计时器', acceptance: '可暂停和重置' });
  assert.equal(compact.source, 'brief');
  assert.match(compact.text, /单页简单计时器/);
  assert.equal(selectIconContext({}, '相册日记').source, 'request-fallback');
});

test('app icon SVG contract requires opaque background and safe local vector content', () => {
  assert.equal(validateIconSvg(iconBackgroundSvg, { background: true }), iconBackgroundSvg);
  assert.equal(validateIconSvg(iconForegroundSvg), iconForegroundSvg);
  const composite = composeIconSvg(iconBackgroundSvg, iconForegroundSvg);
  assert.match(composite, /composite_bg_bg_gradient/);
  assert.match(composite, /url\(#composite_bg_bg_gradient\)/);
  assert.throws(
    () => validateIconSvg('<svg viewBox="0 0 1024 1024"><text>Timer</text></svg>'),
    /element is not allowed/
  );
  assert.throws(
    () => validateIconSvg('<svg viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="none"/></svg>', { background: true }),
    /opaque full-canvas/
  );
  assert.throws(
    () => validateIconSvg('<svg viewBox="0 0 1024 1024"><image href="https:\/\/example.com\/x.png"/></svg>'),
    /unsupported document, link, or CSS/
  );
});

test('generated icon assets declare app, splash, and SDK-owned Harmony icons after all PNGs validate', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-app-icon-install-'));
  writeFileSync(join(project, 'app.json'), `${JSON.stringify({
    expo: {
      name: 'Timer',
      slug: 'timer',
      splash: { backgroundColor: '#FFF7ED' },
    },
  })}\n`);
  const installed = installGeneratedIcon(project, {
    backgroundSvg: iconBackgroundSvg,
    foregroundSvg: iconForegroundSvg,
  }, {
    rasterize(_svgPath, pngPath, { size = APP_ICON_SIZE } = {}) {
      return writeFakeIconPng(pngPath, size);
    },
  });
  const app = JSON.parse(readFileSync(join(project, 'app.json'), 'utf8'));
  assert.equal(app.expo.icon, './assets/app-icon/icon.png');
  assert.deepEqual(app.expo.splash, {
    backgroundColor: '#FFF7ED',
    image: './assets/app-icon/splash-icon.png',
  });
  assert.deepEqual(app.expo.harmony.icon, {
    foregroundImage: './assets/app-icon/foreground.png',
    backgroundImage: './assets/app-icon/background.png',
  });
  assert.equal(installed.assets.background, 'assets/app-icon/background.png');
  assert.equal(installed.assets.splash, 'assets/app-icon/splash-icon.png');
  assert.equal(installed.renders.splash.width, APP_SPLASH_ICON_SIZE);
  assert.equal(installed.renders.splash.height, APP_SPLASH_ICON_SIZE);
  assert.equal(existsSync(join(project, 'plugins/with-generated-app-icon.cjs')), false);
});

test('generated app icons preserve an explicitly configured splash image', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-app-icon-custom-splash-'));
  writeFileSync(join(project, 'app.json'), `${JSON.stringify({
    expo: {
      name: 'Timer',
      slug: 'timer',
      splash: { image: './assets/custom-splash.png', backgroundColor: '#111827' },
    },
  })}\n`);
  installGeneratedIcon(project, {
    backgroundSvg: iconBackgroundSvg,
    foregroundSvg: iconForegroundSvg,
  }, {
    rasterize(_svgPath, pngPath, { size = APP_ICON_SIZE } = {}) {
      return writeFakeIconPng(pngPath, size);
    },
  });
  const app = JSON.parse(readFileSync(join(project, 'app.json'), 'utf8'));
  assert.deepEqual(app.expo.splash, {
    image: './assets/custom-splash.png',
    backgroundColor: '#111827',
  });
});

test('independent icon task waits for brief and records ready or fallback evidence', async () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-app-icon-task-'));
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  let receivedContext = '';
  const readyPromise = generateAppIconAfterBrief({
    project,
    request: 'raw request',
    model: 'test-model',
    briefTimeoutSeconds: 2,
    modelRunner: async ({ context }) => {
      receivedContext = context;
      return {
        output: {
          backgroundSvg: iconBackgroundSvg,
          foregroundSvg: iconForegroundSvg,
          palette: ['#FF9A62', '#F04462'],
          rationale: 'A focused timer dial.',
        },
        stdout: '{}',
        stderr: '',
      };
    },
    installer: () => ({ assets: { composite: 'assets/app-icon/icon.png' } }),
  });
  setTimeout(() => {
    writeFileSync(join(project, '.expo-fast/brief.json'), `${JSON.stringify({
      spec: { product: '番茄钟', primaryFlow: '专注与休息循环' },
      capabilities: ['must-not-leak'],
    })}\n`);
  }, 25);
  const ready = await readyPromise;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.source, 'brief');
  assert.match(receivedContext, /番茄钟/);
  assert.doesNotMatch(receivedContext, /must-not-leak/);

  const failedProject = mkdtempSync(join(tmpdir(), 'expo-fast-app-icon-fallback-'));
  mkdirSync(join(failedProject, '.expo-fast'), { recursive: true });
  writeFileSync(join(failedProject, '.expo-fast/brief.json'), '{"spec":"计时器"}\n');
  const fallback = await generateAppIconAfterBrief({
    project: failedProject,
    request: 'raw request',
    model: 'test-model',
    modelRunner: async () => { throw new Error('model unavailable'); },
  });
  assert.equal(fallback.status, 'fallback');
  assert.match(fallback.reason, /model unavailable/);
  assert.equal(
    JSON.parse(readFileSync(join(failedProject, '.expo-fast/app-icon/result.json'), 'utf8')).status,
    'fallback'
  );
});

test('Harmony Go export waits for the independent icon declaration without serializing model work', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const iconState = runner.indexOf("setRunState('generating_code', 'app_icon_generation'");
  const wait = runner.indexOf('metrics.appIcon = await appIconTask');
  const exportGate = runner.indexOf("const catalogRoot = join(project, 'dist/harmony-go')");
  assert.ok(wait > runner.indexOf('await claudeTurn('));
  assert.ok(iconState > runner.indexOf('await claudeTurn('));
  assert.ok(iconState < wait);
  assert.ok(exportGate > wait);
});

test('Harmony Go bundle identity prefers explicit configuration, then HAP metadata, then the SDK default', () => {
  const moduleJson = JSON.stringify({ app: { bundleName: 'com.example.from.hap' } });
  assert.equal(bundleNameFromModuleJson(moduleJson), 'com.example.from.hap');
  assert.equal(resolveHarmonyGoBundleName({
    env: { EXPO_HARMONY_GO_BUNDLE_NAME: 'com.example.explicit' },
    hapPath: '',
  }), 'com.example.explicit');
  assert.equal(resolveHarmonyGoBundleName({ env: {}, hapPath: '' }), DEFAULT_HARMONY_GO_BUNDLE_NAME);
  assert.throws(() => bundleNameFromModuleJson('{}'), /has no app\.bundleName/);
});

test('runtime resources are standalone orchestrator assets without a retired skill package', () => {
  assert.equal(existsSync(join(root, 'skills/expo-harmony-fast')), false);
  assert.equal(existsSync(join(root, 'scripts/catalog.mjs')), false);
  for (const path of [
    script,
    join(root, 'templates/expo-harmony/package.json'),
    join(root, 'docs/runtime-contract.md'),
  ]) assert.equal(existsSync(path), true, path);
});

test('dependency lifecycle commands have one controller', () => {
  const helper = readFileSync(script, 'utf8');
  const dependencies = readFileSync(dependencyController, 'utf8');
  for (const command of ['seed-modules', 'sync-dependencies', 'export-go', 'install']) {
    assert.doesNotMatch(helper, new RegExp(`command === '${command}'`));
  }
  for (const command of ['check', 'seed', 'sync', 'export']) {
    assert.match(dependencies, new RegExp(`command === '${command}'`));
  }
});

test('dependency runtime preflight verifies Node and npm together', () => {
  const runtime = assertDependencyRuntime();
  assert.match(runtime.node, /^v\d+\.\d+\.\d+/);
  assert.ok(runtime.nodePath);
  assert.match(runtime.npm, /^\d+\.\d+\.\d+/);
});

test('one-click launcher resolves isolated projects, prompt input, models, and tmux defaults', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-launcher-'));
  const project = join(workspace, 'custom-app');
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const result = spawnSync(process.execPath, [launcher,
    '--dry-run',
    '--project', project,
    '--prompt', '帮我做一个离线任务台。',
    '--model', 'deepseek-v4-flash',
    '--effort', 'low',
    '--repair-effort', 'medium',
    '--repair-timeout', '15',
    '--launch', 'false',
    '--port', '3399',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPO_FAST_ENV_FILE: join(workspace, 'missing.env'),
      EXPO_HARMONY_POOL_ROOT: '',
      HP_HDC_TARGET: '127.0.0.1:5557',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.project, project);
  assert.equal(plan.promptKind, 'inline');
  assert.equal(Object.hasOwn(plan, 'candidate'), false);
  assert.equal(plan.model, 'deepseek-v4-flash');
  assert.equal(plan.repairModel, 'deepseek-v4-flash');
  assert.equal(plan.effort, 'low');
  assert.equal(plan.repairEffort, 'medium');
  assert.equal(plan.repairLimit, 100);
  assert.equal(plan.repairTimeout, 15);
  assert.equal(plan.timeout, 0);
  assert.equal(plan.launch, false);
  assert.equal(plan.hap, false);
  assert.equal(plan.pool, resolve(root, '../harmony-pool'));
  assert.equal(plan.hapWaitSeconds, 3600);
  assert.equal(plan.port, 3399);
  assert.equal(plan.hdcTarget, '127.0.0.1:5557');
  assert.match(plan.session, /^expo-fast-custom-app$/);
  assert.equal(plan.sessionLog, join(root, '.expo-fast/session-logs/expo-fast-custom-app.log'));
  assert.ok(plan.requestPath.startsWith(workspace));
  assert.equal(existsSync(project), false);
});

test('tmux launcher persists output and exits its session after the runner completes', {
  skip: spawnSync('tmux', ['-V']).status !== 0 || !existsSync('/bin/zsh'),
}, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-session-log-'));
  const project = join(workspace, 'logged-app');
  const fakeNode = join(workspace, 'fake-node');
  const fakeSdk = join(workspace, 'sdk');
  const fakeDevEco = join(workspace, 'DevEco-Studio.app');
  const session = `expo-fast-log-test-${process.pid}-${Date.now()}`;
  const sessionLog = join(root, '.expo-fast/session-logs', `${session}.log`);
  writeFileSync(fakeNode, `#!/bin/sh
project=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--project' ]; then shift; project="$1"; fi
  shift
done
if [ -n "$project" ]; then mkdir -p "$project/.expo-fast"; fi
echo 'fake runner stdout'
echo 'fake runner stderr' >&2
exit 0
`);
  chmodSync(fakeNode, 0o755);
  mkdirSync(fakeSdk);
  mkdirSync(fakeDevEco);
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const env = {
    ...process.env,
    EXPO_FAST_NODE: fakeNode,
    EXPO_HARMONY_SDK_ROOT: fakeSdk,
    DEVECO_PATH: fakeDevEco,
    CLAUDE_BIN: fakeNode,
  };
  const result = spawnSync(process.execPath, [launcher,
    '--project', project,
    '--prompt', 'Build a small offline task app.',
    '--session', session,
    '--launch', 'false',
  ], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`log\\s+: ${sessionLog.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnSync('tmux', ['has-session', '-t', session]).status !== 0 && existsSync(join(project, '.expo-fast/session.log'))) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.notEqual(spawnSync('tmux', ['has-session', '-t', session]).status, 0);
  const centralLog = readFileSync(sessionLog, 'utf8');
  assert.match(centralLog, /fake runner stdout/);
  assert.match(centralLog, /fake runner stderr/);
  assert.match(centralLog, /LIVETEST_EXIT=0/);
  assert.equal(readFileSync(join(project, '.expo-fast/session.log'), 'utf8'), centralLog);
  rmSync(sessionLog, { force: true });
});

test('tmux launcher forwards EXPO_FAST_BUNDLE_IDENTIFIER into the runner session', {
  skip: spawnSync('tmux', ['-V']).status !== 0 || !existsSync('/bin/zsh'),
}, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-bundle-env-'));
  const fakeNode = join(workspace, 'fake-node');
  const fakeSdk = join(workspace, 'sdk');
  const fakeDevEco = join(workspace, 'DevEco-Studio.app');
  writeFileSync(fakeNode, `#!/bin/sh
echo "bundle=[\${EXPO_FAST_BUNDLE_IDENTIFIER}]"
project=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--project' ]; then shift; project="$1"; fi
  shift
done
if [ -n "$project" ]; then mkdir -p "$project/.expo-fast"; fi
exit 0
`);
  chmodSync(fakeNode, 0o755);
  mkdirSync(fakeSdk);
  mkdirSync(fakeDevEco);
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const baseEnv = {
    ...process.env,
    EXPO_FAST_NODE: fakeNode,
    EXPO_HARMONY_SDK_ROOT: fakeSdk,
    DEVECO_PATH: fakeDevEco,
    CLAUDE_BIN: fakeNode,
  };
  delete baseEnv.EXPO_FAST_BUNDLE_IDENTIFIER;

  async function runSession(label, env) {
    const session = `expo-fast-bundle-${label}-${process.pid}-${Date.now()}`;
    const sessionLog = join(root, '.expo-fast/session-logs', `${session}.log`);
    const result = spawnSync(process.execPath, [launcher,
      '--project', join(workspace, `app-${label}`),
      '--prompt', 'Build a signed app.',
      '--session', session,
      '--launch', 'false',
    ], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnSync('tmux', ['has-session', '-t', session]).status !== 0 && existsSync(sessionLog)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    const log = readFileSync(sessionLog, 'utf8');
    rmSync(sessionLog, { force: true });
    return log;
  }

  const signedLog = await runSession('signed', { ...baseEnv, EXPO_FAST_BUNDLE_IDENTIFIER: 'com.example.profile.slot06' });
  assert.match(signedLog, /bundle=\[com\.example\.profile\.slot06\]/);
  const unsignedLog = await runSession('unsigned', baseEnv);
  assert.match(unsignedLog, /bundle=\[\]/);
});

test('one-click launcher defaults to the tested learning-goals scenario and single K3 execution policy', () => {
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const result = spawnSync(process.execPath, [launcher, '--dry-run', '--launch', 'false'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.promptKind, 'default');
  assert.equal(plan.promptSource, join(root, 'prompts/learning-goals.md'));
  assert.equal(Object.hasOwn(plan, 'candidate'), false);
  assert.equal(plan.model, 'k3-256k');
  assert.equal(plan.effort, 'low');
  assert.equal(plan.repairModel, 'k3-256k');
  assert.equal(plan.repairEffort, 'medium');
  assert.equal(plan.repairLimit, 100);
  assert.equal(plan.timeout, 0);
  assert.equal(plan.repairTimeout, 0);
  assert.equal(plan.foreground, false);
});

test('enabled direct-HAP preview always builds the required HAP', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-required-hap-'));
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const result = spawnSync(process.execPath, [launcher,
    '--dry-run',
    '--project', join(workspace, 'preview-app'),
    '--prompt', 'Build a small offline task app.',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPO_FAST_ENV_FILE: join(workspace, 'missing.env'),
      EXPO_HARMONY_HAP_ENABLED: 'false',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.launch, true);
  assert.equal(plan.hap, true);
});

test('one-click launcher accepts a user-selected output directory under expo-app root', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-output-dir-'));
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const result = spawnSync(process.execPath, [launcher,
    '--dry-run',
    '--app-root', workspace,
    '--output-dir', 'my-selected-app',
    '--repair-timeout', '0',
    '--launch', 'false',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.project, join(workspace, 'my-selected-app'));
  assert.equal(plan.session, 'expo-fast-my-selected-app');
  assert.equal(plan.repairTimeout, 0);
  assert.equal(existsSync(plan.project), false);
});

test('launcher separates follow-up, rebuild, and preview lifecycle actions', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-actions-'));
  const project = join(workspace, 'existing-app');
  const followUp = join(workspace, 'follow-up.md');
  mkdirSync(project, { recursive: true });
  writeFileSync(followUp, '把主按钮改成绿色。\n');
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const common = ['--dry-run', '--project', project, '--prompt', '原始需求', '--launch', 'false'];
  const invoke = (...actionArgs) => {
    const result = spawnSync(process.execPath, [launcher, ...common, ...actionArgs], {
      encoding: 'utf8',
      env: { ...process.env, EXPO_FAST_ENV_FILE: join(workspace, 'missing.env') },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const followUpPlan = invoke('--follow-up-file', followUp);
  assert.equal(followUpPlan.action, 'follow-up');
  assert.equal(followUpPlan.followUpPath, followUp);
  assert.equal(followUpPlan.resume, true);
  assert.equal(invoke('--rebuild').action, 'rebuild');
  assert.equal(invoke('--preview-only').action, 'preview');
  rmSync(workspace, { recursive: true, force: true });
});

test('controlled Agent MCP exposes check and build without a shell tool', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-agent-tools-'));
  const server = join(root, 'scripts/agent-tools-server.mjs');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [server, '--project', workspace], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(rows[1].result.tools.map((tool) => tool.name), ['check', 'build']);
  assert.doesNotMatch(JSON.stringify(rows[1]), /shell|command argument/i);
  rmSync(workspace, { recursive: true, force: true });
});

test('Expo follow-up status is read-only until the initial Agent session exists', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-follow-up-status-'));
  const controller = join(root, 'scripts/follow-up-control.mjs');
  const result = spawnSync(process.execPath, [controller, 'status', '--cwd', workspace, '--run', 'test-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.follow_up.status, 'unavailable');
  assert.equal(output.follow_up.session_id, '');
  assert.equal(existsSync(join(workspace, '.expo-fast')), false);
  rmSync(workspace, { recursive: true, force: true });
});

test('Expo follow-up controller persists FIFO queue updates without argv message text', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-follow-up-'));
  const stateDir = join(workspace, '.expo-fast');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'result.json'), JSON.stringify({ sessionId: 'session-1' }));
  writeFileSync(join(stateDir, 'follow-up.json'), JSON.stringify({
    schemaVersion: 1,
    runtime: 'expo',
    run_name: 'test-run',
    session_id: 'session-1',
    status: 'running',
    sequence: 0,
    queue: [],
    history: [],
    active_command: { id: 'active', type: 'message', status: 'running', text: 'existing' },
    worker_pid: process.pid,
    active_pid: process.pid,
  }));
  const controller = join(root, 'scripts/follow-up-control.mjs');
  const controllerSource = readFileSync(controller, 'utf8');
  assert.match(controllerSource, /'--follow-up-file', command\.request_path,[\s\S]*?'--launch', 'false', '--hap', 'false'/);
  const call = (action, body = null) => {
    const args = [controller, action, '--cwd', workspace, '--run', 'test-run'];
    if (body) args.push('--json-stdin');
    const result = spawnSync(process.execPath, args, {
      input: body ? JSON.stringify(body) : '',
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const queued = call('enqueue', { text: '增加重置按钮', clientMessageId: 'client-1' });
  assert.equal(queued.follow_up.queue_length, 1);
  assert.equal(queued.follow_up.queue[0].text, undefined);
  const commandId = queued.command.id;
  const updated = call('update', { commandId, text: '增加重置按钮并二次确认' });
  assert.equal(updated.follow_up.queue_length, 1);
  const removed = call('remove', { commandId });
  assert.equal(removed.follow_up.queue_length, 0);
  assert.equal(removed.follow_up.history.at(-1).status, 'cancelled');
  rmSync(workspace, { recursive: true, force: true });
});

test('one machine-local env file configures every portable launcher path', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-machine-config-'));
  const appRoot = join(workspace, 'apps');
  const envFile = join(workspace, 'machine.env');
  writeFileSync(envFile, [
    `EXPO_FAST_APP_ROOT="${appRoot}"`,
    'EXPO_FAST_NODE="/portable/node"',
    'EXPO_HARMONY_SDK_ROOT="/portable/devkit_sdk"',
    'EXPO_HARMONY_POOL_ROOT="/portable/harmony-pool"',
    'EXPO_HARMONY_HAP_ENABLED="false"',
    'EXPO_HARMONY_HAP_WAIT_SECONDS="1800"',
    'EXPO_FAST_MODULE_CACHE="/portable/cache-one/node_modules:/portable/cache-two/node_modules"',
    'DEVECO_PATH="/portable/DevEco-Studio.app"',
    'EXPO_FAST_HDC_TARGET="127.0.0.1:5557"',
    'CLAUDE_BIN="portable-claude"',
    'EXPO_FAST_LIVE_CLAUDE="0"',
    '',
  ].join('\n'));
  const env = { ...process.env, EXPO_FAST_ENV_FILE: envFile };
  for (const key of ['EXPO_FAST_APP_ROOT', 'EXPO_FAST_NODE', 'EXPO_HARMONY_SDK_ROOT', 'EXPO_HARMONY_POOL_ROOT', 'EXPO_HARMONY_HAP_ENABLED', 'EXPO_HARMONY_HAP_WAIT_SECONDS', 'EXPO_FAST_MODULE_CACHE', 'EXPO_FAST_HDC_TARGET', 'EXPO_FAST_HDC_DESKTOP_TARGET', 'EXPO_FAST_HDC_PHONE_TARGET', 'HDC_TARGET', 'HP_HDC_TARGET', 'HP_HDC_DESKTOP_TARGET', 'HP_HDC_PHONE_TARGET', 'DEVECO_PATH', 'CLAUDE_BIN', 'EXPO_FAST_LIVE_CLAUDE']) delete env[key];
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const result = spawnSync(process.execPath, [launcher, '--dry-run', '--name', 'portable-app', '--launch', 'false'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.configFile, envFile);
  assert.equal(plan.project, join(appRoot, 'portable-app'));
  assert.equal(plan.node, '/portable/node');
  assert.equal(plan.sdk, '/portable/devkit_sdk');
  assert.equal(plan.pool, '/portable/harmony-pool');
  assert.equal(plan.hap, false);
  assert.equal(plan.hapWaitSeconds, 1800);
  assert.equal(plan.moduleCache, '/portable/cache-one/node_modules:/portable/cache-two/node_modules');
  assert.equal(plan.deveco, '/portable/DevEco-Studio.app');
  assert.equal(plan.hdcTarget, '127.0.0.1:5557');
  assert.equal(plan.claude, 'portable-claude');
});

test('monorepo defaults and relative env paths resolve from the runner root', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-relative-config-'));
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const missingEnv = join(workspace, 'missing.env');
  const cleanEnv = { ...process.env, EXPO_FAST_ENV_FILE: missingEnv };
  for (const key of ['EXPO_FAST_APP_ROOT', 'EXPO_FAST_NODE', 'EXPO_HARMONY_SDK_ROOT', 'EXPO_HARMONY_POOL_ROOT', 'EXPO_FAST_MODULE_CACHE', 'DEVECO_PATH', 'CLAUDE_BIN']) delete cleanEnv[key];

  const defaultsResult = spawnSync(process.execPath, [launcher, '--dry-run', '--name', 'default-app', '--launch', 'false'], {
    cwd: workspace,
    encoding: 'utf8',
    env: cleanEnv,
  });
  assert.equal(defaultsResult.status, 0, defaultsResult.stderr);
  const defaultsPlan = JSON.parse(defaultsResult.stdout);
  assert.equal(defaultsPlan.project, resolve(root, '../expo-app/default-app'));
  assert.equal(defaultsPlan.sdk, resolve(root, '../sdk'));
  assert.equal(defaultsPlan.pool, resolve(root, '../harmony-pool'));

  const relativeEnv = join(workspace, 'relative.env');
  writeFileSync(relativeEnv, [
    'EXPO_FAST_APP_ROOT="../generated-apps"',
    `EXPO_FAST_NODE="${process.execPath}"`,
    'EXPO_HARMONY_SDK_ROOT="../sdk"',
    'EXPO_HARMONY_POOL_ROOT="../harmony-pool"',
    'EXPO_FAST_MODULE_CACHE="../cache-one/node_modules:../cache-two/node_modules"',
    'DEVECO_PATH="../DevEco-Studio.app"',
    'CLAUDE_BIN="../bin/claude"',
    '',
  ].join('\n'));
  const relativeEnvVars = { ...cleanEnv, EXPO_FAST_ENV_FILE: relativeEnv };
  const relativeResult = spawnSync(process.execPath, [launcher, '--dry-run', '--name', 'relative-app', '--launch', 'false'], {
    cwd: workspace,
    encoding: 'utf8',
    env: relativeEnvVars,
  });
  assert.equal(relativeResult.status, 0, relativeResult.stderr);
  const relativePlan = JSON.parse(relativeResult.stdout);
  assert.equal(relativePlan.project, resolve(root, '../generated-apps/relative-app'));
  assert.equal(relativePlan.sdk, resolve(root, '../sdk'));
  assert.equal(relativePlan.pool, resolve(root, '../harmony-pool'));
  assert.equal(relativePlan.moduleCache, `${resolve(root, '../cache-one/node_modules')}:${resolve(root, '../cache-two/node_modules')}`);
  assert.equal(relativePlan.deveco, resolve(root, '../DevEco-Studio.app'));
  assert.equal(relativePlan.claude, resolve(root, '../bin/claude'));
});

test('portable launchers contain no user-specific path and keep machine config outside runtime sources', () => {
  const shell = readFileSync(join(root, 'start-livetest.sh'), 'utf8');
  const launcher = readFileSync(join(root, 'scripts/start-livetest.mjs'), 'utf8');
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const dependencies = readFileSync(join(root, 'scripts/dependencies.mjs'), 'utf8');
  const helper = readFileSync(join(root, 'scripts/fast-harmony.mjs'), 'utf8');
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  assert.doesNotMatch(`${shell}\n${launcher}\n${runner}\n${dependencies}\n${helper}`, /\/Users\/stefan/);
  assert.match(shell, /source "\$LOCAL_ENV"/);
  assert.match(launcher, /process\.loadEnvFile\(localEnvFile\)/);
  for (const key of ['EXPO_FAST_APP_ROOT', 'EXPO_FAST_NODE', 'EXPO_HARMONY_SDK_ROOT', 'EXPO_HARMONY_POOL_ROOT', 'EXPO_FAST_MODULE_CACHE', 'EXPO_FAST_HDC_TARGET', 'DEVECO_PATH', 'CLAUDE_BIN']) assert.match(example, new RegExp(key));
});

test('device type discovery separates PC and phone targets without fixed ports', () => {
  const fakeHdc = join(mkdtempSync(join(tmpdir(), 'fake-hdc-')), 'hdc');
  writeFileSync(fakeHdc, `#!/bin/sh
if [ "$2" = "127.0.0.1:5555" ]; then
  echo phone
elif [ "$2" = "127.0.0.1:5557" ]; then
  echo 2in1
fi
`);
  chmodSync(fakeHdc, 0o755);
  assert.deepEqual(discoverHdcPreviewPools(fakeHdc, ['127.0.0.1:5555', '127.0.0.1:5557']), {
    desktop: ['127.0.0.1:5557'],
    phone: ['127.0.0.1:5555'],
  });
});
test('configured preview targets only prioritize connected devices of the discovered kind', () => {
  assert.deepEqual(prioritizeHdcPreviewTargets(
    ['desktop-b', 'desktop-a', 'desktop-c'],
    ['missing-desktop', 'desktop-c', 'desktop-a'],
  ), ['desktop-c', 'desktop-a', 'desktop-b']);
  assert.deepEqual(prioritizeHdcPreviewTargets(['desktop-b'], ['phone-a']), ['desktop-b']);
});

test('Harmony target selection honors configuration and fails closed for ambiguity', () => {
  assert.deepEqual(parseHdcTargets('127.0.0.1:5555\n127.0.0.1:5557\n'), ['127.0.0.1:5555', '127.0.0.1:5557']);
  assert.equal(configuredHdcTarget({ HP_HDC_TARGET: '127.0.0.1:5557' }), '127.0.0.1:5557');
  assert.equal(configuredHdcTarget({ HDC_TARGET: '127.0.0.1:5555', HP_HDC_TARGET: '127.0.0.1:5557' }), '127.0.0.1:5555');
  assert.equal(configuredHdcTarget({ EXPO_FAST_HDC_TARGET: '127.0.0.1:5559', HDC_TARGET: '127.0.0.1:5555' }), '127.0.0.1:5559');
  assert.equal(selectHdcTarget(['127.0.0.1:5555', '127.0.0.1:5557'], '127.0.0.1:5557'), '127.0.0.1:5557');
  assert.equal(selectHdcTarget(['127.0.0.1:5557']), '127.0.0.1:5557');
  assert.throws(() => selectHdcTarget(['127.0.0.1:5555', '127.0.0.1:5557']), /multiple Harmony targets connected/);
  assert.throws(() => selectHdcTarget(['127.0.0.1:5555'], '127.0.0.1:5557'), /is not connected/);
});

test('Harmony preview target selection binds desktop and phone to distinct devices', () => {
  const targets = ['127.0.0.1:5557', '127.0.0.1:5559'];
  assert.deepEqual(configuredHdcPreviewTargets({
    HP_HDC_DESKTOP_TARGET: '127.0.0.1:5557',
    HP_HDC_PHONE_TARGET: '127.0.0.1:5559',
  }), { desktop: '127.0.0.1:5557', phone: '127.0.0.1:5559' });
  assert.deepEqual(selectHdcPreviewTargets(targets, {
    desktop: '127.0.0.1:5557',
    phone: '127.0.0.1:5559',
  }, '127.0.0.1:5557'), { desktop: '127.0.0.1:5557', phone: '127.0.0.1:5559' });
  assert.throws(() => selectHdcPreviewTargets(targets, {
    desktop: '127.0.0.1:5557',
    phone: '127.0.0.1:5557',
  }), /must use different Harmony targets/);
});

test('Harmony preview ports are stable per device and reverse rules retain target identity', () => {
  const pools = {
    desktop: ['127.0.0.1:5557', '127.0.0.1:5561'],
    phone: ['127.0.0.1:5555', '127.0.0.1:5559'],
  };
  assert.deepEqual(assignHdcPreviewPorts(pools), {
    '127.0.0.1:5557': 3333,
    '127.0.0.1:5561': 3334,
    '127.0.0.1:5555': 3335,
    '127.0.0.1:5559': 3336,
  });
  assert.deepEqual(parseHdcForwardRules([
    '127.0.0.1:5557    tcp:3333 tcp:3456    [Reverse]',
    '127.0.0.1:5555    tcp:3335 tcp:3456    [Reverse]',
  ].join('\n')), [
    { target: '127.0.0.1:5557', devicePort: 3333, hostPort: 3456, direction: 'reverse' },
    { target: '127.0.0.1:5555', devicePort: 3335, hostPort: 3456, direction: 'reverse' },
  ]);
  assert.deepEqual(reversePortCandidates(3333, 4), [3333, 3334, 3335, 3336]);
  assert.throws(() => reversePortCandidates(65534, 4), /invalid Harmony Go reverse port range/);
});

test('Harmony Go reverse mapping retries an orphaned device listener on the next port', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const opener = readFileSync(join(root, 'scripts/open-desktop-preview.mjs'), 'utf8');
  assert.match(runner, /function ensureReverseWithFallback\(/);
  assert.match(runner, /TCP Port listen failed/);
  assert.match(opener, /const activeDevicePort = prepareHarmonyGoTarget\(/);
  assert.match(opener, /activeDevicePort,/);
});

test('preview pool leases desktop and phone independently without cross-kind blocking', async () => {
  const poolRoot = mkdtempSync(join(tmpdir(), 'expo-preview-pool-independent-'));
  const desktop = await acquirePreviewDevice({
    runId: 'desktop-run',
    kind: 'desktop',
    availableTargets: async () => ['shared-desktop'],
    root: poolRoot,
    waitSeconds: 3,
  });
  let secondDesktopResolved = false;
  const secondDesktopPromise = acquirePreviewDevice({
    runId: 'second-desktop-run',
    kind: 'desktop',
    availableTargets: async () => ['shared-desktop'],
    root: poolRoot,
    waitSeconds: 3,
  }).then((lease) => { secondDesktopResolved = true; return lease; });
  const phone = await acquirePreviewDevice({
    runId: 'phone-run',
    kind: 'phone',
    availableTargets: async () => ['phone-target'],
    root: poolRoot,
    waitSeconds: 3,
  });
  assert.equal(phone.target, 'phone-target');
  await new Promise((resolveWait) => setTimeout(resolveWait, 1100));
  assert.equal(secondDesktopResolved, false);
  await desktop.release();
  const secondDesktop = await secondDesktopPromise;
  assert.equal(secondDesktop.target, 'shared-desktop');
  await phone.release();
  await secondDesktop.release();
  rmSync(poolRoot, { recursive: true, force: true });
});

test('preview pool refreshes dynamically discovered targets while a request is queued', async () => {
  const poolRoot = mkdtempSync(join(tmpdir(), 'expo-preview-pool-dynamic-'));
  let targets = [];
  const leasePromise = acquirePreviewDevice({
    runId: 'dynamic-desktop-run',
    kind: 'desktop',
    availableTargets: async () => targets,
    root: poolRoot,
    waitSeconds: 3,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1100));
  targets = ['late-desktop'];
  const lease = await leasePromise;
  assert.equal(lease.target, 'late-desktop');
  await lease.release();
  rmSync(poolRoot, { recursive: true, force: true });
});

test('runner preview validation has priority over queued live viewers', async () => {
  const poolRoot = mkdtempSync(join(tmpdir(), 'expo-preview-pool-priority-'));
  for (const name of ['queue', 'leases', 'quarantine']) mkdirSync(join(poolRoot, name), { recursive: true });
  writeFileSync(join(poolRoot, 'queue/live-viewer.json'), JSON.stringify({
    schema_version: 1,
    run_id: 'live-viewer',
    pid: process.pid,
    kind: 'desktop',
    priority: 'live',
    queued_at: new Date().toISOString(),
  }));

  const lease = await acquirePreviewDevice({
    runId: 'build-validation',
    kind: 'desktop',
    availableTargets: async () => ['desktop-priority'],
    root: poolRoot,
    waitSeconds: 2,
  });

  assert.equal(lease.target, 'desktop-priority');
  await lease.release();
  rmSync(poolRoot, { recursive: true, force: true });
});

test('preview pool leases one free desktop and phone then queues the next run', async () => {
  const poolRoot = mkdtempSync(join(tmpdir(), 'expo-preview-pool-'));
  const pools = {
    desktop: ['127.0.0.1:5557', '127.0.0.1:5561'],
    phone: ['127.0.0.1:5555', '127.0.0.1:5559'],
  };
  const connectedTargets = async () => [...pools.desktop, ...pools.phone];
  const first = await acquirePreviewDevices({
    runId: 'a'.repeat(32), pools, connectedTargets, root: poolRoot, waitSeconds: 3,
  });
  const second = await acquirePreviewDevices({
    runId: 'b'.repeat(32), pools, connectedTargets, root: poolRoot, waitSeconds: 3,
  });
  assert.notEqual(first.targets.desktop, second.targets.desktop);
  assert.notEqual(first.targets.phone, second.targets.phone);

  let thirdResolved = false;
  const thirdPromise = acquirePreviewDevices({
    runId: 'c'.repeat(32), pools, connectedTargets, root: poolRoot, waitSeconds: 3,
  }).then((lease) => { thirdResolved = true; return lease; });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1100));
  assert.equal(thirdResolved, false);
  await first.release();
  const third = await thirdPromise;
  assert.equal(third.targets.desktop, first.targets.desktop);
  assert.equal(third.targets.phone, first.targets.phone);
  await second.release();
  await third.release();
  rmSync(poolRoot, { recursive: true, force: true });
});

test('preview pool supports desktop-only validation when no phone emulator is configured', async () => {
  const poolRoot = mkdtempSync(join(tmpdir(), 'expo-preview-pool-desktop-only-'));
  const pools = {
    desktop: ['127.0.0.1:5555'],
    phone: [],
  };
  const lease = await acquirePreviewDevices({
    runId: 'f'.repeat(32),
    pools,
    connectedTargets: async () => ['127.0.0.1:5555'],
    root: poolRoot,
    waitSeconds: 3,
  });
  assert.deepEqual(lease.targets, { desktop: '127.0.0.1:5555', phone: '' });
  const runnableTargets = Object.fromEntries(
    Object.entries(lease.targets).filter(([, target]) => Boolean(target)),
  );
  assert.deepEqual(runnableTargets, { desktop: '127.0.0.1:5555' });
  assert.deepEqual(lease.records.map(({ kind, target }) => ({ kind, target })), [
    { kind: 'desktop', target: '127.0.0.1:5555' },
  ]);
  await lease.release();
  rmSync(poolRoot, { recursive: true, force: true });
});

test('preview pool quarantines a failed target and leases its same-kind fallback', async () => {
  const poolRoot = mkdtempSync(join(tmpdir(), 'expo-preview-pool-failover-'));
  const pools = {
    desktop: ['127.0.0.1:5557', '127.0.0.1:5561'],
    phone: ['127.0.0.1:5555', '127.0.0.1:5559'],
  };
  const connectedTargets = async () => [...pools.desktop, ...pools.phone];
  const first = await acquirePreviewDevices({
    runId: 'd'.repeat(32), pools, connectedTargets, root: poolRoot, waitSeconds: 3,
  });
  const failedDesktop = first.targets.desktop;
  await first.quarantine(failedDesktop, 'shell did not reach foreground');
  await first.release();

  const replacement = await acquirePreviewDevices({
    runId: 'e'.repeat(32), pools, connectedTargets, root: poolRoot, waitSeconds: 3,
  });
  assert.notEqual(replacement.targets.desktop, failedDesktop);
  assert.equal(replacement.targets.phone, first.targets.phone);
  await replacement.release();
  rmSync(poolRoot, { recursive: true, force: true });
});

test('preview pool configuration accepts comma-separated device lists', () => {
  assert.deepEqual(configuredPreviewPools({
    HP_HDC_DESKTOP_TARGETS: '127.0.0.1:5557,127.0.0.1:5561',
    HP_HDC_PHONE_TARGETS: '127.0.0.1:5555, 127.0.0.1:5559',
  }), {
    desktop: ['127.0.0.1:5557', '127.0.0.1:5561'],
    phone: ['127.0.0.1:5555', '127.0.0.1:5559'],
  });
});

test('foreground bundle inspection distinguishes Harmony Go from the system launcher', () => {
  const launcher = { children: [{ attributes: { bundleName: 'com.ohos.sceneboard' } }] };
  const harmonyGo = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide' } }] };
  assert.deepEqual(visibleBundleNames(launcher), ['com.ohos.sceneboard']);
  assert.deepEqual(visibleBundleNames(harmonyGo), ['com.example.myapplication1.ide']);
});

test('exact-app identity uses the active manifest id while preserving a semantic display name', () => {
  const manifestId = 'remote-ui-ea02ff4f9333452b9f6c3ea3185d49b8';
  const layout = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide', type: 'root' }, children: [
    { attributes: { id: harmonyGoActiveMiniAppNodeId(manifestId), type: 'Text', text: '专注时钟', bounds: '[70,241][1231,511]', visible: 'true' } },
    { attributes: { id: 'timer-ring', type: 'Custom', bounds: '[40,756][1280,1800]', visible: 'true' } },
  ] }] };
  const identity = inspectCurrentMiniApp(layout, manifestId, ['timer-ring']);
  assert.equal(identity.ok, true, identity.errors.join('; '));
  assert.equal(identity.currentProjectId, manifestId);
  assert.equal(identity.currentProjectTitle, '专注时钟');
  assert.equal(identity.currentProjectBounds, '[70,241][1231,511]');
});

test('exact-app identity does not confuse a catalog card with the active mini app', () => {
  const manifestId = 'remote-ui-wanted';
  const layout = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide', type: 'root' }, children: [
    { attributes: { id: harmonyGoActiveMiniAppNodeId('remote-ui-other'), type: 'Text', text: '同名应用', visible: 'true' } },
    { attributes: { type: 'Button', text: '项目', visible: 'true' } },
    { attributes: { id: harmonyGoCatalogMiniAppNodeId(manifestId), type: 'Row', visible: 'true' }, children: [
      { attributes: { type: 'Text', text: '同名应用', visible: 'true' } },
      { attributes: { type: 'Button', text: '安装', visible: 'true' } },
    ] },
    { attributes: { id: 'timer-ring', type: 'Custom', visible: 'true' } },
  ] }] };
  const identity = inspectCurrentMiniApp(layout, manifestId, ['timer-ring']);
  assert.equal(identity.ok, false);
  assert.match(identity.errors.join('; '), /active mini-app id/);
});

test('manifest ids disambiguate catalog cards and the active app when display names match', () => {
  const firstId = 'remote-ui-first';
  const secondId = 'remote-ui-second';
  const card = (manifestId, bounds) => ({
    attributes: { id: harmonyGoCatalogMiniAppNodeId(manifestId), type: 'Row', bounds, visible: 'true' },
    children: [
      { attributes: { type: 'Text', text: '同名应用', visible: 'true' } },
      { attributes: { type: 'Button', text: '安装', visible: 'true' } },
    ],
  });
  const firstCard = card(firstId, '[20,200][600,320]');
  const secondCard = card(secondId, '[20,340][600,460]');
  const catalog = { children: [firstCard, secondCard] };

  assert.strictEqual(catalogProjectCard(catalog, firstId), firstCard);
  assert.strictEqual(catalogProjectCard(catalog, secondId), secondCard);
  assert.equal(catalogHasProject(catalog, firstId), true);
  assert.deepEqual(catalogVisibleProjectIds(catalog), [firstId, secondId]);
  assert.match(catalogFingerprint(catalog), new RegExp(harmonyGoCatalogMiniAppNodeId(secondId)));

  const running = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide', type: 'root' }, children: [
    { attributes: { id: harmonyGoActiveMiniAppNodeId(secondId), type: 'Text', text: '同名应用', visible: 'true' } },
    { attributes: { id: 'product-summary', type: 'Custom', visible: 'true' } },
  ] }] };
  assert.equal(inspectCurrentMiniApp(running, firstId, ['product-summary']).ok, false);
  assert.equal(inspectCurrentMiniApp(running, secondId, ['product-summary']).ok, true);
});

test('HDC textual start failures are rejected even when the process exits zero', () => {
  assert.equal(hdcOutputFailed('start ability successfully.\n'), false);
  assert.equal(hdcOutputFailed('error: failed to start ability.\nError Code:10106102'), true);
  assert.equal(hdcOutputFailed('[Fail][E003001] Invalid bundle name: com.example.myapplication1.ide'), true);
});

test('every hdc invocation is bounded so an unresponsive device fails instead of hanging', () => {
  // A dead device channel does not error: shell/fport/rport block forever while
  // `list targets` still answers and reports the device as Connected.
  assert.equal(hdcCommandKind(['list', 'targets']), 'session');
  assert.equal(hdcCommandKind(['-t', '127.0.0.1:5555', 'shell', 'aa', 'start']), 'device');
  assert.equal(hdcCommandKind(['-t', '127.0.0.1:5555', 'rport', 'tcp:3333', 'tcp:3333']), 'device');
  assert.equal(hdcCommandKind(['-t', '127.0.0.1:5555', 'install', '-r', 'app.hap']), 'transfer');
  assert.equal(hdcCommandKind(['-t', '127.0.0.1:5555', 'file', 'recv', 'a', 'b']), 'transfer');
  assert.equal(hdcCommandTimeoutMs(['list', 'targets']), HDC_SESSION_TIMEOUT_MS);
  assert.equal(hdcCommandTimeoutMs(['-t', 'a:1', 'fport', 'ls']), HDC_DEVICE_TIMEOUT_MS);
  assert.equal(hdcCommandTimeoutMs(['-t', 'a:1', 'install', '-r', 'app.hap']), HDC_TRANSFER_TIMEOUT_MS);
  assert.equal(hdcCommandTarget(['-t', '127.0.0.1:5555', 'shell', 'id']), '127.0.0.1:5555');
  assert.equal(hdcCommandTarget(['fport', 'ls']), '');
  assert.ok(HDC_TRANSFER_TIMEOUT_MS > HDC_DEVICE_TIMEOUT_MS);
  assert.ok(HDC_DEVICE_TIMEOUT_MS > HDC_SESSION_TIMEOUT_MS);

  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const launcher = readFileSync(join(root, 'scripts/start-livetest.mjs'), 'utf8');
  const targets = readFileSync(join(root, 'scripts/hdc-target.mjs'), 'utf8');
  assert.match(runner, /spawnSync\(hdc, args, \{ encoding: 'utf8', timeout: timeoutMs \}\)/);
  assert.match(runner, /r\.error\?\.code === 'ETIMEDOUT'/);
  assert.doesNotMatch(runner, /spawnSync\(hdc,(?![^)]*timeout)/);
  assert.doesNotMatch(launcher, /spawnSync\(hdc,(?![^)]*timeout)/);
  assert.doesNotMatch(targets, /spawnSync\(hdc,(?![^)]*timeout)/);
});

test('hdc timeout errors name the layer that stalled and how to recover it', () => {
  const device = hdcTimeoutMessage(['-t', '127.0.0.1:5555', 'shell', 'aa', 'start'], HDC_DEVICE_TIMEOUT_MS);
  assert.match(device, /timed out after 120s/);
  assert.match(device, /device channel is not responding/);
  assert.match(device, /reporting the device as Connected/);
  assert.match(device, /hdc tconn 127\.0\.0\.1:5555 -remove && hdc tconn 127\.0\.0\.1:5555/);

  // `list targets` is answered by the server, so tconn is the wrong advice here.
  const session = hdcTimeoutMessage(['list', 'targets'], HDC_SESSION_TIMEOUT_MS);
  assert.match(session, /hdc server is not responding/);
  assert.match(session, /hdc kill -r/);
  assert.doesNotMatch(session, /tconn/);
});

test('a first install distinguishes an absent bundle from a previous build left behind', () => {
  // Verbatim device output for a bundle that is not installed yet.
  const forceStopAbsent = [
    'error: failed to force stop process.',
    'Error Code:10104002  Error Message:Failed to retrieve specified package information.',
    'Error cause: The application corresponding to the specified package name is not installed.',
  ].join('\n');
  const uninstallAbsent = [
    'error: failed to uninstall bundle.',
    'code:9568386',
    'error: uninstall missing installed bundle.',
  ].join('\n');

  // hdc exits 0 for both, so they are failures as far as text classification
  // goes; the tolerance is layered on top of that detection, not instead of it.
  assert.equal(hdcOutputFailed(forceStopAbsent), true);
  assert.equal(hdcOutputFailed(uninstallAbsent), true);

  assert.equal(hdcForceStopBundleAbsent(forceStopAbsent), true);
  assert.equal(hdcUninstallBundleAbsent(uninstallAbsent), true);

  // Each signature is specific to its own command: neither may wave the other
  // through, and neither may wave a genuine failure through. A force-stop that
  // fails for any other reason means the previous build may still be running,
  // and a failed uninstall means its persisted data survives `install -r`.
  assert.equal(hdcForceStopBundleAbsent(uninstallAbsent), false);
  assert.equal(hdcUninstallBundleAbsent(forceStopAbsent), false);
  for (const genuine of [
    'error: failed to force stop process.\nError Code:16000050  Internal error.',
    '[Fail][E003001] Invalid bundle name: com.example.myapplication1.ide',
    'error: failed to uninstall bundle.\ncode:9568256\nerror: uninstall failed due to a running application.',
  ]) {
    assert.equal(hdcForceStopBundleAbsent(genuine), false, genuine);
    assert.equal(hdcUninstallBundleAbsent(genuine), false, genuine);
  }

  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const install = runner.match(/async function installHapAndOpen\([\s\S]*?\n\}/)?.[0];
  assert.ok(install, 'installHapAndOpen source');
  // force-stop is depth now that the foreground check reads the build stamp, so a
  // non-absence failure is reported rather than fatal. uninstall is not: `install -r`
  // keeps application data, and stale data rendered by new code still stamps correctly.
  assert.match(install, /hdcRunAdvisory\(\s*\['-t', target, 'shell', 'aa', 'force-stop', bundleName\],\s*hdcForceStopBundleAbsent,/);
  assert.match(install, /hdcRunClearingBundle\(\[[^\]]*'uninstall', '-n', bundleName\], hdcUninstallBundleAbsent\)/);
  assert.doesNotMatch(install, /hdcRunClearingBundle\(\[[^\]]*'force-stop'/);
  // A bare catch would hide a previous build that refused to go away.
  assert.doesNotMatch(install, /catch\s*\{\s*\}/);
});

test('Harmony Go preview wakes and unlocks a reused target and retries a locked launch once', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const runtime = readFileSync(join(root, 'scripts/harmony-go-runtime.mjs'), 'utf8');
  assert.match(runner, /function ensureHarmonyGoInstalled\(target\)/);
  assert.match(runtime, /EXPO_HARMONY_GO_HAP/);
  assert.match(runtime, /EXPO_HARMONY_GO_BUNDLE_NAME/);
  assert.match(runtime, /bundleNameFromHap/);
  assert.doesNotMatch(runner, /harmonyGoUserId\(target\);\s*return;/);
  assert.match(runner, /A shell installed outside Runner may not have launched yet either/);
  assert.match(runner, /ensureHarmonyGoInstalled\(target\);\s*const activeDevicePort/);
  assert.match(runner, /function wakeAndUnlockHarmonyTarget\(target\)/);
  assert.match(runner, /'power-shell', 'wakeup'/);
  assert.match(runner, /'uiInput', 'swipe'/);
  assert.match(runner, /10106102\|device screen is locked/);
  assert.match(runner, /wakeAndUnlockHarmonyTarget\(target\);\s*hdcRun\(args\);/);
});

test('Expo initial preview requests only a dynamically discovered desktop HAP target', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /dependencies\.acquireDevice \|\| acquirePreviewDevice/);
  assert.match(runner, /kind: 'desktop'/);
  assert.match(runner, /discoverHdcPreviewPools\(hdc, connected\)\.desktop/);
  assert.match(runner, /prioritizeHdcPreviewTargets\(discovered, pools\.desktop\)/);
  assert.match(runner, /launchPreviewState = \{\s*desktop:/);
  assert.doesNotMatch(runner, /launchPreviewState = \{\s*desktop:[\s\S]{0,120}phone:/);
  assert.doesNotMatch(runner, /splitTargets\(o\.phoneTargets\)/);
  assert.doesNotMatch(runner, /acquirePreviewDevices\(\{/);
});

test('runner resets the persisted Harmony Go catalog origin before exact-app launch', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /const harmonyGoLocalOrigin = 'http:\/\/127\.0\.0\.1:3333'/);
  assert.match(runner, /'keyEvent', '2072', '2017'/);
  assert.match(runner, /action: 'set-catalog-origin'/);
  assert.match(runner, /action: 'refresh-catalog'/);
  assert.match(runner, /Harmony Go catalog did not expose mini app/);
  assert.ok(runner.includes("'shell', `printf '${origin}\\\\n' > ${configPath}`"));
  assert.doesNotMatch(runner, /'shell', '-b', bundleName, `printf/);
  assert.doesNotMatch(runner, /'shell', '-b', bundleName, 'cat'/);
  assert.ok(runner.indexOf("action: 'set-catalog-origin'") < runner.indexOf("action: 'refresh-catalog'"));
  assert.ok(runner.indexOf('await prepareCatalog') < runner.indexOf('const remove = relatedButton'));
});

test('runner scrolls a long Harmony Go catalog before declaring the app missing', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /function revealCatalogProject\(/);
  assert.match(runner, /action: 'scroll-catalog'/);
  assert.match(runner, /'uiInput', 'swipe'/);
  assert.match(runner, /catalogViewport\(/);
  assert.match(runner, /layout = await revealCatalogProject\(/);
});

test('runner waits for the exact catalog card to install and the exact product to render', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const identity = readFileSync(join(root, 'scripts/layout-identity.mjs'), 'utf8');
  assert.match(runner, /catalogProjectCard\(layout, identity\)/);
  assert.match(identity, /attributes\.id === identity/);
  assert.match(identity, /HARMONY_GO_CATALOG_MINI_APP_ID_PREFIX/);
  assert.doesNotMatch(runner, /\^remote-ui-\[a-f0-9\]/);
  assert.match(runner, /function waitForInstalledMiniApp\(/);
  assert.match(runner, /timed out waiting for mini app \$\{manifestId\} to install/);
  assert.match(runner, /\(candidate\) => inspectCurrentMiniApp\(candidate, manifestId, productMarkers\)\.ok/);
  assert.doesNotMatch(runner, /const identityButton = collect\(/);
  assert.ok(runner.indexOf("assertCurrentMiniApp(layout, manifestId, productMarkers, 'launch-product')") < runner.lastIndexOf("'screenCap'"));
  assert.match(runner, /const artifactDigest = createHash\('sha256'\)/);
  assert.match(runner, /manifestId, artifactDigest, currentProjectId: identity\.currentProjectId, currentProjectTitle: identity\.currentProjectTitle/);
});

test('desktop preview installs the same generated HAP used by phone preview', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const hapBuilder = readFileSync(join(root, 'scripts/hap-build.mjs'), 'utf8');
  assert.match(runner, /function installHapAndOpen\(/);
  assert.match(runner, /'install', '-r', hapPath/);
  assert.match(runner, /installPreview\(project, target, hap, 'desktop'\)/);
  assert.match(hapBuilder, /HAP_DEVICE_TYPES\.join\(','\)/);
});

test('preview leases identify a run the same way the HAP build does', async () => {
  // A command-line project is not named remote-ui-<32 hex>, and the lease must
  // not require that shape: the run id it carries is diagnostic, never read
  // back. run_id appears only as a written field, and the frontend matches a
  // lease by lease_id instead.
  const project = join(tmpdir(), 'pomodoro-01');
  const seen = [];
  const result = await launchHapPreview(
    project,
    { desktop: ['desktop-ready'] },
    { hapPath: '/tmp/product.hap', bundleName: 'com.example.product' },
    () => {},
    {
      discoverTargets: async () => ['desktop-ready'],
      acquireDevice: async ({ runId, availableTargets }) => {
        seen.push(runId);
        return { target: (await availableTargets())[0], release: async () => {}, quarantine: async () => {} };
      },
      installPreview: async () => ({ result: 'PASS' }),
    },
  );
  assert.equal(result.target, 'desktop-ready');
  assert.equal(seen.length, 1);

  // Called outside a run there is no run state, and the device pool supplies its
  // own identifier, so an absent value must not throw.
  assert.equal(seen[0], undefined);

  // Both paths read the identity this run already recorded in state.json, so a
  // lease and its HAP job carry the same value.
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /runId: activeRunState\?\.runId/);
  assert.match(runner, /runId: activeRunState\.runId/);
  assert.doesNotMatch(runner, /frontendRunId/);
  assert.match(readFileSync(join(root, 'scripts/preview-device-pool.mjs'), 'utf8'), /String\(runId \|\| randomUUID\(\)\)/);
});

test('desktop HAP preview quarantines a failed emulator and installs on the fallback', async () => {
  const project = join(tmpdir(), 'pomodoro-01');
  const targets = ['desktop-broken', 'desktop-ready'];
  const events = [];
  const leases = [];
  const installed = [];
  const result = await launchHapPreview(
    project,
    { desktop: targets },
    { hapPath: '/tmp/product.hap', bundleName: 'com.example.product' },
    (event) => events.push(event),
    {
      discoverTargets: async () => targets,
      acquireDevice: async ({ availableTargets }) => {
        const target = (await availableTargets())[0];
        const lease = {
          target,
          leaseId: `lease-${target}`,
          quarantined: [],
          released: 0,
          async quarantine(failedTarget) { this.quarantined.push(failedTarget); },
          async release() { this.released += 1; },
        };
        leases.push(lease);
        return lease;
      },
      installPreview: async (_project, target) => {
        installed.push(target);
        if (target === 'desktop-broken') throw new Error('install rejected');
        return { result: 'PASS', target, screenshot: '/tmp/preview.jpeg' };
      },
    },
  );
  assert.deepEqual(installed, targets);
  assert.deepEqual(leases[0].quarantined, ['desktop-broken']);
  assert.equal(leases[0].released, 1);
  assert.equal(leases[1].released, 0);
  assert.equal(events.some((event) => event.status === 'retrying' && event.target === 'desktop-broken'), true);
  assert.equal(result.target, 'desktop-ready');
  await result.lease.release();
  assert.equal(leases[1].released, 1);
});

test('desktop HAP preview stops after every discovered emulator fails', async () => {
  const project = join(tmpdir(), 'remote-ui-00000000000000000000000000000002');
  const target = 'desktop-broken';
  let releases = 0;
  await assert.rejects(
    launchHapPreview(
      project,
      { desktop: [target] },
      { hapPath: '/tmp/product.hap', bundleName: 'com.example.product' },
      () => {},
      {
        discoverTargets: async () => [target],
        acquireDevice: async ({ availableTargets }) => ({
          target: (await availableTargets())[0],
          async quarantine() {},
          async release() { releases += 1; },
        }),
        installPreview: async () => { throw new Error('install rejected'); },
      },
    ),
    /all desktop preview targets failed HAP installation/,
  );
  assert.equal(releases, 1);
});

test('direct-HAP preview rejects the legacy Harmony Go smoke agent before generation', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-direct-hap-smoke-'));
  const request = join(project, 'request.md');
  writeFileSync(request, 'Build a small offline task app.');
  const result = spawnSync(process.execPath, [join(root, 'scripts/run-livetest.mjs'),
    '--project', project,
    '--request', request,
    '--smoke-agent', 'true',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Harmony Go smoke validation is not supported for direct-HAP preview/);
  assert.equal(existsSync(join(project, 'App.tsx')), false);
});

test('external controller atomically records live generation, repair, and completion state', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-state-'));
  const runId = 'run-state-test';
  writeRunState(project, 'generating_code', { runId, reset: true, detail: 'model_generation', context: { model: 'k3-256k' } });
  writeRunState(project, 'generating_code', { runId, detail: 'app_icon_generation', context: { appIcon: { model: 'k3-256k' } } });
  writeRunState(project, 'repairing', { runId, detail: 'model_repair' });
  writeRunState(project, 'completed', { runId, detail: 'done', context: { result: 'passed' } });

  const stateDir = join(project, '.expo-fast');
  const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.state, 'completed');
  assert.equal(state.label, '完成');
  assert.equal(state.status, 'passed');
  assert.equal(state.detail, 'done');
  assert.equal(state.detailLabel, '完成');
  assert.equal(state.context.model, 'k3-256k');
  assert.equal(state.context.result, 'passed');
  assert.deepEqual(state.history.map((entry) => entry.state), ['generating_code', 'generating_code', 'repairing', 'completed']);
  assert.equal(state.history[1].detailLabel, '生成应用图标');
  assert.deepEqual(readdirSync(stateDir), ['state.json']);

  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /setRunState\('generating_code', 'model_generation'/);
  assert.match(runner, /setRunState\('repairing', 'model_repair'/);
  assert.match(runner, /setRunState\('completed', 'done'/);
  assert.ok(runner.indexOf("[helper, 'prepare', project, request]") < runner.indexOf("setRunState('generating_code', 'preparing'"));
});

test('external controller records a terminal failed state without invoking the product agent', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-state-failure-'));
  const request = join(project, 'request.md');
  writeFileSync(request, 'Build a small offline task app.');
  const runner = join(root, 'scripts/run-livetest.mjs');
  const result = spawnSync(process.execPath, [runner,
    '--project', project,
    '--request', request,
    '--effort', 'invalid',
    '--launch', 'false',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const state = JSON.parse(readFileSync(join(project, '.expo-fast/state.json'), 'utf8'));
  assert.equal(state.state, 'failed');
  assert.equal(state.status, 'failed');
  assert.equal(state.history[0].state, 'failed');
  assert.equal(state.history.at(-1).state, 'failed');
  assert.match(state.error, /effort must be low, medium, high, or max/);
});

test('runner publishes a validated SDK pool HAP into the run-owned output', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-hap-'));
  const project = join(workspace, 'product');
  const sdk = join(workspace, 'sdk');
  const pool = join(workspace, 'pool');
  mkdirSync(project);
  mkdirSync(sdk);
  mkdirSync(pool);
  let invocation;
  const result = runHapPoolBuild({
    project,
    sdk,
    pool,
    runId: 'run-123',
    deviceType: 'phone',
    commandRunner(command, args) {
      invocation = { command, args };
      const output = args[args.indexOf('--output') + 1];
      const jobId = args[args.indexOf('--job-id') + 1];
      const hapPath = join(output, `${basename(project)}-${jobId}.hap`);
      mkdirSync(output, { recursive: true });
      writeFileSync(hapPath, 'unsigned-hap');
      const hapSha256 = createHash('sha256').update('unsigned-hap').digest('hex');
      writeFileSync(join(output, 'build-result.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'success',
        jobId,
        slotId: 'slot-02',
        productRoot: realpathSync(project),
        durationMs: 1234,
        hapPath,
        hapSha256,
        bundleName: 'com.example.product',
        deviceTypes: ['phone', '2in1'],
        buildMode: 'release',
      }));
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[1], 'build');
  assert.equal(invocation.args[invocation.args.indexOf('--pool') + 1], pool);
  assert.equal(invocation.args[invocation.args.indexOf('--build-mode') + 1], 'release');
  assert.equal(invocation.args[invocation.args.indexOf('--device-type') + 1], 'phone,2in1');
  assert.deepEqual(HAP_DEVICE_TYPES, ['phone', '2in1']);
  assert.equal(result.status, 'ready');
  assert.equal(result.slotId, 'slot-02');
  assert.equal(result.bundleName, 'com.example.product');
  assert.ok(result.hapPath.startsWith(join(realpathSync(project), '.expo-fast/hap')));
  assert.equal(existsSync(result.hapPath), true);
});

test('forced HAP rebuild invalidates an existing ready result and invokes the SDK pool', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-hap-rebuild-'));
  const project = join(workspace, 'product');
  const sdk = join(workspace, 'sdk');
  const pool = join(workspace, 'pool');
  mkdirSync(project);
  mkdirSync(sdk);
  mkdirSync(pool);
  const realProject = realpathSync(project);
  const output = join(realProject, '.expo-fast/hap');
  mkdirSync(output, { recursive: true });

  const oldHapPath = join(output, 'old.hap');
  const oldHap = 'old-source-hap';
  writeFileSync(oldHapPath, oldHap);
  writeFileSync(join(output, 'build-result.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'success',
    jobId: 'hap-old-run',
    productRoot: realProject,
    hapPath: oldHapPath,
    hapSha256: createHash('sha256').update(oldHap).digest('hex'),
    deviceTypes: ['phone', '2in1'],
    buildMode: 'release',
  }));

  let invocations = 0;
  const reused = runHapPoolBuild({
    project,
    sdk,
    pool,
    runId: 'reuse-run',
    commandRunner() {
      invocations += 1;
      return { status: 1, stdout: '', stderr: 'must not run' };
    },
  });
  assert.equal(reused.reused, true);
  assert.equal(invocations, 0);

  const rebuilt = runHapPoolBuild({
    project,
    sdk,
    pool,
    runId: 'fresh-run',
    reuseExisting: false,
    commandRunner(_command, args) {
      invocations += 1;
      assert.equal(existsSync(join(output, 'build-result.json')), false);
      const jobId = args[args.indexOf('--job-id') + 1];
      const hapPath = join(output, 'fresh.hap');
      const contents = 'fresh-source-hap';
      writeFileSync(hapPath, contents);
      writeFileSync(join(output, 'build-result.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'success',
        jobId,
        productRoot: realProject,
        hapPath,
        hapSha256: createHash('sha256').update(contents).digest('hex'),
        deviceTypes: ['phone', '2in1'],
        buildMode: 'release',
      }));
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(invocations, 1);
  assert.equal(rebuilt.status, 'ready');
  assert.notEqual(rebuilt.hapSha256, reused.hapSha256);

  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /reuseExisting: action !== 'rebuild'/);
});

test('preview refresh HAP build stays isolated from the canonical run artifact', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-preview-hap-'));
  const project = join(workspace, 'product');
  const sdk = join(workspace, 'sdk');
  const pool = join(workspace, 'pool');
  mkdirSync(project);
  mkdirSync(sdk);
  mkdirSync(pool);
  const realProject = realpathSync(project);
  const canonical = join(realProject, '.expo-fast/hap');
  const output = join(realProject, '.expo-fast/preview-refresh/revision-2');
  mkdirSync(canonical, { recursive: true });
  writeFileSync(join(canonical, 'build-result.json'), '{"status":"sentinel"}');

  const result = runHapPoolBuild({
    project,
    sdk,
    pool,
    outputRoot: output,
    runId: 'revision-2',
    reuseExisting: false,
    commandRunner(_command, args) {
      assert.equal(args[args.indexOf('--output') + 1], output);
      const hapPath = join(output, 'revision-2.hap');
      mkdirSync(output, { recursive: true });
      writeFileSync(hapPath, 'revision-2');
      writeFileSync(join(output, 'build-result.json'), JSON.stringify({
        status: 'success',
        jobId: 'revision-2',
        productRoot: realProject,
        hapPath,
        hapSha256: createHash('sha256').update('revision-2').digest('hex'),
        deviceTypes: ['phone', '2in1'],
        buildMode: 'release',
      }));
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'ready');
  assert.ok(result.hapPath.startsWith(output));
  assert.equal(readFileSync(join(canonical, 'build-result.json'), 'utf8'), '{"status":"sentinel"}');
});

test('runner records a bounded HAP failure when the SDK pool command cannot publish diagnostics', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-hap-failure-'));
  const project = join(workspace, 'product');
  const sdk = join(workspace, 'sdk');
  mkdirSync(project);
  mkdirSync(sdk);
  const result = runHapPoolBuild({
    project,
    sdk,
    pool: join(workspace, 'missing-pool'),
    runId: 'run-failed',
    commandRunner() {
      return { status: 7, stdout: '', stderr: 'pool unavailable' };
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureStage, 'pool-command');
  assert.match(result.error, /pool unavailable/);
  assert.equal(existsSync(result.resultPath), true);
  const persisted = JSON.parse(readFileSync(result.resultPath, 'utf8'));
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.productRoot, realpathSync(project));
});

test('runner rejects a successful pool result that lacks the universal HAP device contract', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-hap-device-contract-'));
  const project = join(workspace, 'product');
  const sdk = join(workspace, 'sdk');
  mkdirSync(project);
  mkdirSync(sdk);
  const result = runHapPoolBuild({
    project,
    sdk,
    pool: join(workspace, 'pool'),
    runId: 'run-phone-only',
    commandRunner(_command, args) {
      const output = args[args.indexOf('--output') + 1];
      const jobId = args[args.indexOf('--job-id') + 1];
      const hapPath = join(output, 'phone-only.hap');
      mkdirSync(output, { recursive: true });
      writeFileSync(hapPath, 'phone-only-hap');
      writeFileSync(join(output, 'build-result.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'success',
        jobId,
        productRoot: realpathSync(project),
        hapPath,
        bundleName: 'com.example.product',
        deviceTypes: ['phone'],
        buildMode: 'release',
      }));
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.hapPath, null);
  assert.match(result.error, /does not support required device types phone,2in1/);
});

test('catalog captures emulator-validated support exports', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-catalog-'));
  const result = spawnSync(process.execPath, [script, 'catalog', project], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(readFileSync(join(project, '.expo-fast/capability-catalog.json'), 'utf8'));
  const gradient = catalog.available.find((entry) => entry.package === 'expo-linear-gradient');
  assert.ok(gradient);
  assert.deepEqual(gradient.supportedExports, ['LinearGradient']);
  assert.equal(catalog.baseline.reactNative, '0.84.1');
  assert.equal(catalog.schemaVersion, 3);
  assert.ok(catalog.contractsSha256);
  const svg = catalog.available.find((entry) => entry.package === 'react-native-svg');
  const storage = catalog.available.find((entry) => entry.package === '@react-native-async-storage/async-storage');
  assert.equal(svg.version, '15.15.4');
  assert.ok(svg.supportedExports.includes('Path'));
  assert.equal(svg.evidence, 'compatibility-contract');
  assert.equal(svg.supportContract, 'tools/harmony/support/compatibility/react-native-svg.json');
  assert.equal(svg.harmonyPorts[0].package, '@react-native-oh-tpl/react-native-svg');
  assert.equal(storage.version, '1.24.0');
  assert.equal(storage.evidence, 'harmony-go-runtime');
  assert.equal(storage.runtimeOverride.nativePackage, '@react-native-oh-tpl/async-storage');
  assert.ok(catalog.unavailable.some((entry) => entry.package === 'react-native-webview'));
  const fingerprint = JSON.parse(readFileSync(join(project, '.expo-fast/sdk-fingerprint.json'), 'utf8'));
  assert.equal(fingerprint.runtimeVersion, catalog.baseline.runtimeVersion);
  assert.ok(fingerprint.contractsSha256);
});

test('product capability selection adds exact Expo dependencies and rejects drift', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-selection-'));
  const project = join(workspace, 'selected-app');
  const request = join(workspace, 'request.md');
  writeFileSync(request, '导出 JSON 并从 JSON 文件导入。');
  const prepared = spawnSync(process.execPath, [script, 'prepare', project, request], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const packagePath = join(project, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const catalog = JSON.parse(readFileSync(join(project, '.expo-fast/capability-catalog.json'), 'utf8'));
  assert.equal(pkg.dependencies['react-native-svg'], '15.15.4');
  assert.equal(pkg.dependencies['@react-native-async-storage/async-storage'], undefined);
  assert.equal(pkg.dependencies['expo-sharing'], undefined);
  pkg.dependencies['expo-sharing'] = catalog.available.find((entry) => entry.package === 'expo-sharing').version;
  pkg.dependencies['expo-document-picker'] = catalog.available.find((entry) => entry.package === 'expo-document-picker').version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const resolved = spawnSync(process.execPath, [script, 'resolve-capabilities', project], { encoding: 'utf8' });
  assert.equal(resolved.status, 0, resolved.stderr);
  const selection = JSON.parse(readFileSync(join(project, '.expo-fast/capability-selection.json'), 'utf8'));
  assert.deepEqual(selection.selected.filter((entry) => entry.origin === 'product').map((entry) => entry.package), ['expo-document-picker', 'expo-sharing']);
  pkg.dependencies['expo-sharing'] = '^57.0.8';
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const drifted = spawnSync(process.execPath, [script, 'resolve-capabilities', project], { encoding: 'utf8' });
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /expo-sharing must use exact catalog version 57\.0\.8/);
  pkg.dependencies['expo-sharing'] = '57.0.8';
  delete pkg.dependencies['react-native-svg'];
  const unavailable = catalog.unavailable.find((entry) => entry.package === 'react-native-webview');
  pkg.dependencies['react-native-webview'] = unavailable.version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const rejected = spawnSync(process.execPath, [script, 'resolve-capabilities', project], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /fixed scaffold dependency react-native-svg must remain 15\.15\.4/);
  assert.match(rejected.stderr, /react-native-webview.*is unavailable/);
});

test('prepare uses the signing profile bundle identifier when provided by Remote UI', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-signing-bundle-'));
  const project = join(workspace, 'signed-app');
  const request = join(workspace, 'request.md');
  writeFileSync(request, '生成一个待签名的应用。');
  const bundleIdentifier = 'com.example.profile.slot06';

  const prepared = spawnSync(process.execPath, [script, 'prepare', project, request], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPO_FAST_BUNDLE_IDENTIFIER: bundleIdentifier,
      EXPO_FAST_VERSION_CODE: '1000001',
    },
  });

  assert.equal(prepared.status, 0, prepared.stderr);
  const app = JSON.parse(readFileSync(join(project, 'app.json'), 'utf8'));
  assert.equal(app.expo.harmony.bundleIdentifier, bundleIdentifier);
  assert.equal(app.expo.harmony.versionCode, 1000001);
});

test('runtime override dependencies are derived and exact native declarations remain recoverable', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-runtime-override-'));
  const project = join(workspace, 'runtime-app');
  const request = join(workspace, 'request.md');
  writeFileSync(request, '保存离线数据。');
  const prepared = spawnSync(process.execPath, [script, 'prepare', project, request], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const packagePath = join(project, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.dependencies['@react-native-async-storage/async-storage'] = '1.24.0';
  pkg.dependencies['@react-native-oh-tpl/async-storage'] = '1.21.0-0.2.2';
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const resolved = spawnSync(process.execPath, [script, 'resolve-capabilities', project], { encoding: 'utf8' });
  assert.equal(resolved.status, 0, resolved.stderr);
  const selection = JSON.parse(readFileSync(join(project, '.expo-fast/capability-selection.json'), 'utf8'));
  const storage = selection.selected.find((entry) => entry.package === '@react-native-async-storage/async-storage');
  assert.deepEqual(storage.runtimeOverride, {
    nativePackage: '@react-native-oh-tpl/async-storage',
    nativeVersion: '1.21.0-0.2.2',
  });
  assert.deepEqual(selection.runtimeDependencies, {
    '@react-native-oh-tpl/async-storage': '1.21.0-0.2.2',
  });
  assert.equal(selection.selected.some((entry) => entry.package === '@react-native-oh-tpl/async-storage'), false);

  pkg.dependencies['@react-native-oh-tpl/async-storage'] = '1.21.0-0.2.1';
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const drifted = spawnSync(process.execPath, [script, 'resolve-capabilities', project], { encoding: 'utf8' });
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /@react-native-oh-tpl\/async-storage must use exact runtime version 1\.21\.0-0\.2\.2/);
});

test('selected Expo capabilities are synchronized from a compatible dependency cache', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-sync-'));
  const project = join(workspace, 'sync-app');
  const request = join(workspace, 'request.md');
  const cache = join(workspace, 'node_modules-cache');
  writeFileSync(request, '导出 JSON 并从 JSON 文件导入。');
  const prepared = spawnSync(process.execPath, [script, 'prepare', project, request], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const packagePath = join(project, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.dependencies['@react-native-async-storage/async-storage'] = '1.24.0';
  pkg.dependencies['expo-sharing'] = '57.0.8';
  pkg.dependencies['expo-document-picker'] = '57.0.1';
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const cached = {
    '@expo/cli': '57.0.11',
    '@react-native-oh/react-native-harmony': '0.84.2',
    '@react-native-oh/react-native-harmony-cli': '0.84.2',
    '@react-native-async-storage/async-storage': '1.24.0',
    '@react-native-oh-tpl/async-storage': '1.21.0-0.2.2',
    expo: '57.0.9',
    'expo-asset': '57.0.8',
    'expo-constants': '57.0.8',
    'expo-document-picker': '57.0.1',
    'expo-modules-core': '57.0.8',
    'expo-sharing': '57.0.8',
    react: '19.2.3',
    'react-native': '0.84.1',
    'react-native-svg': '15.15.4',
  };
  for (const [name, version] of Object.entries(cached)) {
    const packageRoot = join(cache, ...name.split('/'));
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, version }));
  }
  const env = { ...process.env, EXPO_FAST_MODULE_CACHE: cache };
  const seeded = spawnSync(process.execPath, [dependencyController, 'seed', project], { encoding: 'utf8', env });
  assert.equal(seeded.status, 0, seeded.stderr);
  const synced = spawnSync(process.execPath, [dependencyController, 'sync', project], { encoding: 'utf8', env });
  assert.equal(synced.status, 0, synced.stderr);
  const moduleCache = JSON.parse(readFileSync(join(project, '.expo-fast/module-cache.json'), 'utf8'));
  assert.equal(moduleCache.selectedCapabilities['expo-sharing'], '57.0.8');
  assert.equal(moduleCache.selectedCapabilities['expo-document-picker'], '57.0.1');
  assert.equal(moduleCache.selectedCapabilities['@react-native-async-storage/async-storage'], '1.24.0');
  assert.equal(moduleCache.runtimeDependencies['@react-native-oh-tpl/async-storage'], '1.21.0-0.2.2');
  assert.equal(moduleCache.actualVersions['@react-native-oh-tpl/async-storage'], '1.21.0-0.2.2');
  assert.equal(moduleCache.actualVersions['expo-sharing'], '57.0.8');
});

test('external dependency controller pins the Harmony runtime core without a product cache', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-runtime-pins-'));
  const project = join(workspace, 'app');
  const sdk = join(workspace, 'sdk');
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(join(sdk, 'tools/harmony'), { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { expo: '57.0.9' } }));
  writeFileSync(join(project, '.expo-fast/scaffold-package.json'), JSON.stringify({ dependencies: { expo: '57.0.9' } }));
  writeFileSync(join(sdk, 'tools/harmony/harmony-go-runtime.json'), JSON.stringify({
    runtimeVersion: 'test-runtime',
    packageVersions: { 'expo-asset': '57.0.8', 'expo-constants': '57.0.8', 'expo-modules-core': '57.0.8' },
  }));
  const result = pinRuntimeDependencies(project, sdk);
  assert.deepEqual(result.pins, { 'expo-asset': '57.0.8', 'expo-constants': '57.0.8', 'expo-modules-core': '57.0.8' });
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const scaffold = JSON.parse(readFileSync(join(project, '.expo-fast/scaffold-package.json'), 'utf8'));
  for (const name of ['expo-asset', 'expo-constants', 'expo-modules-core']) {
    assert.equal(pkg.dependencies[name], '57.0.8');
    assert.equal(scaffold.dependencies[name], '57.0.8');
  }
});

test('a stale npm package document retries against the registry instead of failing the run', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-etarget-'));
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  const calls = [];
  const record = (result) => (command, args) => {
    calls.push(args.filter((arg) => arg.startsWith('--prefer-offline')).length > 0);
    return result(args);
  };

  // The common path stays a single --prefer-offline install, so the retry costs
  // nothing when the cache is current.
  const ok = installProjectDependencies(project, 'a.log', {}, record(() => ({ ms: 1, output: '' })));
  assert.deepEqual(calls, [true]);
  assert.equal(ok.ms, 1);

  // npm answered from a package document cached before the pinned version was
  // published, so the version looks nonexistent. Retry without --prefer-offline.
  calls.length = 0;
  let attempt = 0;
  const retried = installProjectDependencies(project, 'b.log', {}, record(() => {
    attempt += 1;
    if (attempt === 1) throw new Error('npm exited 1\nnpm error code ETARGET\nnpm error notarget No matching version found for @expo/cli@57.0.11');
    return { ms: 2, output: 'added 348 packages' };
  }));
  assert.deepEqual(calls, [true, false], 'second attempt drops --prefer-offline');
  assert.equal(retried.output, 'added 348 packages');

  // Any other failure is a real one and must surface unchanged, not be retried.
  calls.length = 0;
  assert.throws(
    () => installProjectDependencies(project, 'c.log', {}, record(() => { throw new Error('npm exited 1\nnpm error code ENOSPC'); })),
    /ENOSPC/,
  );
  assert.deepEqual(calls, [true], 'no retry for unrelated failures');
  rmSync(project, { recursive: true, force: true });
});

test('external dependency controller runs the SDK Harmony overlay from project-installed CLI', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-sdk-cli-'));
  const project = join(workspace, 'app');
  const sdk = join(workspace, 'sdk');
  mkdirSync(join(project, 'node_modules/@expo/cli'), { recursive: true });
  mkdirSync(join(sdk, 'packages/@expo/cli/harmony'), { recursive: true });
  writeFileSync(join(project, 'node_modules/@expo/cli/package.json'), JSON.stringify({ name: '@expo/cli', version: '57.0.11' }));
  writeFileSync(join(sdk, 'packages/@expo/cli/harmony/expo-harmony.mjs'), 'console.log("sdk harmony cli");\n');
  writeFileSync(join(sdk, 'packages/@expo/cli/harmony/harmony-go-runtime.json'), '{}\n');
  const cli = stageHarmonyCli(project, sdk);
  assert.equal(cli, join(project, 'node_modules/@expo/cli/harmony/expo-harmony.mjs'));
  assert.equal(readFileSync(cli, 'utf8'), 'console.log("sdk harmony cli");\n');
  assert.equal(readFileSync(join(project, 'node_modules/@expo/cli/harmony/harmony-go-runtime.json'), 'utf8'), '{}\n');
});

test('external dependency controller CLI synchronizes an already installed exact capability', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-dependency-sync-'));
  const project = join(workspace, 'app');
  const packageContract = { name: 'sync-app', version: '1.0.0', private: true, dependencies: { '@react-native-async-storage/async-storage': '1.24.0', 'react-native-svg': '15.15.4' } };
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(join(project, 'node_modules/@react-native-async-storage/async-storage'), { recursive: true });
  mkdirSync(join(project, 'node_modules/@react-native-oh-tpl/async-storage'), { recursive: true });
  mkdirSync(join(project, 'node_modules/react-native-svg'), { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify(packageContract));
  writeFileSync(join(project, '.expo-fast/scaffold-package.json'), JSON.stringify(packageContract));
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({
    contractsSha256: 'test-contract',
    available: [
      {
        package: '@react-native-async-storage/async-storage',
        version: '1.24.0',
        supportedExports: ['default'],
        runtimeOverride: { nativePackage: '@react-native-oh-tpl/async-storage', nativeVersion: '1.21.0-0.2.2' },
      },
      { package: 'react-native-svg', version: '15.15.4', supportedExports: ['Svg', 'Path'] },
    ],
    unavailable: [],
  }));
  writeFileSync(join(project, 'node_modules/@react-native-async-storage/async-storage/package.json'), JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '1.24.0' }));
  writeFileSync(join(project, 'node_modules/@react-native-oh-tpl/async-storage/package.json'), JSON.stringify({ name: '@react-native-oh-tpl/async-storage', version: '1.21.0-0.2.2' }));
  writeFileSync(join(project, 'node_modules/react-native-svg/package.json'), JSON.stringify({ name: 'react-native-svg', version: '15.15.4' }));
  const controller = join(root, 'scripts/dependencies.mjs');
  const result = spawnSync(process.execPath, [controller, 'sync', project], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.installed, []);
  assert.equal(output.installMs, 0);
  const evidence = JSON.parse(readFileSync(join(project, '.expo-fast/module-cache.json'), 'utf8'));
  assert.deepEqual(evidence.lastSync, { strategy: 'project-npm-install', installMs: 0, installed: [] });
  assert.deepEqual(evidence.runtimeDependencies, { '@react-native-oh-tpl/async-storage': '1.21.0-0.2.2' });
  assert.equal(evidence.actualVersions['@react-native-oh-tpl/async-storage'], '1.21.0-0.2.2');
  assert.equal(evidence.actualVersions['react-native-svg'], '15.15.4');
});

test('single execution policy uses external model controls and caps deterministic repair at 100 attempts', () => {
  const config = JSON.parse(readFileSync(join(root, 'config/execution.json'), 'utf8'));
  // Every window below is the endpoint's measured limit, not the number in the
  // model's name: the k3 model rejects at 262144 (256*1024) and the design model
  // at 1048576 (1024*1024). Rounding either back to a marketing figure gives up
  // real context, and nothing in this repo would report the loss.
  assert.deepEqual(config, {
    schemaVersion: 2,
    roles: {
      main: { model: 'k3-256k', effort: 'low', contextWindowTokens: 262144, disableAdaptiveThinking: false },
      repair: { model: 'k3-256k', effort: 'medium', contextWindowTokens: 262144, disableAdaptiveThinking: false, limit: 100 },
      design: { model: 'deepseek-v4-flash', effort: 'low', contextWindowTokens: 1048576, disableAdaptiveThinking: true, timeoutSeconds: 45 },
      appIcon: {
        model: null, effort: 'low', contextWindowTokens: 262144, disableAdaptiveThinking: true,
        timeoutSeconds: 180, briefTimeoutSeconds: 180, enabled: true,
      },
    },
  });
  assert.equal(existsSync(join(root, 'config/candidates.json')), false);
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /Cold-start experiment integrity forbids/);
  assert.doesNotMatch(runner, /cpSync\(join\(baseProject, 'src'/);
  assert.doesNotMatch(runner, /product-invariants\.md/);
  assert.match(runner, /'--permission-mode', 'dontAsk'/);
  assert.match(runner, /--strict-mcp-config/);
  assert.match(runner, /selfVerify \? 'Read,Write,Edit,mcp__expo_fast__check,mcp__expo_fast__build' : 'Read,Write,Edit'/);
  assert.match(runner, /mcpServers: selfVerify \?/);
  assert.match(runner, /Read\(\.\/App\.tsx\)/);
  assert.match(runner, /Read\(\.\/\.expo-fast\/model-capability-index\.txt\)/);
  assert.doesNotMatch(runner, /Read\(\.\/\.expo-fast\/capability-catalog\.json\)/);
  assert.match(runner, /Write\(\.\/src\/\*\*\)/);
  const verification = readFileSync(join(root, 'scripts/verification.mjs'), 'utf8');
  assert.match(verification, /Deterministic product diagnostics failed/);
  assert.match(runner, /requestSha256/);
  assert.match(runner, /templateAssetSha256/);
  assert.match(runner, /REQUIRED rows are request-matched AVAILABLE capabilities/);
  assert.match(runner, /requiredCapabilities/);
  assert.match(runner, /EXPO_FAST_LIVE_CLAUDE/);
  assert.match(runner, /summarizeClaudeEvent/);
  assert.match(runner, /for \(;;\)/);
  assert.doesNotMatch(runner, /complexityScore|candidates\[mode\]|repairTurns|canRunRepair|repairPolicy/);
  assert.match(runner, /const lines = 10/);
  assert.match(runner, /const execution = \{ model, effort, repairModel, repairEffort, repairLimit \}/);
  assert.match(runner, /repairAttempt >= repairLimit/);
  assert.match(runner, /still failed after \$\{repairLimit\} repair attempts/);
  assert.match(runner, /deterministic gates failed; starting same-session repair \$\{repairAttempt\}/);
  assert.match(runner, /status: metrics\.status/);
  assert.match(runner, /repairArtifactName\('agent-repair-trace'/);
  assert.match(runner, /\[dependencies, 'seed', project\]/);
  assert.match(verification, /\[dependencies, 'sync', project\]/);
  assert.match(verification, /\[dependencies, 'export', project, catalogRoot\]/);
  assert.doesNotMatch(runner, /\[helper, 'seed-modules', project\]/);
  assert.match(runner, /enforcement: 'advisory', blocking: false/);
  assert.match(runner, /trace-scope warning/);
  assert.doesNotMatch(runner, /trace violated the product-agent boundary/);
  assert.match(runner, /Number\(o\.repairTimeoutMinutes \?\? 0\)/);
  assert.doesNotMatch(runner, /repairTimeoutMinutes \|\| 8/);
  assert.match(runner, /timeoutMinutes > 0 \? setTimeout/);
  assert.doesNotMatch(runner, /claudeTimeoutMinutes \|\| 20/);
  assert.match(runner, /resolveExecution\(o\)/);
  const launcher = readFileSync(join(root, 'scripts/start-livetest.mjs'), 'utf8');
  assert.match(launcher, /'--repairLimit', String\(plan\.repairLimit\)/);
  assert.doesNotMatch(runner, /--dangerously-skip-permissions/);
});

test('initial 0-to-1 product prompt remains byte-stable while follow-up tools evolve', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const source = runner.match(/function buildPrompt\(project\) \{[\s\S]*?\n\}\n\nasync function claudeTurn/)?.[0]
    .replace(/\n\nasync function claudeTurn$/, '');
  assert.ok(source, 'buildPrompt source');
  const buildPrompt = Function('readFileSync', 'join', `${source}; return buildPrompt;`)(readFileSync, join);
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-prompt-contract-'));
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  writeFileSync(join(project, '.expo-fast/request.md'), readFileSync(join(root, 'prompts/learning-goals.md')));
  const digest = createHash('sha256').update(buildPrompt(project)).digest('hex');
  // Updated deliberately: the 0-to-1 prompt no longer tells the model to read
  // CONTRACT.md, because its contents now arrive as system prompt. Any other
  // change to this digest is unintended.
  assert.equal(digest, '5306d868709930160898f12ecbeaebc190266571bc0c622cd300758c547fa272');
  rmSync(project, { recursive: true, force: true });
});

test('execution policy resolves explicit overrides and main-turn inheritance centrally', () => {
  assert.deepEqual(resolveExecution({}), {
    model: 'k3-256k', effort: 'low', repairModel: 'k3-256k', repairEffort: 'medium', repairLimit: 100,
  });
  assert.deepEqual(resolveExecution({ model: 'main-model', effort: 'high' }), {
    model: 'main-model', effort: 'high', repairModel: 'main-model', repairEffort: 'high', repairLimit: 100,
  });
  assert.deepEqual(resolveExecution({ model: 'main-model', effort: 'low', repairModel: 'repair-model', repairEffort: 'max' }), {
    model: 'main-model', effort: 'low', repairModel: 'repair-model', repairEffort: 'max', repairLimit: 100,
  });
  assert.throws(() => resolveExecution({ effort: 'automatic' }), /effort must be low, medium, high, or max/);
  assert.throws(() => resolveExecution({ repairLimit: 0 }), /repair limit must be an integer between 1 and 100/);
  assert.throws(() => resolveExecution({ repairLimit: 101 }), /repair limit must be an integer between 1 and 100/);
});

test('every model role resolves from config/execution.json with no code-level default', () => {
  assert.deepEqual(roleNames, ['main', 'repair', 'design', 'appIcon']);

  // A null model in configuration inherits the main role. The rule is code; the
  // name it resolves to is only ever configuration.
  assert.equal(executionConfig.roles.appIcon.model, null);
  assert.equal(resolveRole('appIcon').model, executionConfig.roles.main.model);

  // A command-line --model override must reach the inheriting roles too.
  assert.equal(resolveRole('appIcon', { inheritModel: 'relay-model' }).model, 'relay-model');
  assert.equal(resolveRole('appIcon', { model: 'explicit-model', inheritModel: 'relay-model' }).model, 'explicit-model');
  // design declares its own model, so it never inherits.
  assert.equal(resolveRole('design', { inheritModel: 'relay-model' }).model, executionConfig.roles.design.model);

  // Configuration is reviewed, so its timeout must be in range; a command-line
  // value is documented as capped and therefore clamps instead of throwing.
  assert.equal(resolveRole('design', { timeoutSeconds: 90 }).timeoutSeconds, 55);
  assert.equal(resolveRole('design', { timeoutSeconds: 0 }).timeoutSeconds, 1);
  assert.equal(resolveRole('design').timeoutSeconds, executionConfig.roles.design.timeoutSeconds);

  assert.throws(() => resolveRole('nope'), /unknown execution role: nope/);
  assert.throws(() => resolveRole('design', { effort: 'automatic' }), /design effort must be low, medium, high, or max/);
});

test('an incomplete execution configuration fails loudly instead of falling back', () => {
  const valid = JSON.parse(readFileSync(join(root, 'config/execution.json'), 'utf8'));
  const clone = () => JSON.parse(JSON.stringify(valid));
  assert.deepEqual(validateExecutionConfig(clone()), valid);

  for (const [role, field] of [['main', 'model'], ['repair', 'limit'], ['design', 'timeoutSeconds'], ['appIcon', 'enabled']]) {
    const broken = clone();
    delete broken.roles[role][field];
    assert.throws(() => validateExecutionConfig(broken), new RegExp(`missing roles\\.${role}\\.${field}`));
  }

  const missingRole = clone();
  delete missingRole.roles.design;
  assert.throws(() => validateExecutionConfig(missingRole), /missing roles\.design/);

  const unknownField = clone();
  unknownField.roles.main.temperature = 0.5;
  assert.throws(() => validateExecutionConfig(unknownField), /unknown field roles\.main\.temperature/);

  const unknownRole = clone();
  unknownRole.roles.smoke = { model: 'x' };
  assert.throws(() => validateExecutionConfig(unknownRole), /unknown role: smoke/);

  // The version-1 layout must be rejected with migration guidance, never
  // silently reinterpreted.
  assert.throws(
    () => validateExecutionConfig({ schemaVersion: 1, model: 'k3-256k', effort: 'low', repairModel: 'k3-256k', repairEffort: 'medium', repairLimit: 100 }),
    /schemaVersion must be 2/,
  );
});

test('role environment carries model window and thinking, and no model name survives in code', () => {
  // Both variables are model properties rather than credentials, so they are
  // injected per spawn from configuration instead of living in llm.env.
  assert.deepEqual(roleEnv(resolveRole('design')), {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(executionConfig.roles.design.contextWindowTokens),
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
  });
  assert.equal(roleEnv(resolveRole('main')).CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, '0');
  assert.deepEqual(roleOwnedEnvironmentKeys, ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING']);

  // Regression guard for the failure that started this refactor: a model name
  // hardcoded in a script silently disagrees with the configured endpoint.
  for (const file of ['scripts/run-livetest.mjs', 'scripts/start-livetest.mjs', 'scripts/app-icon.mjs', 'scripts/execution-policy.mjs']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(source, /['"`](haiku|sonnet|opus|k3-256k|deepseek-v4-[a-z]+|glm-[0-9.]+|kimi-for-coding)['"`]/, file);
  }

  // The removed override layer must not come back as a second configuration surface.
  for (const file of ['scripts/run-livetest.mjs', 'scripts/start-livetest.mjs', 'scripts/app-icon.mjs']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(source, /EXPO_FAST_DESIGN_MODEL|EXPO_FAST_DESIGN_TIMEOUT_SECONDS|EXPO_FAST_APP_ICON_(MODEL|EFFORT|ENABLED|TIMEOUT_SECONDS|BRIEF_TIMEOUT_SECONDS)/, file);
  }

  // Every Claude Code spawn must carry its own role environment. A role whose
  // window is not injected silently falls back to the 200k Claude Code assumes
  // for an unrecognized model and auto-compacts the turn.
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const icon = readFileSync(join(root, 'scripts/app-icon.mjs'), 'utf8');
  const spawns = [...runner.matchAll(/spawn\(claude, args, \{[^}]*env: \{([^}]*)\}/g)].map((match) => match[1]);
  assert.equal(spawns.length, 2, 'design and implementation spawns');
  for (const spawnEnv of spawns) assert.match(spawnEnv, /\.\.\.role/);
  assert.match(icon, /env: \{ \.\.\.process\.env, \.\.\.roleEnv\(appIconRole\)/);

  // The launcher's rejection list is duplicated in shell, so assert it still
  // equals the schema it guards. Both files must name the same variables.
  const launcher = readFileSync(join(root, '.local/claude-isolated'), 'utf8');
  const guarded = launcher.match(/^\s*for owned in (.+); do$/m)?.[1].split(/\s+/);
  assert.deepEqual(guarded, roleOwnedEnvironmentKeys);
  // It must inspect llm.env itself, not the resulting environment: the
  // orchestrator injects the same variables and must pass through untouched.
  assert.match(launcher, /grep -qE .* "\$RUNNER_LOCAL\/llm\.env"/);

  // runner/.env and the developer's shell are checked too, so all three
  // configuration files are covered.
  const starter = readFileSync(join(root, 'scripts/start-livetest.mjs'), 'utf8');
  assert.match(starter, /rejectRoleOwnedEnvironment\(\);/);
  assert.match(starter, /roleOwnedEnvironmentKeys\.includes\(key\)/);
});

// Exempt by name rather than by prefix, so that adding a variable forces a
// deliberate decision about which of the three configuration files owns it.
const ENV_OWNED_ELSEWHERE = [
  // .local/llm.env owns the endpoint and its credentials.
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  // config/execution.json owns these; the launcher and starter both reject them.
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  // Supplied by the operating system.
  'PATH', 'HOME', 'PWD', 'SHELL', 'TERM', 'TMPDIR', 'USER',
];

function environmentNamesReadByRunner() {
  const names = new Set();
  for (const file of readdirSync(join(root, 'scripts')).filter((name) => name.endsWith('.mjs'))) {
    const source = readFileSync(join(root, 'scripts', file), 'utf8');
    // Both spellings are in use: run-livetest reads process.env.X while
    // hdc-target destructures and reads env.X throughout.
    for (const [, name] of source.matchAll(/(?:process\.env|env)\.([A-Z_][A-Z0-9_]*)/g)) names.add(name);
  }
  // Several settings are read only by shell: setup-harmony-pool.sh resolves the
  // pool, and claude-isolated resolves the real executable.
  const shellFiles = [
    ...readdirSync(root).filter((name) => name.endsWith('.sh')).map((name) => join(root, name)),
    join(root, '.local/claude-isolated'),
  ];
  for (const path of shellFiles) {
    const source = readFileSync(path, 'utf8');
    const local = new Set([
      ...[...source.matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]),
      ...[...source.matchAll(/^\s*for ([A-Za-z_][A-Za-z0-9_]*) in/gm)].map((match) => match[1]),
    ]);
    for (const [, name] of source.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)[:}\s"]/g)) {
      if (!local.has(name)) names.add(name);
    }
  }
  return names;
}

test('the product contract is injected, not inherited from a CLAUDE.md walk', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const icon = readFileSync(join(root, 'scripts/app-icon.mjs'), 'utf8');

  // The contract reaches the implementation and repair turns as system prompt.
  // Relying on the model to read the contract, or on Claude Code loading a
  // project CLAUDE.md, leaves it optional; passing the file does not. The
  // contract is deliberately not named CLAUDE.md or AGENTS.md so that no
  // Claude Code session auto-loads it as its own working instructions.
  assert.match(runner, /'--append-system-prompt-file', join\(project, 'CONTRACT\.md'\)/);
  assert.match(runner, /writeFileSync\(join\(project, 'CONTRACT\.md'\)/, 'the injected file is still written');
  assert.doesNotMatch(runner, /join\(project, 'CLAUDE\.md'\)/, 'the generated project carries no CLAUDE.md of its own');

  // Every Claude Code spawn stops walking up for CLAUDE.md. Generated projects
  // live under the repository, so that walk reached every ancestor's file.
  const spawns = [
    ...[...runner.matchAll(/spawn\(claude, args, \{[^}]*env: \{([^}]*)\}/g)].map((match) => match[1]),
    icon.slice(icon.indexOf('env: { ...process.env, ...roleEnv(appIconRole)')).split('\n')[0],
  ];
  assert.equal(spawns.length, 3, 'design, implementation, and app icon');
  // The design turn assembles its environment through designTurnInvocation, so
  // it is checked by value here rather than by searching for a literal nearby --
  // a stronger guarantee than the two spawns that still spell it out inline.
  const designInvocation = designTurnInvocation(resolveRole('design'), 'prompt');
  assert.equal(designInvocation.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(designInvocation.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(executionConfig.roles.design.contextWindowTokens));
  const spelledOut = spawns.filter((spawnEnv) => /CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1'/.test(spawnEnv));
  assert.equal(spelledOut.length, 2, 'implementation and app icon still spell it out at the spawn');

  // The design turn starts before the project exists, and its prompt is
  // self-contained, so it must not be given the file.
  const designSpawn = runner.slice(runner.indexOf('async function designTurn'), runner.indexOf('async function claudeTurn'));
  assert.doesNotMatch(designSpawn, /append-system-prompt-file/);
  assert.ok(
    runner.indexOf('const designPromise = designTurn') < runner.indexOf("writeFileSync(join(project, 'CONTRACT.md')"),
    'design starts before CONTRACT.md is written',
  );
  assert.doesNotMatch(icon, /append-system-prompt-file/);
});

test('model preflight reads only a local cache and never the network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'expo-fast-preflight-'));
  const llmEnvPath = join(dir, 'llm.env');
  const cachePath = join(dir, 'models-cache.json');
  const paths = { llmEnvPath, cachePath };
  writeFileSync(llmEnvPath, 'export ANTHROPIC_BASE_URL="https://relay.example"\n');
  const { mtimeMs, size } = statSync(llmEnvPath);
  const llmEnvMtimeMs = Math.trunc(mtimeMs);
  const llmEnvSize = size;
  const served = [executionConfig.roles.main.model, executionConfig.roles.design.model, 'other-model'];

  // No cache is the first-run state. It must not fail and must not fetch.
  assert.equal(readModelCache(paths).status, 'absent');
  assert.deepEqual(verifyConfiguredModels({}, paths).verified, false);
  assert.match(verifyConfiguredModels({}, paths).notice, /no model cache/);

  const writeCache = (extra = {}) => writeFileSync(cachePath, JSON.stringify({
    schemaVersion: 2, llmEnvMtimeMs, llmEnvSize, fetchedAt: '2026-08-22T00:00:00.000Z',
    claudeCodeVersion: '2.1.241', models: Object.fromEntries(served.map((model) => [model, {}])), ...extra,
  }));
  writeCache();
  assert.equal(readModelCache(paths).status, 'fresh');
  const fresh = verifyConfiguredModels({}, paths);
  assert.equal(fresh.verified, true);
  assert.deepEqual(fresh.models, [...new Set(served)]);

  // How old a measurement is travels with the answer instead of being enforced.
  // An age threshold would be a number invented rather than measured, and it
  // cannot see the thing that actually matters: whether the endpoint changed.
  assert.equal(readModelCache(paths, Date.parse('2026-08-27T00:00:00.000Z')).measuredDaysAgo, 5);
  assert.equal(fresh.claudeCodeVersion, '2.1.241');

  // A cache written before the current schema is outdated, not corrupt. It
  // degrades to unverified with its own reason, so that "refresh it" is
  // distinguishable from "something is wrong with this file".
  writeFileSync(cachePath, JSON.stringify({ schemaVersion: 1, llmEnvMtimeMs, llmEnvSize, fetchedAt: '2026-08-22T00:00:00.000Z', models: served }));
  assert.equal(readModelCache(paths).status, 'outdated');
  assert.match(verifyConfiguredModels({}, paths).notice, /predates the current schema/);
  writeCache();

  // A model the endpoint does not serve is the error this exists to catch.
  assert.throws(
    () => verifyConfiguredModels({ model: 'absent-model' }, paths),
    /names models this endpoint does not serve: main=absent-model/,
  );

  // Editing llm.env may have changed the endpoint, so the cache can no longer
  // be trusted. Report it and continue; do not fetch and do not fail. Rewriting
  // within the same millisecond leaves mtime unchanged, which is why the
  // fingerprint carries size too.
  writeFileSync(llmEnvPath, 'export ANTHROPIC_BASE_URL="https://a-different-relay.example"\n');
  const stale = verifyConfiguredModels({}, paths);
  assert.equal(stale.verified, false);
  assert.match(stale.notice, /llm\.env changed/);

  // Corrupt or foreign cache content degrades the same way.
  writeFileSync(cachePath, 'not json');
  assert.equal(readModelCache(paths).status, 'unreadable');
  writeFileSync(cachePath, JSON.stringify({ schemaVersion: 2, llmEnvMtimeMs, llmEnvSize, models: served }));
  assert.equal(readModelCache(paths).status, 'unreadable', 'schema 2 keys models by name');
  rmSync(dir, { recursive: true, force: true });

  // The budget for starting a run is a few milliseconds and one round trip to
  // this relay measured 1.5-2.0s, so the read path must contain no network
  // call at all. Fetching happens only through the launcher, out of band.
  const preflight = readFileSync(join(root, 'scripts/preflight-models.mjs'), 'utf8');
  const readPath = preflight.slice(
    preflight.indexOf('function fingerprintLlmEnv'),
    preflight.indexOf('// Fetch through the launcher'),
  );
  assert.ok(readPath.includes('export function verifyConfiguredModels'), 'read path located');
  assert.doesNotMatch(readPath, /fetch\(|https?:\/\/|spawnSync|execSync|curl/);
  assert.match(preflight, /spawnSync\(claudeBin, \['--genius-list-models'\]/);
  const launcher = readFileSync(join(root, '.local/claude-isolated'), 'utf8');
  assert.match(launcher, /--genius-list-models/);

  // Raw completion mode exists so the offline probes can measure what this
  // endpoint does with a field rather than trust what the field is called, and
  // its one non-obvious property is that it must not use curl -f. A rejected
  // request is the measurement: an over-long request comes back as HTTP 401 on
  // one model and 400 on another, and the real context limit is in the error
  // body that -f would discard. It stays out of band for the same reason the
  // model list does, so no run path may reach it.
  const completionMode = launcher.match(/--genius-completion" \]; then\n([\s\S]*?)\nfi\n/)?.[1];
  assert.ok(completionMode, 'raw completion mode located');
  assert.match(completionMode, /\/v1\/messages/);
  assert.match(completionMode, /--data-binary @-/);
  assert.doesNotMatch(completionMode, /curl -\S*f/);
  for (const file of ['scripts/run-livetest.mjs', 'scripts/start-livetest.mjs', 'scripts/app-icon.mjs']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /--genius-completion/, file);
  }
});

test('.env.example documents exactly the machine settings the runner reads', () => {
  const documented = new Set(
    [...readFileSync(join(root, '.env.example'), 'utf8').matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]),
  );
  const read = environmentNamesReadByRunner();
  const exempt = new Set(ENV_OWNED_ELSEWHERE);

  const undocumented = [...read].filter((name) => !documented.has(name) && !exempt.has(name)).sort();
  assert.deepEqual(undocumented, [], 'read by the runner but absent from .env.example');

  // The reverse direction catches a setting that was documented and then
  // disconnected, which advertises a knob that silently does nothing.
  const unread = [...documented].filter((name) => !read.has(name)).sort();
  assert.deepEqual(unread, [], 'documented in .env.example but never read');

  // The scan above is textual, so it is complete only while every read uses a
  // literal name. Fail if a dynamic lookup appears and invalidates that.
  for (const file of readdirSync(join(root, 'scripts')).filter((name) => name.endsWith('.mjs'))) {
    const source = readFileSync(join(root, 'scripts', file), 'utf8');
    assert.doesNotMatch(source, /(?:process\.env|[^A-Za-z_]env)\[/, `${file} reads the environment dynamically`);
  }
});

test('repair artifacts give every retry separate evidence', () => {
  assert.equal(repairArtifactName('agent-repair-trace', 1, '.jsonl'), 'agent-repair-trace.jsonl');
  assert.equal(repairArtifactName('agent-repair-trace', 2, '.jsonl'), 'agent-repair-trace-2.jsonl');
  assert.throws(() => repairArtifactName('agent-repair-trace', 0, '.jsonl'), /invalid repair attempt/);
});

test('trace analyzer includes every numbered repair trace in attempt order', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-multi-repair-trace-'));
  const traceDir = join(project, '.expo-fast');
  mkdirSync(traceDir, { recursive: true });
  const resultRow = (duration) => `${JSON.stringify({ type: 'result', duration_ms: duration, num_turns: 1, modelUsage: {} })}\n`;
  writeFileSync(join(traceDir, 'agent-trace.jsonl'), resultRow(100));
  writeFileSync(join(traceDir, 'agent-repair-trace.jsonl'), resultRow(200));
  writeFileSync(join(traceDir, 'agent-repair-trace-2.jsonl'), resultRow(300));
  const analyzed = spawnSync(process.execPath, [join(root, 'scripts/analyze-trace.mjs'), project], { encoding: 'utf8' });
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const report = JSON.parse(analyzed.stdout);
  assert.deepEqual(report.traces.map((trace) => basename(trace.path)), ['agent-trace.jsonl', 'agent-repair-trace.jsonl', 'agent-repair-trace-2.jsonl']);
  assert.deepEqual(report.traces.map((trace) => trace.apiDurationMs), [100, 200, 300]);
});

test('runner and starter encode the logical-width three-device contract', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /useWindowDimensions\(\)\.width as logical layout width/);
  assert.match(runner, /phone <640, tablet 640–1279, and desktop >=1280/);
  assert.match(runner, /siblings inside the same horizontal root container/);
  assert.match(runner, /about 48% basis/);
  assert.match(runner, /Do not invent tabs for a single-destination app/);

  const starter = readFileSync(join(root, 'templates/expo-harmony/src/app-shell.tsx'), 'utf8');
  assert.match(starter, /width >= 1280/);
  assert.match(starter, /width >= 640 && width < 1280/);
  assert.doesNotMatch(starter, /width >= 1000/);
  assert.match(starter, /<View style=\{\[styles\.frame, isDesktop && styles\.desktopFrame\]\}>\{isDesktop && navigation\}<View style=\{styles\.main\}>/);
  assert.doesNotMatch(starter, /\{isDesktop && navigation\}<View style=\{styles\.frame\}>/);
  assert.match(starter, /desktopList: \{ flexDirection: 'row', flexWrap: 'wrap' \}/);
  assert.match(starter, /desktopListCard: \{ flexBasis: '48%', flexGrow: 0, maxWidth: '48%' \}/);
});

test('starter and model contract use Harmony-safe Path-only icon geometry', () => {
  const icons = readFileSync(join(root, 'templates/expo-harmony/src/components/icons.tsx'), 'utf8');
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(icons, /import Svg, \{ Path \} from 'react-native-svg'/);
  assert.doesNotMatch(icons, /<(?:Circle|Line|Polyline|Rect|Polygon)\b/);
  assert.equal([...icons.matchAll(/export const \w+Icon = icon\(/g)].length, 17);
  assert.match(runner, /Production icons must be Path-only/);
});

test('candidate CLI is removed instead of silently selecting an execution path', () => {
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const result = spawnSync(process.execPath, [launcher, '--dry-run', '--candidate', 'repair', '--launch', 'false'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option: --candidate/);
});

function writeEvidence(project, category = 'form-submit') {
  const smoke = join(project, '.expo-fast/smoke');
  mkdirSync(smoke, { recursive: true });
  writeFileSync(join(project, '.expo-fast/manifest.json'), JSON.stringify({ id: 'test-ledger' }));
  const root = (text) => ({ children: [{ attributes: { bundleName: 'com.example.myapplication1.ide', type: 'root' }, children: [{ attributes: { id: harmonyGoActiveMiniAppNodeId('test-ledger'), type: 'Text', text: '家庭账本', bounds: '[38,130][260,179]', visible: 'true' } }, { attributes: { id: 'home-month-expense', type: 'Custom', bounds: '[40,400][900,500]', visible: 'true' }, children: [{ attributes: { text } }] }] }] });
  writeFileSync(join(smoke, 'layout-before.json'), JSON.stringify(root('本月支出 100 元')));
  writeFileSync(join(smoke, 'layout-after.json'), JSON.stringify(root('本月支出 188.8 元')));
  writeFileSync(join(smoke, 'layout-restarted.json'), JSON.stringify(root('本月支出 188.8 元')));
  writeFileSync(join(smoke, 'screenshot.jpeg'), 'jpeg');
  writeFileSync(join(smoke, 'action.json'), JSON.stringify({ result: 'PASS', manifestId: 'test-ledger', identityNode: { before: 'test-ledger', after: 'test-ledger', restarted: 'test-ledger' }, action: { category, steps: ['输入 88.8', '保存'] }, assertion: { target: 'home-month-expense', before: '本月支出 100 元', after: '本月支出 188.8 元', restarted: '本月支出 188.8 元' } }));
}

test('smoke validator accepts core data mutation with exact app identity', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-smoke-'));
  writeEvidence(project);
  assert.equal(validateSmoke(project).category, 'form-submit');
});

test('smoke validator rejects navigation-only evidence', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-smoke-'));
  writeEvidence(project, 'navigation');
  assert.throws(() => validateSmoke(project), /non-navigation state change/);
});

test('exact-app identity rejects a listed app when another app is current', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-smoke-wrong-app-'));
  writeEvidence(project);
  const smoke = join(project, '.expo-fast/smoke');
  const wrong = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide', type: 'root' }, children: [
    { attributes: { id: harmonyGoActiveMiniAppNodeId('other-current-app'), type: 'Text', text: '家庭账本', bounds: '[38,130][300,179]', visible: 'true' } },
    { attributes: { id: harmonyGoCatalogMiniAppNodeId('test-ledger'), type: 'Button', text: '家庭账本', bounds: '[900,220][1200,292]', visible: 'true', backgroundColor: '#FFEAECF0' } },
    { attributes: { id: 'home-month-expense', type: 'Custom', bounds: '[40,400][900,500]', visible: 'true' }, children: [{ attributes: { text: '本月支出 100 元' } }] },
  ] }] };
  writeFileSync(join(smoke, 'layout-before.json'), JSON.stringify(wrong));
  assert.throws(() => validateSmoke(project), /active mini-app id is not exactly test-ledger/);
});

test('exact-app identity locates the Host identity on high-density layouts', async () => {
  const { inspectCurrentMiniApp } = await import('../scripts/layout-identity.mjs');
  const layout = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide' }, children: [
    { attributes: { type: 'Text', text: 'EXPO HARMONY GO', bounds: '[67,175][550,222]', visible: 'true' } },
    { attributes: { id: harmonyGoActiveMiniAppNodeId('test-ledger'), type: 'Text', text: '家庭账本', bounds: '[67,232][1184,493]', visible: 'true' } },
    { attributes: { type: 'Button', text: '项目', bounds: '[67,566][263,694]', visible: 'true' } },
    { attributes: { type: 'Custom', id: 'ledger-summary', bounds: '[40,900][900,1000]', visible: 'true' } },
    { attributes: { type: 'Text', text: '家庭账本', bounds: '[316,1991][951,2180]', visible: 'true' } },
  ] }] };
  const identity = inspectCurrentMiniApp(layout, 'test-ledger', ['ledger-summary']);
  assert.equal(identity.ok, true);
  assert.equal(identity.currentProjectBounds, '[67,232][1184,493]');
});

test('exact-app identity rejects a visible runtime error overlay', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-smoke-crash-'));
  writeEvidence(project);
  const smoke = join(project, '.expo-fast/smoke');
  const before = JSON.parse(readFileSync(join(smoke, 'layout-before.json'), 'utf8'));
  before.children[0].children.push({ attributes: { type: 'Text', text: "Error: Cannot find native module 'ExpoCryptoAES'", visible: 'true', bounds: '[0,200][1200,700]' } });
  writeFileSync(join(smoke, 'layout-before.json'), JSON.stringify(before));
  assert.throws(() => validateSmoke(project), /visible runtime error overlay/);
});

test('cold-start trace scope rejects sibling source reads and shell escape', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-trace-scope-'));
  const project = join(workspace, 'fresh-app');
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  const trace = join(project, '.expo-fast/agent-trace.jsonl');
  const row = (parts) => JSON.stringify({ type: 'assistant', message: { content: parts } });
  writeFileSync(trace, [
    row([{ type: 'tool_use', name: 'Read', input: { file_path: join(project, 'src/app.tsx') } }]),
    row([{ type: 'tool_use', name: 'Read', input: { file_path: join(workspace, 'old-app/src/app.tsx') } }]),
    row([{ type: 'tool_use', name: 'Glob', input: { pattern: '../old-app/src/**' } }]),
    row([{ type: 'tool_use', name: 'Bash', input: { command: 'ls ../old-app' } }]),
  ].join('\n'));
  const audit = auditImplementationTrace(project, trace);
  assert.equal(audit.status, 'fail');
  assert.ok(audit.violations.some((entry) => entry.type === 'outside-project-read'));
  assert.ok(audit.violations.some((entry) => entry.type === 'outside-project-glob'));
  assert.ok(audit.violations.some((entry) => entry.type === 'forbidden-shell-tool'));
});

test('cold-start trace scope accepts whitelisted native file tools and rejects escaped paths', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-trace-batch-'));
  const project = join(workspace, 'fresh-app');
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  const trace = join(project, '.expo-fast/agent-trace.jsonl');
  const row = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  writeFileSync(trace, [
    row('Read', { file_path: 'App.tsx' }),
    row('Read', { file_path: '.expo-fast/model-capability-index.txt' }),
    row('Write', { file_path: 'App.tsx', content: 'export default null' }),
    row('Write', { file_path: 'src/store.ts', content: 'export {}' }),
    row('Edit', { file_path: 'package.json', old_string: '{}', new_string: '{"dependencies":{}}' }),
    row('mcp__expo_fast__check', {}),
    row('mcp__expo_fast__build', {}),
  ].join('\n'));
  assert.equal(auditImplementationTrace(project, trace).status, 'pass');

  writeFileSync(trace, row('Write', { file_path: '../old-app/src/App.tsx', content: 'stolen' }));
  const escaped = auditImplementationTrace(project, trace);
  assert.equal(escaped.status, 'fail');
  assert.ok(escaped.violations.some((entry) => entry.type === 'outside-project-read'));
});

test('cold-start trace scope records permission-blocked outside reads without treating them as leakage', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-trace-denied-'));
  const project = join(workspace, 'fresh-app');
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  const trace = join(project, '.expo-fast/agent-trace.jsonl');
  const toolUseId = 'blocked-read';
  writeFileSync(trace, [
    JSON.stringify({ type: 'assistant', message: { content: [{ id: toolUseId, type: 'tool_use', name: 'Read', input: { file_path: join(workspace, 'old-app/App.tsx') } }] } }),
    JSON.stringify({ type: 'result', permission_denials: [{ tool_name: 'Read', tool_use_id: toolUseId, tool_input: { file_path: join(workspace, 'old-app/App.tsx') } }] }),
  ].join('\n'));
  const audit = auditImplementationTrace(project, trace);
  assert.equal(audit.status, 'pass');
  assert.equal(audit.blockedAttemptCount, 1);
});

test('source audit enforces native persistence and inline SVG contracts', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-audit-'));
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, '.expo-fast/request.md'), '四个 Tab：今日、看板、周报、我的。使用 inline SVG 图标和图表，所有输入即时保存到 localStorage。导出 JSON 和导入。今日建议量、预计完成日、休息日、补记、逾期目标、环比、保持、问题、尝试、下周预案、清空全部、添加到手机主屏幕。');
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({ available: [{ package: 'react-native-svg', supportedExports: ['Path', 'Rect'] }, { package: '@react-native-async-storage/async-storage', supportedExports: [] }, { package: 'expo-sharing', supportedExports: ['shareAsync'] }, { package: 'expo-document-picker', supportedExports: ['getDocumentAsync'] }] }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { 'react-native-svg': '15.15.4', '@react-native-async-storage/async-storage': '1.24.0', 'expo-sharing': '57.0.8', 'expo-document-picker': '57.0.1' } }));
  writeFileSync(join(project, 'app.json'), JSON.stringify({ expo: { slug: 'audit-app' } }));
  writeFileSync(join(project, 'App.tsx'), `import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Path, Rect } from 'react-native-svg';
import { shareAsync } from 'expo-sharing';
import { getDocumentAsync } from 'expo-document-picker';
export default function App(){ AsyncStorage.getItem('x'); AsyncStorage.setItem('x','{}'); void shareAsync('data:application/json,{}'); void getDocumentAsync({ type: 'application/json' }); return <Svg testID="app"><Path d="M0 0"/><Rect testID="chart"/><Path testID="today"/><Path testID="board"/><Path testID="weekly"/><Path testID="mine"/></Svg> }
const copy = 'audit-app 今日 看板 周报 我的 今日建议 预计完成 休息日 补记 逾期 环比 保持 问题 尝试 下周预案 导出 导入 清空 主屏幕';`);
  assert.equal(auditProductSource(project).status, 'pass');
  writeFileSync(join(project, 'App.tsx'), `export default function App(){ return null }`);
  const failed = auditProductSource(project);
  assert.equal(failed.status, 'fail');
  assert.ok(failed.errors.some((error) => error.includes('AsyncStorage')));
  assert.ok(failed.errors.some((error) => error.includes('inline SVG')));
  assert.ok(failed.errors.some((error) => error.includes('JSON export')));
  assert.ok(failed.errors.some((error) => error.includes('JSON import')));
});

test('source audit rejects mixed direct SVG shapes in the production icon module', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-icon-audit-'));
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(join(project, 'src/components'), { recursive: true });
  writeFileSync(join(project, '.expo-fast/request.md'), '使用 inline SVG 图标。');
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({ available: [{ package: 'react-native-svg', supportedExports: ['Path', 'Circle'] }] }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { 'react-native-svg': '15.15.4' } }));
  writeFileSync(join(project, 'app.json'), JSON.stringify({ expo: { slug: 'icon-audit' } }));
  writeFileSync(join(project, 'App.tsx'), `import { LocalIcon } from './src/components/icons'; export default function App(){ return <><LocalIcon testID="app"/><LocalIcon testID="summary"/></> }`);
  writeFileSync(join(project, 'src/components/icons.tsx'), `import Svg, { Circle } from 'react-native-svg'; export function LocalIcon(props: { testID?: string }) { return <Svg testID={props.testID ?? 'app'}><Circle cx={12} cy={12} r={8}/></Svg> }`);
  const failed = auditProductSource(project);
  assert.equal(failed.status, 'fail');
  assert.ok(failed.errors.some((error) => error.includes('Path-only production icon geometry')));

  writeFileSync(join(project, 'src/components/icons.tsx'), `import Svg, { Path } from 'react-native-svg'; export function LocalIcon(props: { testID?: string }) { return <Svg testID={props.testID ?? 'app'}><Path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></Svg> }`);
  assert.equal(auditProductSource(project).status, 'pass');
});

test('source audit rejects named exports absent from the selected catalog', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-export-audit-'));
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, '.expo-fast/request.md'), 'Create a state-changing app.');
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({ available: [{ package: 'expo-linear-gradient', supportedExports: ['LinearGradient'] }] }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { 'expo-linear-gradient': '57.0.1' } }));
  writeFileSync(join(project, 'app.json'), JSON.stringify({ expo: { slug: 'export-audit' } }));
  writeFileSync(join(project, 'App.tsx'), `import { UnsupportedGradient } from 'expo-linear-gradient'; export default function App(){ return <UnsupportedGradient testID="first" testID2="second"/> }`);
  const failed = auditProductSource(project);
  assert.ok(failed.errors.some((error) => error.includes('unsupported expo-linear-gradient export UnsupportedGradient')));
});

test('source audit rejects obsolete multi-device breakpoints and detached desktop navigation', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-responsive-audit-'));
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, '.expo-fast/request.md'), '手机使用底部导航和单列，平板使用顶部横向导航，电脑使用左侧固定边栏与多栏布局。');
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({ available: [] }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: {} }));
  writeFileSync(join(project, 'app.json'), JSON.stringify({ expo: { slug: 'responsive-audit' } }));
  writeFileSync(join(project, 'App.tsx'), `import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
export default function App(){ const { width } = useWindowDimensions(); const isDesktop = width >= 1000; const navigation = <Text>导航</Text>; return <>{isDesktop && navigation}<View style={styles.frame} testID="app-shell"><Text testID="summary">内容</Text></View></> }
const styles = StyleSheet.create({ frame: { flex: 1, flexDirection: 'row' }, cards: { flexWrap: 'wrap' }, card: { width: '48%' } });`);
  const failed = auditProductSource(project);
  assert.equal(failed.status, 'fail');
  assert.ok(failed.errors.some((error) => error.includes('breakpoint 1280')));
  assert.ok(failed.errors.some((error) => error.includes('before/outside the layout frame')));

  writeFileSync(join(project, 'App.tsx'), `import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
export default function App(){ const { width } = useWindowDimensions(); const isDesktop = width >= 1280; const isTablet = width >= 640 && width < 1280; const navigation = <Text>导航</Text>; return <View onLayout={(event) => event.nativeEvent.layout.width} style={[styles.frame, isDesktop && styles.desktopFrame]} testID="app-shell">{isDesktop && navigation}<View style={styles.main}>{isTablet && navigation}<View style={[styles.cards, isDesktop && styles.desktopCards]}><Text testID="summary">内容</Text></View>{!isDesktop && !isTablet && navigation}</View></View> }
const styles = StyleSheet.create({ frame: { flex: 1 }, desktopFrame: { flexDirection: 'row' }, main: { flex: 1 }, cards: { flex: 1 }, desktopCards: { flexDirection: 'row', flexWrap: 'wrap' }, card: { flexBasis: '48%', flexGrow: 0, maxWidth: '48%' } });`);
  assert.equal(auditProductSource(project).status, 'pass');
});

test('artifact evidence binds runtime, manifest, bundle hash, and source digest', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-artifacts-'));
  const output = join(project, 'dist/harmony-go');
  const miniapp = join(output, 'miniapps/test-app');
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(miniapp, { recursive: true });
  const runtimeVersion = 'expo-57.0.9+rnoh-0.84.2+harmony-api-22+go-3';
  const bundle = 'business bundle';
  const bundleHash = createHash('sha256').update(bundle).digest('hex');
  const icon = 'published icon png';
  const iconHash = createHash('sha256').update(icon).digest('hex');
  const iconDescriptor = { path: '__expo_harmony_go__/icon.png', url: '/miniapps/test-app/assets/__expo_harmony_go__/icon.png', bytes: Buffer.byteLength(icon), sha256: iconHash };
  const iconInfo = { type: 'single', image: iconDescriptor };
  writeFileSync(join(output, 'runtime.json'), JSON.stringify({ runtimeVersion }));
  writeFileSync(join(output, 'catalog.json'), JSON.stringify([{ id: 'test-app', manifestUrl: '/miniapps/test-app/manifest.json', icon: iconInfo }]));
  writeFileSync(join(miniapp, 'bundle.js'), bundle);
  mkdirSync(join(miniapp, 'assets/__expo_harmony_go__'), { recursive: true });
  writeFileSync(join(miniapp, 'assets/__expo_harmony_go__/icon.png'), icon);
  writeFileSync(join(miniapp, 'manifest.json'), JSON.stringify({ id: 'test-app', runtimeVersion, bundle: { url: '/miniapps/test-app/bundle.js', sha256: bundleHash }, icon: iconInfo, assets: [iconDescriptor] }));
  writeFileSync(join(project, '.expo-fast/sdk-fingerprint.json'), JSON.stringify({ runtimeVersion }));
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({ available: [] }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: {} }));
  writeFileSync(join(project, 'app.json'), JSON.stringify({ expo: { icon: './assets/app-icon/icon.png' } }));
  writeFileSync(join(project, '.expo-fast/source-audit.json'), JSON.stringify({ status: 'pass', productInputSha256: 'source-digest', imports: [] }));
  const passed = verifyHarmonyGoArtifacts(project, output);
  assert.equal(passed.status, 'pass');
  assert.equal(passed.artifacts[0].sha256, bundleHash);
  assert.deepEqual(passed.artifacts[0].icon, iconInfo);
  assert.equal(passed.productInputSha256, 'source-digest');
  writeFileSync(join(miniapp, 'assets/__expo_harmony_go__/icon.png'), 'tampered icon');
  assert.equal(verifyHarmonyGoArtifacts(project, output).status, 'fail');
  writeFileSync(join(miniapp, 'assets/__expo_harmony_go__/icon.png'), icon);
  writeFileSync(join(miniapp, 'bundle.js'), 'tampered');
  assert.equal(verifyHarmonyGoArtifacts(project, output).status, 'fail');
});

function poolSetupFixture(label) {
  const workspace = mkdtempSync(join(tmpdir(), `expo-fast-pool-setup-${label}-`));
  const bin = join(workspace, 'bin');
  const sdk = join(workspace, 'sdk');
  mkdirSync(join(sdk, 'tools/harmony'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  // A Node copy whose directory holds no Corepack, so ${NODE_RUNTIME:h}/corepack misses.
  writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  chmodSync(join(bin, 'node'), 0o755);
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@expo/expo', packageManager: 'pnpm@10.33.0' }));
  // The pool entrypoint must exist but does nothing; this test only covers bootstrapping.
  writeFileSync(join(sdk, 'tools/harmony/full-profile-pool.mjs'), 'process.exit(0);\n');
  const recorder = join(workspace, 'pnpm-invocation.txt');
  const fakePnpm = join(bin, 'pnpm');
  writeFileSync(fakePnpm, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${recorder}\nexit 0\n`);
  chmodSync(fakePnpm, 0o755);
  return { workspace, bin, sdk, recorder, fakePnpm };
}

function runPoolSetup(fixture, { path, extraEnv = {} } = {}) {
  return spawnSync(join(root, 'setup-harmony-pool.sh'), ['--no-warm'], {
    encoding: 'utf8',
    env: {
      HOME: fixture.workspace,
      PATH: path ?? `${fixture.bin}:/usr/bin:/bin`,
      EXPO_FAST_ENV_FILE: join(fixture.workspace, 'missing.env'),
      EXPO_FAST_NODE: join(fixture.bin, 'node'),
      EXPO_HARMONY_SDK_ROOT: fixture.sdk,
      EXPO_HARMONY_POOL_ROOT: join(fixture.workspace, 'pool'),
      EXPO_HARMONY_POOL_SIZE: '1',
      ...extraEnv,
    },
  });
}

test('pool setup bootstraps SDK dependencies through a pnpm on PATH when Corepack is absent', { skip: !existsSync('/bin/zsh') }, () => {
  const fixture = poolSetupFixture('path-pnpm');
  try {
    const result = runPoolSetup(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Corepack was not found beside Node/);
    const invocation = readFileSync(fixture.recorder, 'utf8');
    assert.match(invocation, /install --frozen-lockfile --ignore-scripts --filter @expo\/expo/);
    assert.match(invocation, new RegExp(fixture.fakePnpm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test('pool setup prefers an explicit EXPO_HARMONY_PNPM_BIN over PATH discovery', { skip: !existsSync('/bin/zsh') }, () => {
  const fixture = poolSetupFixture('explicit-bin');
  const override = join(fixture.workspace, 'custom-pnpm');
  const overrideRecorder = join(fixture.workspace, 'override-invocation.txt');
  writeFileSync(override, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${overrideRecorder}\nexit 0\n`);
  chmodSync(override, 0o755);
  try {
    const result = runPoolSetup(fixture, { extraEnv: { EXPO_HARMONY_PNPM_BIN: override } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(overrideRecorder), true, 'the override was not used');
    assert.equal(existsSync(fixture.recorder), false, 'the PATH pnpm should not run');
    assert.match(readFileSync(overrideRecorder, 'utf8'), /install --frozen-lockfile --ignore-scripts --filter @expo\/expo/);
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test('pool setup reports every supported pnpm source when none is available', { skip: !existsSync('/bin/zsh') }, () => {
  const fixture = poolSetupFixture('no-runner');
  rmSync(fixture.fakePnpm, { force: true });
  try {
    // An empty PATH leaves no corepack, pnpm, or npm to fall back to.
    const result = runPoolSetup(fixture, { path: join(fixture.workspace, 'empty') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no pnpm runner was found/);
    assert.match(result.stderr, /EXPO_HARMONY_PNPM_BIN/);
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test('a direct-HAP preview proves the foreground app is this build, not a previous one wearing the bundle name', () => {
  // Device-measured shape: uitest dumpLayout carries a React Native testID on both
  // `id` and `key`, keeps a 1x1 absolutely positioned node, and reports it visible.
  const stamped = (stamp) => ({ children: [{
    attributes: { bundleName: 'com.genius.pomodoro.04', type: 'root' },
    children: [
      { attributes: { id: 'timer-ring', key: 'timer-ring', type: 'Custom', bounds: '[40,756][1280,1800]', visible: 'true' } },
      { attributes: { id: buildIdentityNodeId(stamp), key: buildIdentityNodeId(stamp), type: 'Text', text: stamp, bounds: '[515,351][517,353]', visible: 'true', opacity: '0.010000' } },
    ],
  }] });
  const current = buildStampFromJobId('hap-run-2-phone-2in1');
  const previous = buildStampFromJobId('hap-run-1-phone-2in1');
  assert.notEqual(current, previous);
  assert.equal(hasBuildIdentity(stamped(current), current), true);
  // The whole point of the check: same bundle name, previous build.
  assert.equal(hasBuildIdentity(stamped(previous), current), false);
  assert.deepEqual(observedBuildStamps(stamped(previous)), [previous]);
  assert.deepEqual(visibleBundleNames(stamped(previous)), ['com.genius.pomodoro.04']);
  // A build with no stamp must not pass on its bundle name alone.
  const unstamped = { children: [{ attributes: { bundleName: 'com.genius.pomodoro.04', type: 'root' } }] };
  assert.equal(hasBuildIdentity(unstamped, current), false);
  assert.deepEqual(observedBuildStamps(unstamped), []);
  assert.equal(hasBuildIdentity(stamped(current), ''), false);

  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const install = runner.match(/async function installHapAndOpen\([\s\S]*?\n\}/)?.[0];
  assert.ok(install, 'installHapAndOpen source');
  assert.match(install, /if \(hasBuildIdentity\(layout, buildStamp\)\) break;/);
  assert.match(install, /installed HAP did not reach the foreground as this build/);
  assert.doesNotMatch(install, /if \(visibleBundleNames\(layout\)\.includes\(bundleName\)\) break;/);
  // Evidence and proof have to describe one app: the stamp is read from a dump
  // taken before the screenshot, and leaves with it.
  assert.ok(install.indexOf('hasBuildIdentity(layout || {}, buildStamp)') < install.indexOf("'screenCap'"));
  assert.match(install, /return \{ result: 'PASS'[^}]*buildStamp, hapSha256 \}/);
});

test('the orchestrator stamps the build into the product entry without moving the source digest', () => {
  const stamp = buildStampFromJobId('hap-stamp-run-phone-2in1');
  assert.match(stamp, /^[0-9a-f]{16}$/);
  assert.equal(buildStampFromJobId('hap-stamp-run-phone-2in1'), stamp);
  assert.throws(() => buildStampFromJobId(''), /needs a job id/);

  const module = buildIdentityModule(stamp);
  assert.match(module, new RegExp(`export const BUILD_STAMP = '${stamp}';`));
  assert.match(module, new RegExp(`export const BUILD_IDENTITY_NODE_ID = '${buildIdentityNodeId(stamp)}';`));
  // dumpLayout drops zero-sized and off-screen nodes, so the injected node has to be
  // 1x1 and on screen; absolute placement keeps the product layout untouched.
  assert.match(module, /position: 'absolute', top: 0, left: 0, width: 1, height: 1/);
  assert.match(buildIdentityModule(null), /export const BUILD_STAMP = null;/);
  assert.match(buildIdentityModule(null), /if \(!BUILD_STAMP\) return App;/);
  assert.throws(() => buildIdentityModule('not-a-stamp'), /invalid HAP build stamp/);

  // The template ships the unstamped module verbatim, so the two cannot drift.
  assert.equal(readFileSync(join(root, `templates/expo-harmony/${BUILD_IDENTITY_FILE}`), 'utf8'), buildIdentityModule(null));
  assert.match(readFileSync(join(root, 'templates/expo-harmony/index.js'), 'utf8'), /registerRootComponent\(withBuildIdentity\(App\)\);/);

  // index.js and build-identity.js are orchestrator-owned. Restamping must not move
  // productInputSha256, or every build would read as a source change.
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-stamp-'));
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, '.expo-fast/request.md'), '记一笔');
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({ available: [], unavailable: [] }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: {} }));
  writeFileSync(join(project, 'app.json'), JSON.stringify({ expo: { slug: 'stamp-app' } }));
  writeFileSync(join(project, 'App.tsx'), 'export default function App(){ return <View testID="ledger-summary" /> }');
  writeFileSync(join(project, 'index.js'), readFileSync(join(root, 'templates/expo-harmony/index.js')));
  writeFileSync(join(project, BUILD_IDENTITY_FILE), buildIdentityModule(stamp));
  const stampedDigest = auditProductSource(project).productInputSha256;
  writeFileSync(join(project, BUILD_IDENTITY_FILE), buildIdentityModule(buildStampFromJobId('hap-other-run-phone-2in1')));
  assert.equal(auditProductSource(project).productInputSha256, stampedDigest);
  writeFileSync(join(project, 'App.tsx'), 'export default function App(){ return <View testID="ledger-total" /> }');
  assert.notEqual(auditProductSource(project).productInputSha256, stampedDigest);
});

test('the HAP build stamps the source before the pool runs and reports the stamp of the artifact on disk', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-hap-stamp-'));
  const project = join(workspace, 'product');
  const sdk = join(workspace, 'sdk');
  const pool = join(workspace, 'pool');
  mkdirSync(project);
  mkdirSync(sdk);
  mkdirSync(pool);
  const realProject = realpathSync(project);
  let builtJobId = '';

  const built = runHapPoolBuild({
    project,
    sdk,
    pool,
    runId: 'run-1',
    reuseExisting: false,
    commandRunner(_command, args) {
      const output = args[args.indexOf('--output') + 1];
      builtJobId = args[args.indexOf('--job-id') + 1];
      // The stamp has to be in the source before the pool reads it.
      assert.equal(
        readFileSync(join(realProject, BUILD_IDENTITY_FILE), 'utf8'),
        buildIdentityModule(buildStampFromJobId(builtJobId)),
      );
      const hapPath = join(output, `${builtJobId}.hap`);
      mkdirSync(output, { recursive: true });
      writeFileSync(hapPath, builtJobId);
      writeFileSync(join(output, 'build-result.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'success',
        jobId: builtJobId,
        productRoot: realProject,
        hapPath,
        hapSha256: createHash('sha256').update(builtJobId).digest('hex'),
        bundleName: 'com.genius.stamped',
        deviceTypes: ['phone', '2in1'],
        buildMode: 'release',
      }));
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(built.status, 'ready');
  assert.equal(built.buildStamp, buildStampFromJobId(builtJobId));

  // A later run that reuses the HAP must expect the stamp baked into that HAP,
  // not one derived from its own run id.
  const reused = runHapPoolBuild({
    project,
    sdk,
    pool,
    runId: 'run-2',
    commandRunner() { throw new Error('a reused HAP must not rebuild'); },
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.buildStamp, built.buildStamp);
  assert.notEqual(buildStampFromJobId('hap-run-2-phone-2in1'), built.buildStamp);
});

test('model probes rest on an observable difference, never on a request being accepted', () => {
  // Both strings below are verbatim rejections from the configured endpoint,
  // and the pair is the whole reason a probe records how it knows a number.
  // One states the limit; the other states a magnitude, and "256K" does not say
  // whether K is 1000 or 1024. Reading it as 256000 is the value this
  // repository shipped, and the value that was wrong.
  assert.deepEqual(
    windowFromRejection("This model's maximum context length is 1048576 tokens. However, you requested 1624100 tokens (1624084 in the messages, 16 in the completion)."),
    { value: 1048576, confidence: 'exact' },
  );
  assert.deepEqual(
    windowFromRejection('k3-256k supports only 256K context. (request id: 20260823)'),
    { value: 262144, confidence: 'derived' },
  );
  // Anything else is unmeasured rather than guessed, because a guess here
  // reproduces the failure the probes exist to catch.
  assert.equal(windowFromRejection('You have reached your concurrent request limit'), null);
  assert.equal(windowFromRejection('invalid api key'), null);

  const dir = mkdtempSync(join(tmpdir(), 'expo-fast-probes-'));
  const fakeEndpoint = (script) => {
    const path = join(dir, `launcher-${createHash('sha256').update(script).digest('hex').slice(0, 8)}`);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  // A rejection is the measurement, so the probe has to read a body that comes
  // with an error status rather than treating the status as the answer. This
  // endpoint answers an over-long request with 401, which is also its answer to
  // a bad credential.
  const rejects = fakeEndpoint(`cat > /dev/null
echo 'HTTP/2 401' >&2
echo '{"error":{"message":"k3-256k supports only 256K context."}}'`);
  assert.deepEqual(probeContextWindow(rejects, 'k3-256k', () => {}, [700]), {
    value: 262144,
    confidence: 'derived',
    evidence: 'k3-256k supports only 256K context.',
  });

  // A rejection that names no window measures nothing, and says so.
  const silent = fakeEndpoint(`cat > /dev/null
echo 'HTTP/2 429' >&2
echo '{"error":{"message":"slow down"}}'`);
  assert.match(probeContextWindow(silent, 'k3-256k', () => {}, [700]).evidence, /rejected without naming a window: slow down/);
  assert.equal(probeContextWindow(silent, 'k3-256k', () => {}, [700]).status, 'unmeasured');

  // The thinking verdict comes from the reply, not from the field being
  // accepted: a relay that hid the block while the model still thought would
  // leave the token count behind, and this is what would catch it.
  const thinks = fakeEndpoint(`body=$(cat)
echo 'HTTP/2 200' >&2
case "$body" in
  *'"thinking"'*) echo '{"content":[{"type":"text","text":"red"}],"usage":{"output_tokens":5}}' ;;
  *) echo '{"content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"red"}],"usage":{"output_tokens":50,"output_tokens_details":{"thinking_tokens":34}}}' ;;
esac`);
  const measured = probeThinking(thinks, 'k3-256k');
  assert.equal(measured.thinkingDisablable.value, true);
  assert.match(measured.thinkingDisablable.evidence, /34 thinking tokens .*, none with thinking disabled/);
  // Omitting the field is not the same as disabling it. Claude Code drops the
  // field entirely at MAX_THINKING_TOKENS=0, so this is what decides whether
  // that could ever have meant what it looks like.
  assert.equal(measured.absentThinkingMeansOff.value, false);

  // A relay that keeps thinking under both bodies is reported as unable to
  // disable it, not as a probe failure.
  const alwaysThinks = fakeEndpoint(`cat > /dev/null
echo 'HTTP/2 200' >&2
echo '{"content":[{"type":"thinking","thinking":"x"}],"usage":{"output_tokens_details":{"thinking_tokens":9}}}'`);
  assert.equal(probeThinking(alwaysThinks, 'k3-256k').thinkingDisablable.value, false);

  // A window larger than the probe expects grows the request until it is
  // rejected, because only a rejection carries the number and only a rejection
  // is free. Every accepted rung is billed, so each one says so, and running
  // out of rungs records what is actually known -- a lower bound -- rather than
  // a number nobody measured.
  const acceptsEverything = fakeEndpoint(`cat > /dev/null
echo 'HTTP/2 200' >&2
echo '{"content":[{"type":"text","text":"ok"}]}'`);
  const spoken = [];
  const huge = probeContextWindow(acceptsEverything, 'roomy', (line) => spoken.push(line), [700, 2800]);
  assert.equal(huge.status, 'unmeasured');
  assert.equal(huge.atLeastTokens, 2800);
  assert.equal(spoken.length, 2, 'every accepted rung is announced because it costs money');
  assert.match(spoken[0], /which is billed\. Growing the probe to 2,800\./);
  assert.match(spoken[1], /No larger probe to try\./);
  // The real ladder starts above both configured models so the first request is
  // refused, which is the rung that costs nothing.
  assert.deepEqual(windowLadder, [1_600_000, 6_400_000]);

  // An endpoint that cannot answer leaves the fact unmeasured; it never fails
  // the refresh, because the model names are what this cache has always been
  // trusted for.
  const broken = fakeEndpoint(`cat > /dev/null
echo 'HTTP/2 500' >&2
echo 'gateway exploded'`);
  assert.match(probeThinking(broken, 'k3-256k').unmeasured, /HTTP 500/);
  rmSync(dir, { recursive: true, force: true });
});

test('the timing probe never picks which models to spend turns on', () => {
  // This is the one probe that costs real turns, so naming a model is the
  // whole opt-in. A default would turn "measure the endpoint" into a bill
  // nobody asked for, and setup-harmony-pool.sh calls the cheap refresh on
  // every pool build.
  assert.throws(() => parseTimingArguments([]), /name the models to time/);
  assert.throws(() => parseTimingArguments(['--model', 'a', '--samples', '0']), /--samples must be a whole number/);
  assert.throws(() => parseTimingArguments(['--model', 'a', '--cap-seconds', 'soon']), /--cap-seconds must be seconds/);
  assert.throws(() => parseTimingArguments(['--everything']), /unknown option: --everything/);

  const parsed = parseTimingArguments(['--model', 'a', '--model', 'b', '--samples', '5', '--cap-seconds', '180']);
  assert.deepEqual(parsed.models, ['a', 'b']);
  assert.equal(parsed.samples, 5);
  assert.equal(parsed.capSeconds, 180);

  // A model this endpoint does not serve has to be caught before the first
  // turn, not when the result is filed: such a turn does not fail fast, it
  // hangs, so finding out afterwards costs the whole run and measures nothing.
  for (const file of ['scripts/probe-turn-timing.mjs', 'scripts/probe-effort-scale.mjs']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.ok(
      source.indexOf('assertModelsServed(') < source.indexOf('for (const model of'),
      `${file} checks the models before spending anything`,
    );
  }
});

test('a run reports the endpoint contradicting the configured window, and only then', () => {
  // The only moment this endpoint volunteers its real limit on a run path is
  // when it refuses a request for exceeding it, and that refusal is free.
  // Claude Code surfaces the text on the terminal result event, which also
  // carries the HTTP status.
  const refused = windowFromApiError({
    type: 'result', is_error: true, api_error_status: 400,
    result: "API Error: 400 This model's maximum context length is 1048576 tokens. However, you requested 1624100 tokens.",
  });
  assert.equal(refused.value, 1048576);
  assert.equal(refused.confidence, 'exact');
  assert.equal(refused.httpStatus, 400);

  // ...and on the assistant event that Claude Code flags as an API error.
  const alsoRefused = windowFromApiError({
    type: 'assistant', is_api_error_message: true,
    message: { content: [{ type: 'text', text: 'API Error: 401 k3-256k supports only 256K context.' }] },
  });
  assert.equal(alsoRefused.value, 262144);
  assert.equal(alsoRefused.confidence, 'derived');

  // The guard that matters: a model writing about context windows in its own
  // output must not read as the endpoint refusing anything. Scanning the trace
  // for the text alone would fire here, and a warning that cries wolf is worse
  // than no warning.
  assert.equal(windowFromApiError({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'This model supports only 256K context, so keep the file short.' }] },
  }), null);
  assert.equal(windowFromApiError({ type: 'result', is_error: false, result: 'maximum context length is 1048576' }), null);
  assert.equal(windowFromApiError({ type: 'result', is_error: true, result: 'API Error: 429 slow down' }), null);

  // Reported, never written back: the fact table has one author, so a run that
  // edited it would leave nobody able to say how a number in it was measured.
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /reportEndpointWindow\(record\.row, roleEnvironment, refusal\)/);
  assert.doesNotMatch(runner, /recordModelFacts|refreshModelCache/);
});

test('the effort probe counterbalances its levels so drift cannot fake an ordering', () => {
  // Two hand-runs sent low, medium, high, max in that fixed order. One came out
  // ordered in 3 of 3 variants and the next in 0 of 3. A fixed order cannot be
  // told apart from the endpoint drifting over the couple of minutes a variant
  // takes -- drift alone manufactures monotonicity -- so the level a variant
  // starts at rotates.
  const dir = mkdtempSync(join(tmpdir(), 'expo-fast-effort-'));
  const asked = join(dir, 'asked.txt');
  const launcher = join(dir, 'launcher');
  writeFileSync(launcher, `#!/bin/sh
body=$(cat)
echo "$body" | sed -n 's/.*"effort":"\\([a-z]*\\)".*/\\1/p' >> ${asked}
echo 'HTTP/2 200' >&2
echo '{"content":[{"type":"thinking","thinking":"xx"},{"type":"text","text":"2692538"}],"usage":{"output_tokens_details":{"thinking_tokens":11}}}'
`);
  chmodSync(launcher, 0o755);

  const measured = probeEfforts(launcher, 'any-model', 5);
  const order = readFileSync(asked, 'utf8').trim().split('\n');
  assert.equal(order.length, 12, 'four levels across three variants');
  const starts = [order[0], order[4], order[8]];
  assert.equal(new Set(starts).size, 3, 'each variant starts at a different level');
  for (const slice of [order.slice(0, 4), order.slice(4, 8), order.slice(8, 12)]) {
    assert.equal(new Set(slice).size, 4, 'every variant still covers all four levels');
  }

  // The fake replies identically every time, so nothing separates the levels
  // and the probe must say so rather than report an ordering.
  assert.equal(measured.orderedThroughHigh, false);
  assert.equal(measured.variantsRising, '0/3');
  assert.deepEqual(measured.accepted, ['low', 'medium', 'high', 'max']);
  // The fake answers every variant with the one for n=30, so the eight replies
  // belonging to the other two variants are counted wrong. Each variant carries
  // its own answer, checked by brute force before use, which is what makes a
  // wrong answer a fact about the model rather than about the question.
  assert.equal(measured.wrongAnswers, 8);
  rmSync(dir, { recursive: true, force: true });
});
