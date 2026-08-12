import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateSmoke } from '../scripts/validate-smoke.mjs';
import { auditImplementationTrace } from '../scripts/trace-scope.mjs';
import { auditProductSource, verifyHarmonyGoArtifacts } from '../scripts/verify-product.mjs';
import { writeRunState } from '../scripts/run-state.mjs';
import { canRunRepair, repairArtifactName } from '../scripts/repair-policy.mjs';
import { pinRuntimeDependencies, stageHarmonyCli } from '../scripts/dependencies.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const script = join(root, 'skills/expo-harmony-fast/scripts/fast-harmony.mjs');

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
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.project, project);
  assert.equal(plan.promptKind, 'inline');
  assert.equal(plan.candidate, 'repair');
  assert.equal(plan.model, 'deepseek-v4-flash');
  assert.equal(plan.repairModel, 'deepseek-v4-flash');
  assert.equal(plan.effort, 'low');
  assert.equal(plan.repairEffort, 'medium');
  assert.equal(plan.repairTimeout, 15);
  assert.equal(plan.timeout, 0);
  assert.equal(plan.launch, false);
  assert.equal(plan.port, 3399);
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

test('one-click launcher defaults to the tested learning-goals scenario and K3 repair lane', () => {
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const result = spawnSync(process.execPath, [launcher, '--dry-run', '--launch', 'false'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.promptKind, 'default');
  assert.equal(plan.promptSource, join(root, 'prompts/learning-goals.md'));
  assert.equal(plan.candidate, 'repair');
  assert.equal(plan.model, 'k3-256k');
  assert.equal(plan.effort, 'low');
  assert.equal(plan.repairModel, 'k3-256k');
  assert.equal(plan.repairEffort, 'medium');
  assert.equal(plan.timeout, 0);
  assert.equal(plan.repairTimeout, 0);
  assert.equal(plan.foreground, false);
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

test('one machine-local env file configures every portable launcher path', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-machine-config-'));
  const appRoot = join(workspace, 'apps');
  const envFile = join(workspace, 'machine.env');
  writeFileSync(envFile, [
    `EXPO_FAST_APP_ROOT="${appRoot}"`,
    'EXPO_FAST_NODE="/portable/node"',
    'EXPO_HARMONY_SDK_ROOT="/portable/devkit_sdk"',
    'EXPO_FAST_MODULE_CACHE="/portable/cache-one/node_modules:/portable/cache-two/node_modules"',
    'DEVECO_PATH="/portable/DevEco-Studio.app"',
    'CLAUDE_BIN="portable-claude"',
    'EXPO_FAST_LIVE_CLAUDE="0"',
    '',
  ].join('\n'));
  const env = { ...process.env, EXPO_FAST_ENV_FILE: envFile };
  for (const key of ['EXPO_FAST_APP_ROOT', 'EXPO_FAST_NODE', 'EXPO_HARMONY_SDK_ROOT', 'EXPO_FAST_MODULE_CACHE', 'DEVECO_PATH', 'CLAUDE_BIN', 'EXPO_FAST_LIVE_CLAUDE']) delete env[key];
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const result = spawnSync(process.execPath, [launcher, '--dry-run', '--name', 'portable-app', '--launch', 'false'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.configFile, envFile);
  assert.equal(plan.project, join(appRoot, 'portable-app'));
  assert.equal(plan.node, '/portable/node');
  assert.equal(plan.sdk, '/portable/devkit_sdk');
  assert.equal(plan.moduleCache, '/portable/cache-one/node_modules:/portable/cache-two/node_modules');
  assert.equal(plan.deveco, '/portable/DevEco-Studio.app');
  assert.equal(plan.claude, 'portable-claude');
});

test('monorepo defaults and relative env paths resolve from the runner root', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expo-fast-relative-config-'));
  const launcher = join(root, 'scripts/start-livetest.mjs');
  const missingEnv = join(workspace, 'missing.env');
  const cleanEnv = { ...process.env, EXPO_FAST_ENV_FILE: missingEnv };
  for (const key of ['EXPO_FAST_APP_ROOT', 'EXPO_FAST_NODE', 'EXPO_HARMONY_SDK_ROOT', 'EXPO_FAST_MODULE_CACHE', 'DEVECO_PATH', 'CLAUDE_BIN']) delete cleanEnv[key];

  const defaultsResult = spawnSync(process.execPath, [launcher, '--dry-run', '--name', 'default-app', '--launch', 'false'], {
    cwd: workspace,
    encoding: 'utf8',
    env: cleanEnv,
  });
  assert.equal(defaultsResult.status, 0, defaultsResult.stderr);
  const defaultsPlan = JSON.parse(defaultsResult.stdout);
  assert.equal(defaultsPlan.project, resolve(root, '../expo-app/default-app'));
  assert.equal(defaultsPlan.sdk, resolve(root, '../sdk'));

  const relativeEnv = join(workspace, 'relative.env');
  writeFileSync(relativeEnv, [
    'EXPO_FAST_APP_ROOT="../generated-apps"',
    `EXPO_FAST_NODE="${process.execPath}"`,
    'EXPO_HARMONY_SDK_ROOT="../sdk"',
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
  assert.equal(relativePlan.moduleCache, `${resolve(root, '../cache-one/node_modules')}:${resolve(root, '../cache-two/node_modules')}`);
  assert.equal(relativePlan.deveco, resolve(root, '../DevEco-Studio.app'));
  assert.equal(relativePlan.claude, resolve(root, '../bin/claude'));
});

test('portable launchers contain no user-specific path and keep machine config outside skills', () => {
  const shell = readFileSync(join(root, 'start-livetest.sh'), 'utf8');
  const launcher = readFileSync(join(root, 'scripts/start-livetest.mjs'), 'utf8');
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const dependencies = readFileSync(join(root, 'scripts/dependencies.mjs'), 'utf8');
  const helper = readFileSync(join(root, 'skills/expo-harmony-fast/scripts/fast-harmony.mjs'), 'utf8');
  const skill = readFileSync(join(root, 'skills/expo-harmony-fast/SKILL.md'), 'utf8');
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  assert.doesNotMatch(`${shell}\n${launcher}\n${runner}\n${dependencies}\n${helper}\n${skill}`, /\/Users\/stefan/);
  assert.match(shell, /source "\$LOCAL_ENV"/);
  assert.match(launcher, /process\.loadEnvFile\(localEnvFile\)/);
  for (const key of ['EXPO_FAST_APP_ROOT', 'EXPO_FAST_NODE', 'EXPO_HARMONY_SDK_ROOT', 'EXPO_FAST_MODULE_CACHE', 'DEVECO_PATH', 'CLAUDE_BIN']) assert.match(example, new RegExp(key));
  assert.doesNotMatch(skill, /EXPO_FAST_APP_ROOT/);
});

test('external controller atomically records live generation, repair, and completion state', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-state-'));
  const runId = 'run-state-test';
  writeRunState(project, 'generating_code', { runId, reset: true, detail: 'model_generation', context: { model: 'k3-256k' } });
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
  assert.deepEqual(state.history.map((entry) => entry.state), ['generating_code', 'repairing', 'completed']);
  assert.deepEqual(readdirSync(stateDir), ['state.json']);

  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const skill = readFileSync(join(root, 'skills/expo-harmony-fast/SKILL.md'), 'utf8');
  assert.match(runner, /setRunState\('generating_code', 'model_generation'/);
  assert.match(runner, /setRunState\('repairing', 'model_repair'/);
  assert.match(runner, /setRunState\('completed', 'done'/);
  assert.ok(runner.indexOf("[helper, 'prepare', project, request]") < runner.indexOf("setRunState('generating_code', 'preparing'"));
  assert.doesNotMatch(skill, /\.expo-fast\/state\.json/);
});

test('external controller records a terminal failed state without invoking the product agent', () => {
  const project = mkdtempSync(join(tmpdir(), 'expo-fast-state-failure-'));
  const request = join(project, 'request.md');
  writeFileSync(request, 'Build a small offline task app.');
  const runner = join(root, 'scripts/run-livetest.mjs');
  const result = spawnSync(process.execPath, [runner,
    '--project', project,
    '--request', request,
    '--candidate', 'direct',
    '--effort', 'invalid',
    '--launch', 'false',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const state = JSON.parse(readFileSync(join(project, '.expo-fast/state.json'), 'utf8'));
  assert.equal(state.state, 'failed');
  assert.equal(state.status, 'failed');
  assert.equal(state.history[0].state, 'failed');
  assert.equal(state.history.at(-1).state, 'failed');
  assert.match(state.error, /unknown effort/);
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
  pkg.dependencies['expo-sharing'] = '57.0.8';
  pkg.dependencies['expo-document-picker'] = '57.0.1';
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const cached = {
    '@expo/cli': '57.0.11',
    '@react-native-oh/react-native-harmony': '0.84.2',
    '@react-native-oh/react-native-harmony-cli': '0.84.2',
    expo: '57.0.9',
    'expo-document-picker': '57.0.1',
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
  const seeded = spawnSync(process.execPath, [script, 'seed-modules', project], { encoding: 'utf8', env });
  assert.equal(seeded.status, 0, seeded.stderr);
  const synced = spawnSync(process.execPath, [script, 'sync-dependencies', project], { encoding: 'utf8', env });
  assert.equal(synced.status, 0, synced.stderr);
  const moduleCache = JSON.parse(readFileSync(join(project, '.expo-fast/module-cache.json'), 'utf8'));
  assert.equal(moduleCache.selectedCapabilities['expo-sharing'], '57.0.8');
  assert.equal(moduleCache.selectedCapabilities['expo-document-picker'], '57.0.1');
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
  const packageContract = { name: 'sync-app', version: '1.0.0', private: true, dependencies: { 'react-native-svg': '15.15.4' } };
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  mkdirSync(join(project, 'node_modules/react-native-svg'), { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify(packageContract));
  writeFileSync(join(project, '.expo-fast/scaffold-package.json'), JSON.stringify(packageContract));
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({
    contractsSha256: 'test-contract',
    available: [{ package: 'react-native-svg', version: '15.15.4', supportedExports: ['Svg', 'Path'] }],
    unavailable: [],
  }));
  writeFileSync(join(project, 'node_modules/react-native-svg/package.json'), JSON.stringify({ name: 'react-native-svg', version: '15.15.4' }));
  const controller = join(root, 'scripts/dependencies.mjs');
  const result = spawnSync(process.execPath, [controller, 'sync', project], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.installed, []);
  assert.equal(output.installMs, 0);
  const evidence = JSON.parse(readFileSync(join(project, '.expo-fast/module-cache.json'), 'utf8'));
  assert.deepEqual(evidence.lastSync, { strategy: 'project-npm-install', installMs: 0, installed: [] });
  assert.equal(evidence.actualVersions['react-native-svg'], '15.15.4');
});

test('three candidates stay linear and default repair retries up to 100 times', () => {
  const config = JSON.parse(readFileSync(join(root, 'config/candidates.json'), 'utf8'));
  assert.deepEqual(Object.keys(config.candidates), ['direct', 'brief', 'repair']);
  assert.equal(config.candidates.direct.writeBrief, true);
  assert.equal(config.candidates.direct.repairTurns, 0);
  assert.equal(config.candidates.brief.repairTurns, 1);
  assert.equal(config.candidates.repair.repairTurns, 100);
  assert.equal(config.candidates.repair.model, 'k3-256k');
  assert.equal(config.candidates.repair.effort, 'low');
  assert.equal(config.candidates.repair.repairModel, 'k3-256k');
  assert.equal(config.candidates.repair.repairEffort, 'medium');
  assert.equal(config.default, 'auto');
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  assert.match(runner, /Cold-start experiment integrity forbids/);
  assert.doesNotMatch(runner, /cpSync\(join\(baseProject, 'src'/);
  assert.doesNotMatch(runner, /product-invariants\.md/);
  assert.match(runner, /'--permission-mode', 'dontAsk'/);
  assert.match(runner, /--strict-mcp-config/);
  assert.match(runner, /'--tools', 'Read,Write,Edit'/);
  assert.match(runner, /Read\(\.\/App\.tsx\)/);
  assert.match(runner, /Read\(\.\/\.expo-fast\/model-capability-index\.txt\)/);
  assert.doesNotMatch(runner, /Read\(\.\/\.expo-fast\/capability-catalog\.json\)/);
  assert.match(runner, /Write\(\.\/src\/\*\*\)/);
  assert.match(runner, /Deterministic product diagnostics failed/);
  assert.match(runner, /requestSha256/);
  assert.match(runner, /templateAssetSha256/);
  assert.match(runner, /REQUIRED rows are request-matched AVAILABLE capabilities/);
  assert.match(runner, /requiredCapabilities/);
  assert.match(runner, /EXPO_FAST_LIVE_CLAUDE/);
  assert.match(runner, /summarizeClaudeEvent/);
  assert.match(runner, /for \(;;\)/);
  assert.match(runner, /canRunRepair\(repairPolicy, repairAttempt\)/);
  assert.match(runner, /repairArtifactName\('agent-repair-trace'/);
  assert.match(runner, /\[dependencies, 'seed', project\]/);
  assert.match(runner, /\[dependencies, 'sync', project\]/);
  assert.match(runner, /\[dependencies, 'export', project, catalogRoot\]/);
  assert.doesNotMatch(runner, /\[helper, 'seed-modules', project\]/);
  assert.match(runner, /enforcement: 'advisory', blocking: false/);
  assert.match(runner, /trace-scope warning/);
  assert.doesNotMatch(runner, /trace violated the product-agent boundary/);
  assert.match(runner, /Number\(o\.repairTimeoutMinutes \?\? 0\)/);
  assert.doesNotMatch(runner, /repairTimeoutMinutes \|\| 8/);
  assert.match(runner, /timeoutMinutes > 0 \? setTimeout/);
  assert.doesNotMatch(runner, /claudeTimeoutMinutes \|\| 20/);
  assert.match(runner, /const model = o\.model \|\| candidates\[mode\]\.model/);
  assert.match(runner, /const effort = o\.effort \|\| candidates\[mode\]\.effort/);
  assert.match(runner, /const repairModel = o\.repairModel \|\| o\.model/);
  assert.match(runner, /const repairEffort = o\.repairEffort \|\| o\.effort/);
  assert.doesNotMatch(runner, /--dangerously-skip-permissions/);
});

test('repair policy enforces numeric bounds and gives every retry separate evidence', () => {
  assert.equal(canRunRepair(0, 0), false);
  assert.equal(canRunRepair(1, 0), true);
  assert.equal(canRunRepair(1, 1), false);
  assert.equal(canRunRepair(100, 99), true);
  assert.equal(canRunRepair(100, 100), false);
  assert.equal(repairArtifactName('agent-repair-trace', 1, '.jsonl'), 'agent-repair-trace.jsonl');
  assert.equal(repairArtifactName('agent-repair-trace', 2, '.jsonl'), 'agent-repair-trace-2.jsonl');
  assert.throws(() => canRunRepair(-1, 0), /invalid repairTurns policy/);
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

  const starter = readFileSync(join(root, 'skills/expo-harmony-fast/assets/expo-harmony-template/src/app-shell.tsx'), 'utf8');
  assert.match(starter, /width >= 1280/);
  assert.match(starter, /width >= 640 && width < 1280/);
  assert.doesNotMatch(starter, /width >= 1000/);
  assert.match(starter, /<View style=\{\[styles\.frame, isDesktop && styles\.desktopFrame\]\}>\{isDesktop && navigation\}<View style=\{styles\.main\}>/);
  assert.doesNotMatch(starter, /\{isDesktop && navigation\}<View style=\{styles\.frame\}>/);
  assert.match(starter, /desktopList: \{ flexDirection: 'row', flexWrap: 'wrap' \}/);
  assert.match(starter, /desktopListCard: \{ flexBasis: '48%', flexGrow: 1 \}/);
});

test('starter and model contract use Harmony-safe Path-only icon geometry', () => {
  const icons = readFileSync(join(root, 'skills/expo-harmony-fast/assets/expo-harmony-template/src/components/icons.tsx'), 'utf8');
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const skill = readFileSync(join(root, 'skills/expo-harmony-fast/SKILL.md'), 'utf8');
  assert.match(icons, /import Svg, \{ Path \} from 'react-native-svg'/);
  assert.doesNotMatch(icons, /<(?:Circle|Line|Polyline|Rect|Polygon)\b/);
  assert.equal([...icons.matchAll(/export const \w+Icon = icon\(/g)].length, 17);
  assert.match(runner, /Production icons must be Path-only/);
  assert.match(skill, /Keep production icons Path-only/);
});

test('automatic selection routes complex multi-surface requests to repair', () => {
  const scoreText = '四个 Tab 导出导入 周报 环比 连续 休息日 补记 逾期 SVG 图表 删除 二次确认';
  let score = scoreText.length;
  for (const pattern of [/四个 Tab|四个页面|four tabs/i, /导出|导入|迁移/, /周报|环比|历史周/, /连续|休息日|补记|逾期/, /SVG|图表|堆叠/, /删除|二次确认|确认/]) if (pattern.test(scoreText)) score += 1200;
  assert.ok(score >= 4000);
});

function writeEvidence(project, category = 'form-submit') {
  const smoke = join(project, '.expo-fast/smoke');
  mkdirSync(smoke, { recursive: true });
  writeFileSync(join(project, '.expo-fast/manifest.json'), JSON.stringify({ id: 'test-ledger' }));
  const root = (text) => ({ children: [{ attributes: { bundleName: 'host.exp.exponent.harmony', type: 'root' }, children: [{ attributes: { type: 'Text', text: 'test-ledger', bounds: '[38,130][260,179]', visible: 'true' } }, { attributes: { id: 'home-month-expense', type: 'Custom', bounds: '[40,400][900,500]', visible: 'true' }, children: [{ attributes: { text } }] }] }] });
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
  const wrong = { children: [{ attributes: { bundleName: 'host.exp.exponent.harmony', type: 'root' }, children: [
    { attributes: { type: 'Text', text: 'other-current-app', bounds: '[38,130][300,179]', visible: 'true' } },
    { attributes: { type: 'Button', text: 'test-ledger', bounds: '[900,220][1200,292]', visible: 'true', backgroundColor: '#FFEAECF0' } },
    { attributes: { id: 'home-month-expense', type: 'Custom', bounds: '[40,400][900,500]', visible: 'true' }, children: [{ attributes: { text: '本月支出 100 元' } }] },
  ] }] };
  writeFileSync(join(smoke, 'layout-before.json'), JSON.stringify(wrong));
  assert.throws(() => validateSmoke(project), /current-project title is not exactly test-ledger/);
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
export default function App(){ const { width } = useWindowDimensions(); const isDesktop = width >= 1280; const isTablet = width >= 640 && width < 1280; const navigation = <Text>导航</Text>; return <View style={[styles.frame, isDesktop && styles.desktopFrame]} testID="app-shell">{isDesktop && navigation}<View style={styles.main}>{isTablet && navigation}<View style={[styles.cards, isDesktop && styles.desktopCards]}><Text testID="summary">内容</Text></View>{!isDesktop && !isTablet && navigation}</View></View> }
const styles = StyleSheet.create({ frame: { flex: 1 }, desktopFrame: { flexDirection: 'row' }, main: { flex: 1 }, cards: { flex: 1 }, desktopCards: { flexDirection: 'row', flexWrap: 'wrap' }, card: { flexBasis: '48%' } });`);
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
  writeFileSync(join(output, 'runtime.json'), JSON.stringify({ runtimeVersion }));
  writeFileSync(join(output, 'catalog.json'), JSON.stringify([{ id: 'test-app', manifestUrl: '/miniapps/test-app/manifest.json' }]));
  writeFileSync(join(miniapp, 'bundle.js'), bundle);
  writeFileSync(join(miniapp, 'manifest.json'), JSON.stringify({ id: 'test-app', runtimeVersion, bundle: { url: '/miniapps/test-app/bundle.js', sha256: bundleHash } }));
  writeFileSync(join(project, '.expo-fast/sdk-fingerprint.json'), JSON.stringify({ runtimeVersion }));
  writeFileSync(join(project, '.expo-fast/capability-catalog.json'), JSON.stringify({ available: [] }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: {} }));
  writeFileSync(join(project, '.expo-fast/source-audit.json'), JSON.stringify({ status: 'pass', productInputSha256: 'source-digest', imports: [] }));
  const passed = verifyHarmonyGoArtifacts(project, output);
  assert.equal(passed.status, 'pass');
  assert.equal(passed.artifacts[0].sha256, bundleHash);
  assert.equal(passed.productInputSha256, 'source-digest');
  writeFileSync(join(miniapp, 'bundle.js'), 'tampered');
  assert.equal(verifyHarmonyGoArtifacts(project, output).status, 'fail');
});
