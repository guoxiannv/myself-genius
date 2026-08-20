#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHapPoolBuild } from './hap-build.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const resolveRunnerPath = (value) => isAbsolute(value) ? resolve(value) : resolve(root, value);
const localEnvFile = resolveRunnerPath(process.env.EXPO_FAST_ENV_FILE || '.env');
if (existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);

function take(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') options.project = take(argv, index++, arg);
    else if (arg === '--output') options.output = take(argv, index++, arg);
    else if (arg === '--run-id') options.runId = take(argv, index++, arg);
    else if (arg === '--pool') options.pool = take(argv, index++, arg);
    else if (arg === '--wait-seconds') options.waitSeconds = Number(take(argv, index++, arg));
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.project) throw new Error('--project is required');
  if (!options.output) throw new Error('--output is required');
  return options;
}

function within(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function main() {
  const options = parse(process.argv.slice(2));
  const project = realpathSync(resolve(options.project));
  const output = resolve(options.output);
  const refreshRoot = resolve(project, '.expo-fast/preview-refresh');
  if (!within(output, refreshRoot) || output === refreshRoot) {
    throw new Error(`preview HAP output must be a child of ${refreshRoot}`);
  }
  const sdk = resolveRunnerPath(process.env.EXPO_HARMONY_SDK_ROOT || '../sdk');
  const pool = resolveRunnerPath(options.pool || process.env.EXPO_HARMONY_POOL_ROOT || '../harmony-pool');
  const waitSeconds = options.waitSeconds ?? Number(process.env.EXPO_HARMONY_HAP_WAIT_SECONDS || 3600);
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 24 * 60 * 60) {
    throw new Error('--wait-seconds must be an integer from 1 to 86400');
  }
  const result = runHapPoolBuild({
    project,
    sdk,
    pool,
    node: process.execPath,
    runId: options.runId,
    waitSeconds,
    reuseExisting: false,
    outputRoot: output,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'ready') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
