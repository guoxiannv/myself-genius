import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const FORBIDDEN_ORCHESTRATOR_FILES = new Set([
  '.expo-fast/agent-trace.jsonl',
  '.expo-fast/experiment.json',
  '.expo-fast/module-cache.json',
  '.expo-fast/request.md',
  '.expo-fast/scaffold-package.json',
]);
const ALLOWED_PRODUCT_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'mcp__expo_fast__check',
  'mcp__expo_fast__build',
]);

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function rows(tracePath) {
  return readFileSync(tracePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function calls(events) {
  return events.flatMap((row) => {
    const content = row?.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((part) => part?.type === 'tool_use').map((part) => ({ id: part.id, name: part.name, input: part.input || {} }));
  });
}

function pathCandidate(project, value, base = project) {
  if (typeof value !== 'string' || !value) return null;
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

export function auditImplementationTrace(projectDir, tracePath) {
  const project = resolve(projectDir);
  const events = rows(tracePath);
  const violations = [];
  const permissionDeniedIds = new Set(events.flatMap((row) => row?.permission_denials || []).map((entry) => entry?.tool_use_id).filter(Boolean));
  const blockedAttempts = [];
  const add = (type, call, value = '') => violations.push({ type, tool: call.name, value });

  for (const call of calls(events)) {
    const input = call.input || {};
    if (permissionDeniedIds.has(call.id)) {
      blockedAttempts.push({ tool: call.name, value: String(input.file_path || input.path || input.command || '') });
      continue;
    }
    if (!ALLOWED_PRODUCT_TOOLS.has(call.name)) add('unexpected-product-tool', call);
    if (call.name === 'Bash') add('forbidden-shell-tool', call, String(input.command || ''));

    for (const key of ['file_path', 'path']) {
      const candidate = pathCandidate(project, input[key]);
      if (!candidate) continue;
      if (!inside(project, candidate)) add('outside-project-read', call, String(input[key]));
      const rel = relative(project, candidate).replaceAll('\\', '/');
      if (call.name !== 'Write' && call.name !== 'Edit' && FORBIDDEN_ORCHESTRATOR_FILES.has(rel)) {
        add('orchestrator-artifact-read', call, rel);
      }
      if (call.name !== 'Write' && call.name !== 'Edit' && (rel === 'node_modules' || rel.startsWith('node_modules/'))) {
        add('dependency-source-scan', call, rel);
      }
      if (call.name === 'Read') {
        const allowedRead = ['AGENTS.md', 'package.json', 'app.json', 'index.js', 'tsconfig.json', 'App.tsx', '.expo-fast/model-capability-index.txt', '.expo-fast/sdk-fingerprint.json', '.expo-fast/verification-errors.txt', '.expo-fast/capability-selection.json', '.expo-fast/capability-resolution.log', '.expo-fast/typecheck.log', '.expo-fast/source-audit.json', '.expo-fast/source-audit.log', '.expo-fast/export.log', '.expo-fast/build-evidence.json'].includes(rel)
          || rel.startsWith('src/');
        if (!allowedRead) add('non-whitelisted-read', call, rel);
      }
      if (call.name === 'Write' || call.name === 'Edit') {
        const allowedWrite = rel === 'App.tsx'
          || rel === '.expo-fast/brief.json'
          || rel.startsWith('src/')
          || (call.name === 'Edit' && rel === 'package.json');
        if (!allowedWrite) add('forbidden-product-write', call, rel);
      }
    }

    if (typeof input.pattern === 'string') {
      const base = pathCandidate(project, input.path) || project;
      const candidate = pathCandidate(project, input.pattern, base);
      if (candidate && !inside(project, candidate)) add('outside-project-glob', call, input.pattern);
      if (/(^|\/)node_modules(?:\/|$)/.test(input.pattern)) add('dependency-source-scan', call, input.pattern);
    }

    if (Array.isArray(input.files)) {
      for (const file of input.files) {
        const value = file?.path;
        const candidate = pathCandidate(project, value);
        if (!candidate) continue;
        if (!inside(project, candidate)) add('outside-project-write', call, String(value));
        const rel = relative(project, candidate).replaceAll('\\', '/');
        const allowed = rel === 'App.tsx'
          || rel === '.expo-fast/brief.json'
          || /^src\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json)$/.test(rel)
          || /^assets\/[A-Za-z0-9_./-]+\.(?:json|txt|svg)$/.test(rel);
        if (!allowed) add('forbidden-product-write', call, rel);
      }
    }

    if (call.name === 'mcp__expo_fast__write_product_file') {
      const candidate = pathCandidate(project, input.path);
      const rel = candidate ? relative(project, candidate).replaceAll('\\', '/') : '';
      const allowed = rel === 'App.tsx'
        || rel === '.expo-fast/brief.json'
        || /^src\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json)$/.test(rel)
        || /^assets\/[A-Za-z0-9_./-]+\.(?:json|txt|svg)$/.test(rel);
      if (!candidate || !inside(project, candidate)) add('outside-project-write', call, String(input.path || ''));
      else if (!allowed) add('forbidden-product-write', call, rel);
    }
  }

  const unique = [...new Map(violations.map((entry) => [JSON.stringify(entry), entry])).values()];
  return {
    schemaVersion: 1,
    status: unique.length ? 'fail' : 'pass',
    project,
    tracePath: resolve(tracePath),
    violationCount: unique.length,
    violations: unique,
    blockedAttemptCount: blockedAttempts.length,
    blockedAttempts,
  };
}
