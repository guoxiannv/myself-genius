import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const HAP_OUTPUT_RELATIVE_PATH = '.expo-fast/hap';
export const HAP_RESULT_FILE = 'build-result.json';
export const HAP_DEVICE_TYPES = Object.freeze(['phone', '2in1']);

function within(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function serializedError(error) {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error || 'Unknown HAP build failure').slice(0, 4000),
  };
}

function validateReadyResult(project, outputRoot, resultPath, metadata) {
  if (metadata.status !== 'success') return null;
  if (metadata.buildMode !== 'release') {
    throw new Error(`Harmony pool result is not a release HAP: ${metadata.buildMode || '<missing>'}`);
  }
  if (!Array.isArray(metadata.deviceTypes) || HAP_DEVICE_TYPES.some((value) => !metadata.deviceTypes.includes(value))) {
    throw new Error(
      `Harmony pool result does not support required device types ${HAP_DEVICE_TYPES.join(',')}: ` +
      `${JSON.stringify(metadata.deviceTypes ?? null)}`,
    );
  }
  if (typeof metadata.hapPath !== 'string' || !metadata.hapPath) {
    throw new Error(`Successful Harmony pool result has no HAP path: ${resultPath}`);
  }
  const requested = resolve(metadata.hapPath);
  if (!within(requested, outputRoot)) {
    throw new Error(`Harmony pool published HAP outside the run output: ${requested}`);
  }
  if (!existsSync(requested) || !lstatSync(requested).isFile() || lstatSync(requested).isSymbolicLink()) {
    throw new Error(`Harmony pool HAP is missing or invalid: ${requested}`);
  }
  const hapPath = realpathSync(requested);
  if (!within(hapPath, outputRoot)) {
    throw new Error(`Harmony pool HAP resolves outside the run output: ${hapPath}`);
  }
  const hapSha256 = sha256File(hapPath);
  if (metadata.hapSha256 && metadata.hapSha256 !== hapSha256) {
    throw new Error(`Harmony pool HAP hash differs from build-result.json: ${hapPath}`);
  }
  if (resolve(metadata.productRoot || '') !== project) {
    throw new Error(`Harmony pool result belongs to another product: ${metadata.productRoot || '<missing>'}`);
  }
  return { hapPath, hapSha256 };
}

function publicResult(metadata, resultPath, ready = null) {
  const error = metadata.error && typeof metadata.error === 'object'
    ? String(metadata.error.message || '')
    : String(metadata.error || '');
  return {
    status: ready ? 'ready' : metadata.status === 'failed' ? 'failed' : String(metadata.status || 'failed'),
    jobId: String(metadata.jobId || ''),
    slotId: metadata.slotId ?? null,
    durationMs: Number(metadata.durationMs) || 0,
    failureStage: metadata.failureStage ?? null,
    error: error.slice(0, 4000),
    hapPath: ready?.hapPath || null,
    hapSha256: ready?.hapSha256 || null,
    bundleName: metadata.bundleName ?? null,
    deviceTypes: Array.isArray(metadata.deviceTypes) ? metadata.deviceTypes : [],
    buildMode: metadata.buildMode ?? null,
    resultPath,
    logPath: typeof metadata.logPath === 'string' ? metadata.logPath : null,
    startedAt: metadata.startedAt ?? null,
    completedAt: metadata.completedAt ?? null,
  };
}

