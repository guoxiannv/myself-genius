import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveExecutionRoles, resolveRole } from './execution-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const llmEnvPath = join(root, '.local/llm.env');
const cachePath = join(root, '.local/models-cache.json');

// Reading the list costs a network round trip measured at 1.5-2.0s on the
// current relay, almost all of it the TLS handshake. That is three orders of
// magnitude over the budget for starting a run, so the fetch never happens on a
// run path: it is refreshed out of band and only the cache is read here.
//
// The cache fingerprints llm.env by size and modification time rather than
// recording the endpoint it was fetched from. That keeps this check to one stat
// and one small file read, with no subprocess and no need for the orchestrator
// to parse a file that belongs to the launcher. Size is carried alongside the
// timestamp because mtime has millisecond granularity.
function fingerprintLlmEnv(envFile) {
  if (!existsSync(envFile)) return { llmEnvMtimeMs: 0, llmEnvSize: 0 };
  const stats = statSync(envFile);
  return { llmEnvMtimeMs: Math.trunc(stats.mtimeMs), llmEnvSize: stats.size };
}
export function readModelCache(paths = {}) {
  const cacheFile = paths.cachePath || cachePath;
  const envFile = paths.llmEnvPath || llmEnvPath;
  if (!existsSync(cacheFile)) return { status: 'absent' };
  let cache;
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    return { status: 'unreadable' };
  }
  if (cache?.schemaVersion !== 1 || !Array.isArray(cache.models)) return { status: 'unreadable' };
  if (!Number.isInteger(cache.llmEnvMtimeMs) || !Number.isInteger(cache.llmEnvSize)) return { status: 'unreadable' };
  const fingerprint = fingerprintLlmEnv(envFile);
  if (fingerprint.llmEnvMtimeMs !== cache.llmEnvMtimeMs || fingerprint.llmEnvSize !== cache.llmEnvSize) {
    return { status: 'stale', cache };
  }
  return { status: 'fresh', cache };
}

// Verify the configured roles against a cached list. A model the endpoint does
// not serve is a configuration error worth failing on; anything that leaves the
// list unknown is reported and allowed through, because turning a missing cache
// or a brief network problem into a startup failure would trade a real error
// for a much more common false one.
export function verifyConfiguredModels(options = {}, paths = {}) {
  const result = readModelCache(paths);
  if (result.status !== 'fresh') {
    return {
      verified: false,
      reason: result.status,
      notice: result.status === 'stale'
        ? 'models unverified: llm.env changed since the last refresh · ./start-livetest.sh --refresh-models'
        : 'models unverified: no model cache · ./start-livetest.sh --refresh-models',
    };
  }
  const { main, repair } = resolveExecutionRoles(options);
  const roles = [
    ['main', main.model],
    ['repair', repair.model],
    ['design', resolveRole('design', { model: options.designModel, effort: options.designEffort, inheritModel: main.model }).model],
    ['appIcon', resolveRole('appIcon', { inheritModel: main.model }).model],
  ];
  const served = new Set(result.cache.models);
  const missing = roles.filter(([, model]) => !served.has(model));
  if (missing.length) {
    const names = missing.map(([role, model]) => `${role}=${model}`).join(', ');
    throw new Error(
      `config/execution.json names models this endpoint does not serve: ${names}\n`
      + `  It serves: ${result.cache.models.join(', ')}\n`
      + '  Fix config/execution.json, or refresh the cache if the endpoint changed:\n'
      + '    ./start-livetest.sh --refresh-models',
    );
  }
  return { verified: true, models: result.cache.models, fetchedAt: result.cache.fetchedAt };
}

// Fetch through the launcher so the credentials stay inside it. Out of band
// only: this is the call that costs seconds.
export function refreshModelCache(claudeBin, paths = {}) {
  const cacheFile = paths.cachePath || cachePath;
  const envFile = paths.llmEnvPath || llmEnvPath;
  const fetched = spawnSync(claudeBin, ['--genius-list-models'], { encoding: 'utf8', timeout: 60_000 });
  if (fetched.status !== 0) {
    throw new Error(`could not list models through ${claudeBin}: ${(fetched.stderr || fetched.error?.message || '').trim() || `exit ${fetched.status}`}`);
  }
  let payload;
  try {
    payload = JSON.parse(fetched.stdout);
  } catch (error) {
    throw new Error(`the endpoint did not return a JSON model list: ${error.message}`);
  }
  const entries = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(entries)) throw new Error('the endpoint returned no model list');
  const models = entries.map((entry) => String(entry?.id ?? entry ?? '').trim()).filter(Boolean).sort();
  if (!models.length) throw new Error('the endpoint returned an empty model list');
  const cache = {
    schemaVersion: 1,
    ...fingerprintLlmEnv(envFile),
    fetchedAt: new Date().toISOString(),
    models,
  };
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}
