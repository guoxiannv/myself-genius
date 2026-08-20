import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateSmoke } from '../scripts/validate-smoke.mjs';
import { inspectCurrentMiniApp, visibleBundleNames } from '../scripts/layout-identity.mjs';
import { assignHdcPreviewPorts, configuredHdcPreviewTargets, configuredHdcTarget, discoverHdcPreviewPools, hdcOutputFailed, parseHdcForwardRules, parseHdcTargets, prioritizeHdcPreviewTargets, reversePortCandidates, selectHdcPreviewTargets, selectHdcTarget } from '../scripts/hdc-target.mjs';
import { auditImplementationTrace } from '../scripts/trace-scope.mjs';
import { auditProductSource, verifyHarmonyGoArtifacts } from '../scripts/verify-product.mjs';
import { writeRunState } from '../scripts/run-state.mjs';
import { resolveExecution } from '../scripts/execution-policy.mjs';
import { repairArtifactName } from '../scripts/repair-artifact.mjs';
import { assertDependencyRuntime, pinRuntimeDependencies, stageHarmonyCli } from '../scripts/dependencies.mjs';
import { HAP_DEVICE_TYPES, runHapPoolBuild } from '../scripts/hap-build.mjs';
import { launchHapPreview } from '../scripts/run-livetest.mjs';
import { acquirePreviewDevice, acquirePreviewDevices, configuredPreviewPools } from '../scripts/preview-device-pool.mjs';
import { bundleNameFromModuleJson, DEFAULT_HARMONY_GO_BUNDLE_NAME, resolveHarmonyGoBundleName } from '../scripts/harmony-go-runtime.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const script = join(root, 'scripts/fast-harmony.mjs');
const dependencyController = join(root, 'scripts/dependencies.mjs');

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

test('exact-app identity accepts the universal shell title below a phone status bar', () => {
  const manifestId = 'remote-ui-ea02ff4f9333452b9f6c3ea3185d49b8';
  const layout = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide', type: 'root' }, children: [
    { attributes: { type: 'Text', text: manifestId, bounds: '[70,241][1231,511]', visible: 'true' } },
    { attributes: { id: 'timer-ring', type: 'Custom', bounds: '[40,756][1280,1800]', visible: 'true' } },
  ] }] };
  const identity = inspectCurrentMiniApp(layout, manifestId, ['timer-ring']);
  assert.equal(identity.ok, true, identity.errors.join('; '));
  assert.equal(identity.currentProjectBounds, '[70,241][1231,511]');
});

test('exact-app identity does not confuse a catalog card with the current shell title', () => {
  const manifestId = 'remote-ui-wanted';
  const layout = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide', type: 'root' }, children: [
    { attributes: { type: 'Text', text: 'remote-ui-other', visible: 'true' } },
    { attributes: { type: 'Button', text: '项目', visible: 'true' } },
    { attributes: { type: 'Text', text: manifestId, visible: 'true' } },
    { attributes: { id: 'timer-ring', type: 'Custom', visible: 'true' } },
  ] }] };
  const identity = inspectCurrentMiniApp(layout, manifestId, ['timer-ring']);
  assert.equal(identity.ok, false);
  assert.match(identity.errors.join('; '), /current-project title/);
});

test('HDC textual start failures are rejected even when the process exits zero', () => {
  assert.equal(hdcOutputFailed('start ability successfully.\n'), false);
  assert.equal(hdcOutputFailed('error: failed to start ability.\nError Code:10106102'), true);
  assert.equal(hdcOutputFailed('[Fail][E003001] Invalid bundle name: com.example.myapplication1.ide'), true);
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
  assert.match(runner, /function catalogProjectCard\(/);
  assert.match(runner, /ids\.size === 1 && ids\.has\(identity\)/);
  assert.match(runner, /function waitForInstalledMiniApp\(/);
  assert.match(runner, /timed out waiting for mini app \$\{manifestId\} to install/);
  assert.match(runner, /\(candidate\) => inspectCurrentMiniApp\(candidate, manifestId, productMarkers\)\.ok/);
  assert.doesNotMatch(runner, /const identityButton = collect\(/);
  assert.ok(runner.indexOf("assertCurrentMiniApp(layout, manifestId, productMarkers, 'launch-product')") < runner.lastIndexOf("'screenCap'"));
});

test('desktop preview installs the same generated HAP used by phone preview', () => {
  const runner = readFileSync(join(root, 'scripts/run-livetest.mjs'), 'utf8');
  const hapBuilder = readFileSync(join(root, 'scripts/hap-build.mjs'), 'utf8');
  assert.match(runner, /function installHapAndOpen\(/);
  assert.match(runner, /'install', '-r', hapPath/);
  assert.match(runner, /installPreview\(project, target, hap, 'desktop'\)/);
  assert.match(hapBuilder, /HAP_DEVICE_TYPES\.join\(','\)/);
});

test('desktop HAP preview quarantines a failed emulator and installs on the fallback', async () => {
  const project = join(tmpdir(), 'remote-ui-00000000000000000000000000000001');
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
  assert.deepEqual(config, {
    schemaVersion: 1,
    model: 'k3-256k',
    effort: 'low',
    repairModel: 'k3-256k',
    repairEffort: 'medium',
    repairLimit: 100,
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
  assert.equal(digest, '54309185afceaf7ccfb38fbe52e2f5f1c8a3510d71442cce359626545fa3ef86');
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
  assert.match(starter, /desktopListCard: \{ flexBasis: '48%', flexGrow: 1 \}/);
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
  const root = (text) => ({ children: [{ attributes: { bundleName: 'com.example.myapplication1.ide', type: 'root' }, children: [{ attributes: { type: 'Text', text: 'test-ledger', bounds: '[38,130][260,179]', visible: 'true' } }, { attributes: { id: 'home-month-expense', type: 'Custom', bounds: '[40,400][900,500]', visible: 'true' }, children: [{ attributes: { text } }] }] }] });
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
    { attributes: { type: 'Text', text: 'other-current-app', bounds: '[38,130][300,179]', visible: 'true' } },
    { attributes: { type: 'Button', text: 'test-ledger', bounds: '[900,220][1200,292]', visible: 'true', backgroundColor: '#FFEAECF0' } },
    { attributes: { id: 'home-month-expense', type: 'Custom', bounds: '[40,400][900,500]', visible: 'true' }, children: [{ attributes: { text: '本月支出 100 元' } }] },
  ] }] };
  writeFileSync(join(smoke, 'layout-before.json'), JSON.stringify(wrong));
  assert.throws(() => validateSmoke(project), /current-project title is not exactly test-ledger/);
});

test('exact-app identity locates the Host title relative to navigation on high-density layouts', async () => {
  const { inspectCurrentMiniApp } = await import('../scripts/layout-identity.mjs');
  const layout = { children: [{ attributes: { bundleName: 'com.example.myapplication1.ide' }, children: [
    { attributes: { type: 'Text', text: 'EXPO HARMONY GO', bounds: '[67,175][550,222]', visible: 'true' } },
    { attributes: { type: 'Text', text: 'test-ledger', bounds: '[67,232][1184,493]', visible: 'true' } },
    { attributes: { type: 'Button', text: '项目', bounds: '[67,566][263,694]', visible: 'true' } },
    { attributes: { type: 'Custom', id: 'ledger-summary', bounds: '[40,900][900,1000]', visible: 'true' } },
    { attributes: { type: 'Text', text: 'test-ledger', bounds: '[316,1991][951,2180]', visible: 'true' } },
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