function writeSyntheticFailure(resultPath, { jobId, project, error, durationMs = 0 }) {
  const metadata = {
    schemaVersion: 1,
    status: 'failed',
    producer: 'expo-harmony-fast-runner',
    jobId,
    productRoot: project,
    durationMs,
    failureStage: 'pool-command',
    error: serializedError(error),
    hapPath: null,
    hapSha256: null,
    bundleName: null,
    logPath: null,
    resultPath,
    completedAt: new Date().toISOString(),
  };
  writeFileSync(resultPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export function readExistingHapResult(projectRoot, requestedOutputRoot = null) {
  const project = resolve(projectRoot);
  const outputRoot = requestedOutputRoot
    ? resolve(requestedOutputRoot)
    : resolve(project, HAP_OUTPUT_RELATIVE_PATH);
  const resultPath = join(outputRoot, HAP_RESULT_FILE);
  if (!existsSync(resultPath)) return null;
  try {
    const metadata = readJson(resultPath);
    const ready = validateReadyResult(project, outputRoot, resultPath, metadata);
    return publicResult(metadata, resultPath, ready);
  } catch {
    return null;
  }
}

export function runHapPoolBuild({
  project: projectRoot,
  sdk: sdkRoot,
  pool: poolRoot,
  node = process.execPath,
  runId,
  waitSeconds = 3600,
  buildMode = 'release',
  reuseExisting = true,
  outputRoot: requestedOutputRoot = null,
  commandRunner = spawnSync,
}) {
  const startedAt = Date.now();
  const project = realpathSync(resolve(projectRoot));
  const sdk = realpathSync(resolve(sdkRoot));
  const pool = resolve(poolRoot);
  const outputRoot = requestedOutputRoot
    ? resolve(requestedOutputRoot)
    : resolve(project, HAP_OUTPUT_RELATIVE_PATH);
  const resultPath = join(outputRoot, HAP_RESULT_FILE);
  mkdirSync(outputRoot, { recursive: true });

  if (reuseExisting) {
    const existing = readExistingHapResult(project, outputRoot);
    if (existing?.status === 'ready') return { ...existing, reused: true };
  } else {
    // A forced rebuild must publish fresh metadata. Otherwise a pool command that
    // exits without writing output could make the previous HAP look current.
    rmSync(resultPath, { force: true });
  }

  const safeRunId = String(runId || basename(project)).replace(/[^A-Za-z0-9._-]+/g, '-');
  const deviceType = HAP_DEVICE_TYPES.join(',');
  const jobId = `hap-${safeRunId}-${HAP_DEVICE_TYPES.join('-')}`;
  if (!['debug', 'release'].includes(buildMode)) {
    throw new Error(`Unsupported Harmony HAP build mode: ${buildMode}`);
  }
  const poolScript = join(sdk, 'tools/harmony/full-profile-pool.mjs');
  const args = [
    poolScript,
    'build',
    '--pool', pool,
    '--app', project,
    '--job-id', jobId,
    '--output', outputRoot,
    '--wait-seconds', String(waitSeconds),
    '--build-mode', buildMode,
    '--device-type', deviceType,
  ];

  let processResult;
  try {
    processResult = commandRunner(node, args, {
      cwd: sdk,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const metadata = writeSyntheticFailure(resultPath, {
      jobId,
      project,
      error,
      durationMs: Date.now() - startedAt,
    });
    return publicResult(metadata, resultPath);
  }

  if (!existsSync(resultPath)) {
    const output = `${processResult?.stderr || processResult?.stdout || ''}`.trim();
    const error = processResult?.error || new Error(
      output || `Harmony pool command exited ${processResult?.status ?? 'without a status'}`
    );
    const metadata = writeSyntheticFailure(resultPath, {
      jobId,
      project,
      error,
      durationMs: Date.now() - startedAt,
    });
    return publicResult(metadata, resultPath);
  }

  try {
    const metadata = readJson(resultPath);
    const ready = validateReadyResult(project, outputRoot, resultPath, metadata);
    if (processResult?.status !== 0 && metadata.status !== 'failed') {
      throw new Error(`Harmony pool command exited ${processResult?.status ?? 'without a status'}`);
    }
    return publicResult(metadata, resultPath, ready);
  } catch (error) {
    const metadata = writeSyntheticFailure(resultPath, {
      jobId,
      project,
      error,
      durationMs: Date.now() - startedAt,
    });
    return publicResult(metadata, resultPath);
  }
}
