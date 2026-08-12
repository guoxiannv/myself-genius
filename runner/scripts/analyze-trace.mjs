#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const project = resolve(process.argv[2] || '.');
const traceDir = join(project, '.expo-fast');
function traceOrder(name) {
  if (name === 'agent-trace.jsonl') return 0;
  const repair = name.match(/^agent-repair-trace(?:-(\d+))?\.jsonl$/);
  if (repair) return Number(repair[1] || 1);
  const runtimeRepair = name.match(/^agent-runtime-repair-trace(?:-(\d+))?\.jsonl$/);
  if (runtimeRepair) return 1000 + Number(runtimeRepair[1] || 1);
  return Number.MAX_SAFE_INTEGER;
}
const traceNames = existsSync(traceDir)
  ? readdirSync(traceDir)
    .filter((name) => /^(?:agent-trace|agent-repair-trace(?:-\d+)?|agent-runtime-repair-trace(?:-\d+)?)\.jsonl$/.test(name))
    .sort((a, b) => traceOrder(a) - traceOrder(b) || a.localeCompare(b))
  : [];

function rows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function productFile(path = '') {
  return path === join(project, 'App.tsx') || path.startsWith(join(project, 'src/'));
}

function callProductPaths(call) {
  const paths = [];
  if (typeof call.input.file_path === 'string') paths.push(resolve(project, call.input.file_path));
  if (typeof call.input.path === 'string') paths.push(resolve(project, call.input.path));
  if (Array.isArray(call.input.files)) {
    for (const file of call.input.files) {
      if (typeof file?.path === 'string') paths.push(resolve(project, file.path));
    }
  }
  return paths.filter(productFile);
}

function isProductMutation(call) {
  return call.name === 'Write' || call.name === 'Edit' || call.name === 'mcp__expo_fast__write_product_file';
}

function elapsedMs(from, to) {
  if (!from || !to) return null;
  const value = Date.parse(to) - Date.parse(from);
  return Number.isFinite(value) ? value : null;
}

function summarizeTrace(name) {
  const path = join(project, '.expo-fast', name);
  const events = rows(path);
  if (!events.length) return null;
  const calls = new Map();
  for (const event of events) {
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    for (const item of event.message.content) {
      if (item.type !== 'tool_use' || !item.id) continue;
      calls.set(item.id, { name: item.name, input: item.input || {}, timestamp: event.timestamp || '' });
    }
  }
  const uniqueCalls = [...calls.values()];
  const traceStartedAt = events.find((event) => event.timestamp)?.timestamp || null;
  const byTool = {};
  let writeChars = 0; let editOldChars = 0; let editNewChars = 0;
  for (const call of uniqueCalls) {
    byTool[call.name] = (byTool[call.name] || 0) + 1;
    if (call.name === 'Write') writeChars += String(call.input.content || '').length;
    if (call.name === 'mcp__expo_fast__write_product_file') {
      writeChars += String(call.input.content || '').length;
    }
    if (call.name === 'Edit') {
      editOldChars += String(call.input.old_string || '').length;
      editNewChars += String(call.input.new_string || '').length;
    }
  }
  const productCalls = uniqueCalls.filter((call) => callProductPaths(call).length > 0);
  const productMutations = productCalls.filter(isProductMutation);
  const writtenPaths = [...new Set(productMutations.flatMap(callProductPaths))].sort();
  const firstProductWrite = productMutations[0] || null;
  const lastProductMutation = productMutations.at(-1) || null;
  const productByTool = {};
  for (const call of productCalls) productByTool[call.name] = (productByTool[call.name] || 0) + 1;
  const result = [...events].reverse().find((event) => event.type === 'result');
  const traceModels = [...new Set(events.filter((event) => event.type === 'assistant' && event.message?.model).map((event) => event.message.model))];
  return {
    path,
    bytes: statSync(path).size,
    apiDurationMs: result?.duration_api_ms ?? result?.duration_ms ?? null,
    turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    usage: result?.usage ?? null,
    terminalReason: result?.terminal_reason ?? null,
    isError: result?.is_error ?? null,
    traceStartedAt,
    traceModels,
    billedModels: Object.keys(result?.modelUsage || {}),
    byTool,
    productByTool,
    writeChars,
    filesWritten: writtenPaths.length,
    writtenPaths: writtenPaths.map((file) => relative(project, file)),
    editOldChars,
    editNewChars,
    firstProductCall: productCalls[0] || null,
    lastProductCall: productCalls.at(-1) || null,
    firstProductWrite,
    lastProductMutation,
    firstProductWriteLatencyMs: elapsedMs(traceStartedAt, firstProductWrite?.timestamp),
    codeWriteWindowMs: elapsedMs(firstProductWrite?.timestamp, lastProductMutation?.timestamp),
  };
}

function walk(root, output = []) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, output);
    else if (/\.[jt]sx?$/.test(entry.name)) output.push(path);
  }
  return output;
}

const productPaths = [join(project, 'App.tsx'), ...walk(join(project, 'src'))].filter(existsSync).sort();
const product = {
  files: productPaths.length,
  lines: productPaths.reduce((sum, path) => sum + readFileSync(path, 'utf8').split(/\r?\n/).length, 0),
  bytes: productPaths.reduce((sum, path) => sum + statSync(path).size, 0),
  paths: productPaths.map((path) => relative(project, path)),
};
const experimentPath = join(project, '.expo-fast/experiment.json');
const resultPath = join(project, '.expo-fast/result.json');
const output = {
  project,
  experiment: existsSync(experimentPath) ? JSON.parse(readFileSync(experimentPath, 'utf8')) : null,
  result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null,
  product,
  traces: traceNames.map(summarizeTrace).filter(Boolean),
};

console.log(JSON.stringify(output, null, 2));
