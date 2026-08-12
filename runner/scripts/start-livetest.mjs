#!/usr/bin/env node

import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const resolveRunnerPath = (value) => isAbsolute(value) ? resolve(value) : resolve(root, value);
const localEnvFile = resolveRunnerPath(process.env.EXPO_FAST_ENV_FILE || '.env');
if (existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);
const runner = join(root, 'scripts/run-livetest.mjs');
const defaultPrompt = join(root, 'prompts/learning-goals.md');
const candidateConfig = JSON.parse(readFileSync(join(root, 'config/candidates.json'), 'utf8')).candidates;
const defaults = {
  appRoot: resolve(root, '../expo-app'),
  node: process.execPath,
  sdk: resolve(root, '../sdk'),
  deveco: '/Applications/DevEco-Studio.app',
  claude: 'claude',
  candidate: 'repair',
  effort: '',
  repairEffort: '',
  timeout: 0,
  repairTimeout: 0,
  firstPort: 3355,
};

function usage() {
  return `Expo Harmony Fast one-click live test

Usage:
  ./start-livetest.sh
  ./start-livetest.sh --prompt "帮我做一个离线记账台……"
  ./start-livetest.sh --prompt-file /absolute/path/request.md
  pbpaste | ./start-livetest.sh --stdin

Prompt:
  --prompt TEXT          Use inline prompt text.
  --prompt-file PATH     Read prompt from a UTF-8 file.
  --stdin                Read the complete prompt from stdin.
  no prompt option       Use prompts/learning-goals.md.

Machine configuration:
  cp .env.example .env   Configure paths once in the repository-local .env.
  .env                   EXPO_FAST_APP_ROOT, EXPO_FAST_NODE,
                         EXPO_HARMONY_SDK_ROOT, EXPO_FAST_MODULE_CACHE,
                         DEVECO_PATH, and CLAUDE_BIN.
  command options         Override per-run values such as output, prompt, and model.

Run:
  --name NAME            Directory name under app-root.
  --project PATH         New empty target; relative paths are under app-root.
  --output-dir PATH      Alias of --project.
  --app-root PATH        Parent for automatic project and prompt input files.
  --session NAME         tmux session name; derived from project by default.
  --candidate MODE       repair (default), brief, direct, or auto.
  --model MODEL          Override the main model, for example deepseek-v4-flash.
  --effort LEVEL         Override main effort: low, medium, high, or max.
  --repair-model MODEL   Override the repair model.
  --repair-effort LEVEL  Override repair effort.
  --timeout MINUTES      Main generation deadline; 0 disables it (default).
  --repair-timeout MIN   Per-repair deadline; 0 disables it (default).
  --port PORT            Host catalog port; finds a free port from 3355 by default.
  --launch BOOL          Launch Harmony Go; true by default.
  --foreground           Run in this terminal instead of tmux.
  --attach               Attach to tmux immediately after starting.
  --smoke-agent          Run the optional model-driven core-flow smoke.
  --dry-run              Print the resolved run without creating files or tmux.
  -h, --help             Show this help.

Examples:
  ./start-livetest.sh --name learning-goals-k3
  ./start-livetest.sh --output-dir my-learning-app
  ./start-livetest.sh --output-dir /absolute/path/my-learning-app
  ./start-livetest.sh --model deepseek-v4-flash --effort low --repair-effort medium
  ./start-livetest.sh --repair-timeout 15
  ./start-livetest.sh --prompt-file ./prompts/ledger.md --candidate brief
`;
}

