import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dependencies = join(root, 'scripts/dependencies.mjs');
const verifier = join(root, 'scripts/verify-product.mjs');

function runCommand(cmd, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (options.log) writeFileSync(options.log, `${result.stdout || ''}${result.stderr || ''}`);
  const ms = Date.now() - started;
  if (result.status !== 0) {
    const error = new Error(`${cmd} exited ${result.status}\n${result.stderr || result.stdout || ''}`);
    error.stageMs = ms;
    throw error;
  }
  return { ms, stdout: result.stdout || '' };
}

export function verifyImplementation({
  project: projectDir,
  catalogRoot: outputDir,
  node = process.env.EXPO_FAST_NODE || process.execPath,
  metrics = null,
  suffix = '',
  level = 'build',
} = {}) {
  const project = resolve(projectDir);
  const catalogRoot = resolve(outputDir || join(project, 'dist/harmony-go'));
  const webRoot = join(project, 'dist/web');
  if (!['check', 'build'].includes(level)) throw new Error(`unknown verification level: ${level}`);
  const stageName = (name) => `${name}${suffix}`;
  const stages = {};
  const diagnostics = [];
  const record = (name, ms) => {
    stages[name] = ms;
    if (metrics) {
      metrics.stages ||= {};
      metrics.stages[stageName(name)] = ms;
    }
  };
  const check = (name, cmd, args, log) => {
    const started = Date.now();
    try {
      const result = runCommand(cmd, args, { cwd: project, log });
      record(name, result.ms);
    } catch (error) {
      record(name, error.stageMs ?? Date.now() - started);
      diagnostics.push(`${name}:\n${error.stack || error}`);
    }
  };

  check('dependencySyncMs', node, [dependencies, 'sync', project], join(project, '.expo-fast/capability-resolution.log'));
  if (metrics && existsSync(join(project, '.expo-fast/capability-selection.json'))) {
    metrics.capabilities = JSON.parse(readFileSync(join(project, '.expo-fast/capability-selection.json'), 'utf8'));
  }
  check('typecheckMs', node, [join(project, 'node_modules/typescript/bin/tsc'), '--noEmit'], join(project, '.expo-fast/typecheck.log'));
  check('sourceAuditMs', node, [verifier, 'audit', project], join(project, '.expo-fast/source-audit-command.log'));
  if (diagnostics.length) {
    const error = new Error(`Deterministic product diagnostics failed (${diagnostics.length}):\n\n${diagnostics.join('\n\n')}`);
    error.diagnostics = diagnostics;
    error.stages = stages;
    throw error;
  }

  if (level === 'build') {
    const exported = runCommand(node, [dependencies, 'export', project, catalogRoot], { cwd: project });
    record('exportMs', exported.ms);
    const webExported = runCommand(node, [dependencies, 'export-web', project, webRoot], { cwd: project });
    record('webExportMs', webExported.ms);
    const audited = runCommand(node, [verifier, 'artifacts', project, catalogRoot], {
      cwd: project,
      log: join(project, '.expo-fast/artifact-audit-command.log'),
    });
    record('artifactAuditMs', audited.ms);
  }

  return { status: 'passed', level, project, catalogRoot, stages };
}

export function compactVerificationError(error, limit = 12000) {
  return String(error?.stack || error).slice(0, limit);
}
