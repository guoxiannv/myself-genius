#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compactVerificationError, verifyImplementation } from './verification.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const project = resolve(argument('--project'));
if (!argument('--project')) throw new Error('--project is required');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const tools = [
  {
    name: 'check',
    description: 'Synchronize allowed dependencies, run TypeScript typecheck, and run the Expo Harmony product source audit for the current project. Use after meaningful code edits and fix every reported diagnostic.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'build',
    description: 'Run the full deterministic Expo Harmony check, export the Harmony Go bundle, and audit the exported artifact for the current project. Use once the requested change is complete.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'expo-fast-agent-tools', version: '1.0.0' },
    });
    return;
  }
  if (message.method === 'ping') { result(message.id, {}); return; }
  if (message.method === 'tools/list') { result(message.id, { tools }); return; }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (!tools.some((tool) => tool.name === name)) { failure(message.id, -32602, `unknown tool: ${name}`); return; }
    try {
      const verification = verifyImplementation({ project, level: name });
      writeFileSync(join(project, '.expo-fast/verification-errors.txt'), '');
      result(message.id, {
        content: [{ type: 'text', text: JSON.stringify(verification) }],
        structuredContent: verification,
      });
    } catch (error) {
      const detail = compactVerificationError(error);
      writeFileSync(join(project, '.expo-fast/verification-errors.txt'), `${detail}\n`);
      result(message.id, {
        content: [{ type: 'text', text: detail }],
        structuredContent: { status: 'failed', level: name, error: detail, stages: error.stages || {} },
        isError: true,
      });
    }
    return;
  }
  if (message.id !== undefined) failure(message.id, -32601, `method not found: ${message.method}`);
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try { void handle(JSON.parse(line)); }
    catch (error) { process.stderr.write(`${error.stack || error}\n`); }
  }
});
