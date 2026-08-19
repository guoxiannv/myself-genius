#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeRunState } from './run-state.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const launcher = join(root, 'start-livetest.sh');
const stateName = '.expo-fast/follow-up.json';
const lockName = '.expo-fast/follow-up.lock';

function parse(argv) {
  const out = { command: argv[0] || '' };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json-stdin') out.jsonStdin = true;
    else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
  }
  return out;
}

function now() { return new Date().toISOString(); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function statePath(project) { return join(project, stateName); }
function lockPath(project) { return join(project, lockName); }
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function resultSession(project) {
  return readJson(join(project, '.expo-fast/result.json'), {})?.sessionId || '';
}
function defaultState(project, runName = '') {
  return {
    schemaVersion: 1,
    runtime: 'expo',
    run_name: runName || basename(project),
    session_id: resultSession(project),
    status: resultSession(project) ? 'idle' : 'unavailable',
    sequence: 0,
    queue: [],
    history: [],
    active_command: null,
    interrupt_command: null,
    worker_pid: null,
    active_pid: null,
    transcript_path: '',
    last_error: resultSession(project) ? '' : '首轮 Agent session 尚未就绪。',
    last_idle_at: resultSession(project) ? now() : null,
    updated_at: now(),
  };
}
function loadState(project, runName = '') {
  const state = readJson(statePath(project), defaultState(project, runName));
  state.runtime = 'expo';
  state.run_name ||= runName || basename(project);
  const discoveredSession = resultSession(project);
  state.session_id ||= discoveredSession;
  state.queue ||= [];
  state.history ||= [];
  state.sequence ||= 0;
  if (state.session_id && state.status === 'unavailable') {
    state.status = 'idle';
    state.last_error = '';
    state.last_idle_at ||= now();
  }
  return state;
}
function saveState(project, state) {
  state.updated_at = now();
  writeJson(statePath(project), state);
  return state;
}
function withLock(project, callback) {
  mkdirSync(join(project, '.expo-fast'), { recursive: true });
  const path = lockPath(project);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) { rmSync(path, { recursive: true, force: true }); continue; }
      } catch {}
      if (Date.now() >= deadline) throw new Error('follow-up state is busy');
      sleep(25);
    }
  }
  try { return callback(); }
  finally { rmSync(path, { recursive: true, force: true }); }
}
function publicCommand(command, includeText = false) {
  if (!command) return null;
  const value = { ...command };
  delete value.request_path;
  if (!includeText) delete value.text;
  return value;
}
function publicState(state) {
  return {
    run_name: state.run_name,
    session_id: state.session_id,
    runtime: 'expo',
    status: state.status,
    transcript_path: state.transcript_path || '',
    queue_length: state.queue.length,
    active_command_id: state.active_command?.id || null,
    interrupt_command_id: state.interrupt_command?.id || null,
    last_idle_at: state.last_idle_at || null,
    last_error: state.last_error || '',
    active_command: publicCommand(state.active_command),
    interrupt_command: publicCommand(state.interrupt_command),
    queue: state.queue.map((command) => publicCommand(command)),
    history: state.history.slice(-24).map((command) => publicCommand(command, true)),
    updated_at: state.updated_at,
  };
}
function response(state, extra = {}) {
  return { ok: true, ...extra, follow_up: publicState(state) };
}
function output(value, status = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = status;
}
function controlError(error, code = 'internal_error', details = {}) {
  output({ ok: false, error: String(error?.message || error), code, details }, 1);
}
async function stdinJson(enabled) {
  if (!enabled) return {};
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}
function startWorker(project, runName, state) {
  if (processAlive(state.worker_pid)) return state;
  const logPath = join(project, '.expo-fast/follow-up-worker.log');
  const log = openSync(logPath, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'work', '--cwd', project, '--run', runName], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  closeSync(log);
  child.unref();
  state.worker_pid = child.pid;
  if (state.status === 'idle') state.status = 'starting';
  return state;
}
function latestRevisionTrace(project) {
  const result = readJson(join(project, '.expo-fast/result.json'), {});
  const revisions = Array.isArray(result.revisions) ? result.revisions : [];
  const trace = revisions.at(-1)?.trace;
  return trace ? resolve(project, trace) : '';
}
function finalizeRevision(project, status, error = '') {
  const path = join(project, '.expo-fast/result.json');
  const result = readJson(path, {});
  const revisions = Array.isArray(result.revisions) ? result.revisions : [];
  const revision = revisions.at(-1);
  if (!revision || revision.kind !== 'follow-up' || revision.status !== 'running') return;
  const completedAt = now();
  revision.status = status === 'completed' ? 'passed' : status;
  revision.completedAt = completedAt;
  const startedAt = Date.parse(revision.startedAt || '');
  if (Number.isFinite(startedAt)) revision.durationMs = Math.max(0, Date.parse(completedAt) - startedAt);
  if (error) revision.error = error.slice(0, 4000);
  writeJson(path, result);
}
async function runWorker(project, runName) {
  for (;;) {
    const command = withLock(project, () => {
      const state = loadState(project, runName);
      if (!state.queue.length) {
        state.status = 'idle';
        state.worker_pid = null;
        state.active_pid = null;
        state.active_command = null;
        state.interrupt_command = null;
        state.last_idle_at = now();
        saveState(project, state);
        return null;
      }
      const next = state.queue.shift();
      next.status = 'starting';
      next.send_started_at = now();
      state.active_command = next;
      state.interrupt_command = null;
      state.status = 'starting';
      state.last_error = '';
      saveState(project, state);
      return next;
    });
    if (!command) return;

    const args = [
      '--foreground', '--project', project,
      '--prompt-file', join(project, '.expo-fast/request.md'),
      '--follow-up-file', command.request_path,
      '--launch', 'false', '--hap', 'false',
    ];
    const logPath = join(project, '.expo-fast/follow-up-worker.log');
    const log = openSync(logPath, 'a');
    const child = spawn(launcher, args, { cwd: root, detached: true, stdio: ['ignore', log, log], env: process.env });
    closeSync(log);
    withLock(project, () => {
      const state = loadState(project, runName);
      if (state.active_command?.id === command.id) {
        state.active_command.status = 'running';
        state.active_command.sent_at = now();
        state.active_pid = child.pid;
        state.status = 'running';
        saveState(project, state);
      }
    });
    const exit = await new Promise((resolveExit) => {
      child.on('error', (error) => resolveExit({ code: 1, error: String(error.stack || error) }));
      child.on('exit', (code, signal) => resolveExit({ code: code ?? 1, signal }));
    });
    withLock(project, () => {
      const state = loadState(project, runName);
      const active = state.active_command?.id === command.id ? state.active_command : command;
      const interrupted = state.status === 'interrupting' || exit.signal === 'SIGINT' || exit.signal === 'SIGTERM';
      active.status = interrupted ? 'interrupted' : exit.code === 0 ? 'completed' : 'failed';
      active.completed_at = now();
      if (interrupted) active.interrupted_at = active.completed_at;
      if (exit.error || (exit.code !== 0 && !interrupted)) active.error = exit.error || `follow-up runner exited ${exit.code}`;
      active.result = active.status;
      finalizeRevision(project, active.status, active.error || '');
      if (interrupted) {
        writeRunState(project, 'completed', {
          detail: 'follow_up_interrupted',
          context: { action: 'follow-up', result: 'interrupted' },
          reset: true,
        });
      }
      state.history.push(active);
      state.history = state.history.slice(-50);
      state.active_command = null;
      state.interrupt_command = null;
      state.active_pid = null;
      state.transcript_path = latestRevisionTrace(project) || state.transcript_path;
      state.last_error = active.error || '';
      state.status = state.queue.length ? 'starting' : 'idle';
      if (!state.queue.length) state.last_idle_at = now();
      saveState(project, state);
    });
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  const project = resolve(options.cwd || '');
  if (!options.cwd || !existsSync(project)) throw Object.assign(new Error('valid --cwd is required'), { code: 'run_not_found' });
  const body = await stdinJson(options.jsonStdin);
  const runName = options.run || basename(project);
  if (options.command === 'work') { await runWorker(project, runName); return; }

  if (options.command === 'status') {
    const state = withLock(project, () => {
      const current = loadState(project, runName);
      if (current.status !== 'idle' && current.status !== 'unavailable' && !processAlive(current.worker_pid)) {
        current.status = current.queue.length ? 'starting' : 'idle';
        current.worker_pid = null;
        current.active_pid = null;
        if (current.active_command) {
          current.active_command.status = 'failed';
          current.active_command.completed_at = now();
          current.active_command.error = 'follow-up worker stopped unexpectedly';
          finalizeRevision(project, 'failed', current.active_command.error);
          writeRunState(project, 'completed', {
            detail: 'follow_up_failed',
            context: { action: 'follow-up', result: 'failed' },
            reset: true,
            error: current.active_command.error,
          });
          current.history.push(current.active_command);
          current.active_command = null;
        }
        if (current.queue.length) startWorker(project, runName, current);
        saveState(project, current);
      }
      return current;
    });
    output(response(state));
    return;
  }

  if (options.command === 'enqueue') {
    const text = String(body.text || '').trim();
    if (!text) throw Object.assign(new Error('follow-up message is empty'), { code: 'empty_message' });
    if (text.length > 20_000) throw Object.assign(new Error('follow-up message is too large'), { code: 'message_too_large' });
    const clientId = String(body.clientMessageId || randomUUID());
    const value = withLock(project, () => {
      const state = loadState(project, runName);
      const existing = [state.active_command, ...state.queue, ...state.history].find((command) => command?.client_request_id === clientId);
      if (existing) return { state, command: existing, duplicate: true };
      if (!state.session_id) throw Object.assign(new Error('initial Agent session is unavailable'), { code: 'invalid_follow_up_session' });
      const id = randomUUID();
      const requestPath = join(project, '.expo-fast/follow-ups', `${id}.md`);
      mkdirSync(dirname(requestPath), { recursive: true });
      writeFileSync(requestPath, `${text}\n`);
      const command = { id, client_request_id: clientId, type: 'message', status: 'queued', sequence: ++state.sequence, created_at: now(), text, request_path: requestPath };
      state.queue.push(command);
      state.status = state.active_command ? state.status : 'starting';
      startWorker(project, runName, state);
      saveState(project, state);
      return { state, command, duplicate: false };
    });
    output(response(value.state, { accepted: true, duplicate: value.duplicate, command: publicCommand(value.command) }));
    return;
  }

  if (options.command === 'update') {
    const commandId = String(body.commandId || '');
    const text = String(body.text || '').trim();
    if (!commandId) throw Object.assign(new Error('commandId is required'), { code: 'invalid_command_id' });
    if (!text) throw Object.assign(new Error('follow-up message is empty'), { code: 'empty_message' });
    if (text.length > 20_000) throw Object.assign(new Error('follow-up message is too large'), { code: 'message_too_large' });
    const value = withLock(project, () => {
      const state = loadState(project, runName);
      const command = state.queue.find((item) => item.id === commandId);
      if (!command) throw Object.assign(new Error('queued command was not found'), { code: 'command_not_queued' });
      command.text = text;
      writeFileSync(command.request_path, `${text}\n`);
      saveState(project, state);
      return { state, command };
    });
    output(response(value.state, { accepted: true, duplicate: false, command: publicCommand(value.command) }));
    return;
  }

  if (options.command === 'remove') {
    const commandId = String(body.commandId || '');
    const value = withLock(project, () => {
      const state = loadState(project, runName);
      const index = state.queue.findIndex((item) => item.id === commandId);
      if (index < 0) throw Object.assign(new Error('queued command was not found'), { code: 'command_not_queued' });
      const [command] = state.queue.splice(index, 1);
      command.status = 'cancelled';
      command.completed_at = now();
      state.history.push(command);
      saveState(project, state);
      return { state, command };
    });
    output(response(value.state, { accepted: true, duplicate: false, command: publicCommand(value.command) }));
    return;
  }

  if (options.command === 'interrupt') {
    const value = withLock(project, () => {
      const state = loadState(project, runName);
      if (!state.active_command || !processAlive(state.active_pid)) throw Object.assign(new Error('no running follow-up command'), { code: 'control_busy' });
      const command = { id: randomUUID(), client_request_id: String(body.clientActionId || randomUUID()), type: 'interrupt', status: 'submitted', sequence: ++state.sequence, created_at: now() };
      state.interrupt_command = command;
      state.status = 'interrupting';
      saveState(project, state);
      return { state, command, pid: state.active_pid };
    });
    try { process.kill(-value.pid, 'SIGINT'); } catch { try { process.kill(value.pid, 'SIGINT'); } catch {} }
    output(response(value.state, { accepted: true, duplicate: false, command: publicCommand(value.command) }));
    return;
  }

  throw Object.assign(new Error('usage: follow-up-control status|enqueue|update|remove|interrupt --cwd PROJECT --run NAME [--json-stdin]'), { code: 'invalid_command' });
}

main().catch((error) => controlError(error, error.code || 'internal_error'));