function take(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parse(argv) {
  const out = { positional: [], launch: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg === '--stdin') out.stdin = true;
    else if (arg === '--foreground' || arg === '--no-tmux') out.foreground = true;
    else if (arg === '--attach') out.attach = true;
    else if (arg === '--smoke-agent') out.smokeAgent = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-launch') out.launch = false;
    else if (arg === '--prompt') out.prompt = take(argv, i++, arg);
    else if (arg === '--prompt-file') out.promptFile = take(argv, i++, arg);
    else if (arg === '--name') out.name = take(argv, i++, arg);
    else if (arg === '--project' || arg === '--output-dir') out.project = take(argv, i++, arg);
    else if (arg === '--app-root') out.appRoot = take(argv, i++, arg);
    else if (arg === '--session') out.session = take(argv, i++, arg);
    else if (arg === '--candidate') out.candidate = take(argv, i++, arg);
    else if (arg === '--model') out.model = take(argv, i++, arg);
    else if (arg === '--effort') out.effort = take(argv, i++, arg);
    else if (arg === '--repair-model' || arg === '--repairModel') out.repairModel = take(argv, i++, arg);
    else if (arg === '--repair-effort' || arg === '--repairEffort') out.repairEffort = take(argv, i++, arg);
    else if (arg === '--port') out.port = Number(take(argv, i++, arg));
    else if (arg === '--timeout') out.timeout = Number(take(argv, i++, arg));
    else if (arg === '--repair-timeout') out.repairTimeout = Number(take(argv, i++, arg));
    else if (arg === '--launch') out.launch = parseBoolean(take(argv, i++, arg), arg);
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

function parseBoolean(value, flag) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${flag} must be true or false`);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'generated-app';
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function projectFromInput(value, appRoot) {
  return isAbsolute(value) ? resolve(value) : resolve(appRoot, value);
}

async function chooseProject(options, appRoot, suggestedName) {
  if (options.project) return projectFromInput(options.project, appRoot);
  if (options.name) return resolve(appRoot, slug(options.name));
  if (!options.dryRun && !options.stdin && process.stdin.isTTY && process.stdout.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('');
      console.log(`请输入生成目录。目录名会放在 ${appRoot} 下，也可以输入绝对路径。`);
      const answer = (await input.question(`生成目录 [${suggestedName}]: `)).trim();
      return projectFromInput(answer || suggestedName, appRoot);
    } finally {
      input.close();
    }
  }
  return resolve(appRoot, suggestedName);
}

async function stdinText() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

async function resolvePrompt(options) {
  const sources = Number(Boolean(options.prompt)) + Number(Boolean(options.promptFile)) + Number(Boolean(options.stdin)) + Number(options.positional.length > 0);
  if (sources > 1) throw new Error('choose only one of --prompt, --prompt-file, --stdin, or positional prompt text');
  if (options.promptFile) {
    const path = resolve(options.promptFile);
    if (!existsSync(path)) throw new Error(`prompt file does not exist: ${path}`);
    const text = readFileSync(path, 'utf8').trim();
    if (!text) throw new Error(`prompt file is empty: ${path}`);
    return { kind: 'file', path, text };
  }
  if (options.stdin) {
    const text = await stdinText();
    if (!text) throw new Error('stdin prompt is empty');
    return { kind: 'stdin', text };
  }
  const inline = options.prompt || options.positional.join(' ').trim();
  if (inline) return { kind: 'inline', text: inline };
  return { kind: 'default', path: defaultPrompt, text: readFileSync(defaultPrompt, 'utf8').trim() };
}

function checkNumber(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return value;
}

function checkOptionalTimeout(value, label, max = 120) {
  if (value === 0) return 0;
  return checkNumber(value, label, 1, max);
}

function executable(command, args = ['--version']) {
  if (command.includes('/') && !existsSync(command)) return false;
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0;
}

function commandOrPath(value) {
  return value.includes('/') ? resolveRunnerPath(value) : value;
}

function portAvailable(port) {
  return new Promise((ok) => {
    const server = createServer();
    server.unref();
    server.once('error', () => ok(false));
    server.listen(port, '127.0.0.1', () => server.close(() => ok(true)));
  });
}

async function freePort(preferred) {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`no free host port found from ${preferred} to ${preferred + 99}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function resolveModels(options) {
  const mode = options.candidate;
  const configured = mode === 'auto' ? null : candidateConfig[mode];
  if (mode !== 'auto' && !configured) throw new Error(`unknown candidate: ${mode}`);
  const model = options.model || configured?.model || 'automatic';
  const effort = options.effort || configured?.effort || 'automatic';
  const repairModel = options.repairModel || options.model || configured?.repairModel || model;
  const repairEffort = options.repairEffort || options.effort || configured?.repairEffort || effort;
  for (const [label, value] of [['effort', effort], ['repair effort', repairEffort]]) {
    if (value !== 'automatic' && !['low', 'medium', 'high', 'max'].includes(value)) throw new Error(`${label} must be low, medium, high, or max`);
  }
  return { model, effort, repairModel, repairEffort };
}

function runnerArguments(plan) {
  const args = [runner,
    '--candidate', plan.candidate,
    '--project', plan.project,
    '--request', plan.requestPath,
    '--claudeTimeoutMinutes', String(plan.timeout),
    '--repairTimeoutMinutes', String(plan.repairTimeout),
    '--launch', String(plan.launch),
    '--port', String(plan.port),
  ];
  if (plan.model !== 'automatic') args.push('--model', plan.model);
  if (plan.effort !== 'automatic') args.push('--effort', plan.effort);
  if (plan.repairModel !== 'automatic') args.push('--repairModel', plan.repairModel);
  if (plan.repairEffort !== 'automatic') args.push('--repairEffort', plan.repairEffort);
  if (plan.smokeAgent) args.push('--smokeAgent', 'true');
  return args;
}

function printPlan(plan, tmuxId = '') {
  console.log('');
  console.log('Expo Harmony Fast live test');
  console.log(`  project : ${plan.project}`);
  console.log(`  prompt  : ${plan.promptKind}${plan.promptSource ? ` (${plan.promptSource})` : ''}`);
  console.log(`  mode    : ${plan.candidate}`);
  console.log(`  model   : ${plan.model}/${plan.effort}`);
  console.log(`  repair  : ${plan.repairModel}/${plan.repairEffort}`);
  console.log(`  launch  : ${plan.launch ? `Harmony Go, port ${plan.port}` : 'disabled'}`);
  if (!plan.foreground) {
    console.log(`  tmux    : ${plan.session}${tmuxId ? ` (${tmuxId})` : ''}`);
    console.log(`  log     : ${plan.sessionLog}`);
    console.log('');
    console.log(`Attach:  tmux attach -t ${shellQuote(plan.session)}`);
    console.log(`Recent:  tmux capture-pane -p -t ${shellQuote(plan.session)} -S -120`);
    console.log(`Log:     tail -f ${shellQuote(plan.sessionLog)}`);
    console.log('Detach:  Ctrl-b, then d');
  }
  console.log('');
}

async function main() {
  const raw = parse(process.argv.slice(2));
  if (raw.help) { console.log(usage()); return; }
  const prompt = await resolvePrompt(raw);
  const appRoot = resolveRunnerPath(raw.appRoot || process.env.EXPO_FAST_APP_ROOT || defaults.appRoot);
  const autoName = `${prompt.kind === 'default' ? 'learning-goals' : 'custom'}-${timestamp()}`;
  const project = await chooseProject(raw, appRoot, autoName);
  const projectName = basename(project);
  const session = raw.session || `expo-fast-${slug(projectName)}`;
  const candidate = raw.candidate || defaults.candidate;
  const timeout = checkOptionalTimeout(raw.timeout ?? defaults.timeout, 'timeout');
  const repairTimeout = checkOptionalTimeout(raw.repairTimeout ?? defaults.repairTimeout, 'repair timeout');
  const port = await freePort(checkNumber(raw.port ?? defaults.firstPort, 'port', 1024, 65535));
  const models = resolveModels({ ...raw, candidate });
  const promptInputDir = join(dirname(project), '.expo-fast-inputs');
  const requestPath = prompt.path || join(promptInputDir, `${slug(projectName)}.md`);
  const node = resolveRunnerPath(process.env.EXPO_FAST_NODE || defaults.node);
  const sdk = resolveRunnerPath(process.env.EXPO_HARMONY_SDK_ROOT || defaults.sdk);
  const deveco = resolveRunnerPath(process.env.DEVECO_PATH || defaults.deveco);
  const claude = commandOrPath(process.env.CLAUDE_BIN || defaults.claude);
  const moduleCache = (process.env.EXPO_FAST_MODULE_CACHE || '')
    .split(delimiter)
    .filter(Boolean)
    .map(resolveRunnerPath)
    .join(delimiter);
  const sessionLog = join(root, '.expo-fast/session-logs', `${slug(session)}.log`);
  const plan = {
    root, configFile: existsSync(localEnvFile) ? localEnvFile : '', project, requestPath, promptKind: prompt.kind, promptSource: prompt.path || '',
    session, sessionLog, candidate, ...models, timeout, repairTimeout, port,
    launch: raw.launch, foreground: Boolean(raw.foreground), attach: Boolean(raw.attach),
    smokeAgent: Boolean(raw.smokeAgent), node, sdk, deveco, claude, moduleCache,
  };

  if (raw.dryRun) {
    console.log(JSON.stringify({ ...plan, promptBytes: Buffer.byteLength(prompt.text) }, null, 2));
    return;
  }

  if (existsSync(project) && readdirSync(project).length > 0) throw new Error(`target must be new and empty: ${project}`);
  if (!existsSync(node)) throw new Error(`Node runtime does not exist: ${node}`);
  if (!existsSync(sdk)) throw new Error(`Expo Harmony SDK does not exist: ${sdk}`);
  if (!existsSync(deveco)) throw new Error(`DevEco Studio does not exist: ${deveco}`);
  if (!executable(claude)) throw new Error(`Claude CLI is not executable: ${claude}`);
  if (!raw.foreground && !executable('tmux', ['-V'])) throw new Error('tmux is not installed or not available on PATH');
  if (!raw.foreground && spawnSync('tmux', ['has-session', '-t', session]).status === 0) throw new Error(`tmux session already exists: ${session}`);

  const hdc = join(deveco, 'Contents/sdk/default/openharmony/toolchains/hdc');
  if (raw.launch) {
    if (!existsSync(hdc)) throw new Error(`hdc does not exist: ${hdc}`);
    const targets = spawnSync(hdc, ['list', 'targets'], { encoding: 'utf8' }).stdout?.trim().split(/\s+/).filter(Boolean) || [];
    if (!targets.length) throw new Error('no Harmony target; start the DevEco emulator first');
    if (targets.length > 1) console.warn(`Warning: runner will use the first Harmony target: ${targets[0]} (${targets.length} targets connected)`);
  }

  mkdirSync(dirname(project), { recursive: true });
  if (!prompt.path) {
    mkdirSync(promptInputDir, { recursive: true });
    writeFileSync(requestPath, `${prompt.text}\n`);
  }

  const args = runnerArguments(plan);
  const env = {
    ...process.env,
    PATH: `${dirname(node)}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    EXPO_FAST_NODE: node,
    EXPO_HARMONY_SDK_ROOT: sdk,
    EXPO_FAST_MODULE_CACHE: moduleCache,
    DEVECO_PATH: deveco,
    CLAUDE_BIN: claude,
    EXPO_FAST_LIVE_CLAUDE: process.env.EXPO_FAST_LIVE_CLAUDE || '1',
  };

  if (raw.foreground) {
    printPlan(plan);
    const result = spawnSync(node, args, { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }

  const exports = [
    ['PATH', env.PATH],
    ['EXPO_FAST_NODE', node],
    ['EXPO_HARMONY_SDK_ROOT', sdk],
    ['EXPO_FAST_MODULE_CACHE', env.EXPO_FAST_MODULE_CACHE],
    ['DEVECO_PATH', deveco],
    ['CLAUDE_BIN', claude],
    ['EXPO_FAST_LIVE_CLAUDE', env.EXPO_FAST_LIVE_CLAUDE],
  ].map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('; ');
  mkdirSync(dirname(sessionLog), { recursive: true });
  const projectLog = join(project, '.expo-fast/session.log');
  const runnerCommand = [node, ...args].map(shellQuote).join(' ');
  const loggedCommand = `${exports}; set -o pipefail; ${runnerCommand} 2>&1 | tee ${shellQuote(sessionLog)}; livetest_status=$pipestatus[1]; echo; echo LIVETEST_EXIT=$livetest_status | tee -a ${shellQuote(sessionLog)}; if [[ -d ${shellQuote(dirname(projectLog))} ]]; then cp ${shellQuote(sessionLog)} ${shellQuote(projectLog)}; fi; exit $livetest_status`;
  const command = `/bin/zsh -lc ${shellQuote(loggedCommand)}`;
  const started = spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', root, command], { encoding: 'utf8' });
  if (started.status !== 0) throw new Error(started.stderr || started.stdout || `failed to start tmux session ${session}`);
  spawnSync('tmux', ['set-option', '-w', '-t', session, 'history-limit', '50000']);
  const tmuxId = spawnSync('tmux', ['display-message', '-p', '-t', session, '#{session_id}'], { encoding: 'utf8' }).stdout?.trim() || '';
  printPlan(plan, tmuxId);
  if (raw.attach) spawnSync('tmux', ['attach-session', '-t', session], { stdio: 'inherit' });
}

main().catch((error) => {
  console.error(`start-livetest: ${error.message}`);
  process.exitCode = 1;
});
