import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// What Claude Code actually sends, captured by pointing it at an endpoint on
// this machine. Free and offline: nothing here leaves the host, and no model is
// asked anything.
//
// This is the only way to check the flags and variables the orchestrator hard
// codes. They are not configuration -- nobody can set them -- so nothing else in
// this repository has ever had a way to ask whether they do what their names
// say. Each check below is a contrast: run once with the knob and once without,
// and name the difference in what came out.

// A minimal well-formed reply. An error reply would also capture the request,
// but Claude Code then reports a failure, and a probe whose success case looks
// like a failure is one nobody will trust the day it matters.
function streamEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
function replyOnce(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.write(streamEvent({
    type: 'message_start',
    message: { id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  }));
  response.write(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  response.write(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }));
  response.write(streamEvent({ type: 'content_block_stop', index: 0 }));
  response.write(streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }));
  response.write(streamEvent({ type: 'message_stop' }));
  response.end();
}

export function startCaptureEndpoint() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      if (request.method === 'POST' && request.url.includes('/v1/messages')) {
        try { requests.push(JSON.parse(raw)); } catch { requests.push({ unparsed: raw }); }
        return replyOnce(response);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => ready({
      requests,
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((closed) => server.close(closed)),
    }));
  });
}

// The real Claude Code, not claude-isolated. The launcher sources llm.env last
// and would put the configured endpoint back, which is exactly what this probe
// must not talk to. No credential is needed to reach a server on loopback.
export function claudeBinary() {
  return process.env.GENIUS_CLAUDE_REAL_BIN || 'claude';
}

// Everything a run needs, in the order that matters. The prompt is last, and
// nothing may sit between it and a flag whose value is empty: measured against
// 2.1.241, `--tools '' <prompt>` consumes the prompt as the flag's value and
// Claude Code exits reporting that no input was given. The design turn is safe
// only because --output-format follows its empty --tools, which is a property
// no one had written down; a test now holds it.
export async function captureRequest({ flags = [], env = {}, cwd, timeoutMs = 60_000 }) {
  const endpoint = await startCaptureEndpoint();
  const configDir = mkdtempSync(join(tmpdir(), 'expo-fast-capture-cc-'));
  // Caller flags sit where the design turn's do: before --output-format, never
  // immediately before the prompt. That ordering is what keeps an empty value
  // such as --tools '' from swallowing the prompt, and building the probe the
  // other way round is how the trap was found.
  const args = ['-p', '--permission-mode', 'dontAsk', '--model', 'probe-model', '--effort', 'low',
    ...flags, '--output-format', 'stream-json', '--verbose', 'Reply OK'];
  let output = '';
  // try/finally, because the endpoint holds a port and the config directory is
  // real: a throw between here and the end would leak both, and a probe that
  // litters when it fails is one people stop running.
  try {
    const exitCode = await new Promise((settle) => {
      const child = spawn(claudeBinary(), args, {
        cwd,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: endpoint.origin,
          ANTHROPIC_AUTH_TOKEN: 'probe',
          CLAUDE_CONFIG_DIR: configDir,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', () => { clearTimeout(timer); settle(-1); });
      child.on('exit', (code) => { clearTimeout(timer); settle(code); });
    });
    const events = output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    return {
      exitCode,
      output,
      request: endpoint.requests[0] ?? null,
      requestCount: endpoint.requests.length,
      init: events.find((event) => event.subtype === 'init') ?? null,
    };
  } finally {
    await endpoint.close();
    rmSync(configDir, { recursive: true, force: true });
  }
}

// A workspace with something for each knob to act on: a CLAUDE.md an ancestor
// walk would pick up, an MCP server a strict configuration should ignore, and a
// file to append. The markers are what make the difference readable rather than
// inferred from a byte count.
export const ancestorMarker = 'ANCESTOR-MARKER-6f2a';
export const appendedMarker = 'APPENDED-MARKER-9c41';
export function prepareWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'expo-fast-capture-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), `${ancestorMarker}: an instruction from a file nobody passed.\n`);
  writeFileSync(join(dir, 'appended.txt'), `${appendedMarker}: the product contract.\n`);
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { ghost: { command: '/bin/echo', args: ['hi'] } } }));
  return dir;
}

// The whole request, for looking where a value might land rather than where we
// assume it lands. Measured: a project CLAUDE.md arrives among the messages, not
// in the system prompt, while --append-system-prompt-file lands in system. A
// check that only read `system` would have reported the CLAUDE.md walk as
// already disabled -- the right answer for the wrong reason, which is worse than
// a wrong one.
export const bodyText = (request) => JSON.stringify(request ?? null);

export function systemText(request) {
  const system = request?.system;
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map((block) => (typeof block === 'string' ? block : String(block?.text ?? ''))).join('\n');
}
export const toolNames = (request) => (Array.isArray(request?.tools) ? request.tools.map((tool) => String(tool?.name ?? '')) : []);
export const mcpNames = (capture) => (capture.init?.mcp_servers || []).map((server) => String(server?.name ?? ''));
