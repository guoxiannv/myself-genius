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
// Schema 1 held a bare array of model names. Schema 2 keys the same names to a
// record per model, so that a measured capability can be attached to the model
// it belongs to rather than to whichever role happens to name it today. An
// older cache is reported as outdated rather than corrupt: nothing is wrong
// with it, it simply predates the fields that would be read from it.
const cacheSchemaVersion = 2;

// How long ago this was measured. Reported, never enforced: an age threshold
// would be a number invented rather than measured, and it would answer the
// wrong question anyway. The fingerprint above says whether this cache is about
// the current endpoint; nothing local can say whether that endpoint has since
// changed what it serves. Making the age visible is the honest half of that.
function measuredDaysAgo(fetchedAt, now) {
  const at = Date.parse(fetchedAt ?? '');
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now - at) / 86_400_000));
}
export function readModelCache(paths = {}, now = Date.now()) {
  const cacheFile = paths.cachePath || cachePath;
  const envFile = paths.llmEnvPath || llmEnvPath;
  if (!existsSync(cacheFile)) return { status: 'absent' };
  let cache;
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    return { status: 'unreadable' };
  }
  if (Number.isInteger(cache?.schemaVersion) && cache.schemaVersion < cacheSchemaVersion) {
    return { status: 'outdated', cache };
  }
  if (cache?.schemaVersion !== cacheSchemaVersion) return { status: 'unreadable' };
  if (!cache.models || typeof cache.models !== 'object' || Array.isArray(cache.models)) return { status: 'unreadable' };
  if (!Number.isInteger(cache.llmEnvMtimeMs) || !Number.isInteger(cache.llmEnvSize)) return { status: 'unreadable' };
  const fingerprint = fingerprintLlmEnv(envFile);
  const age = measuredDaysAgo(cache.fetchedAt, now);
  if (fingerprint.llmEnvMtimeMs !== cache.llmEnvMtimeMs || fingerprint.llmEnvSize !== cache.llmEnvSize) {
    return { status: 'stale', cache, measuredDaysAgo: age };
  }
  return { status: 'fresh', cache, measuredDaysAgo: age };
}

// Verify the configured roles against a cached list. A model the endpoint does
// not serve is a configuration error worth failing on; anything that leaves the
// list unknown is reported and allowed through, because turning a missing cache
// or a brief network problem into a startup failure would trade a real error
// for a much more common false one.
export function verifyConfiguredModels(options = {}, paths = {}) {
  const result = readModelCache(paths);
  if (result.status !== 'fresh') {
    const because = {
      stale: 'llm.env changed since the last refresh',
      outdated: 'the cache predates the current schema',
      unreadable: 'the cache is unreadable',
    }[result.status] || 'no model cache';
    return {
      verified: false,
      reason: result.status,
      notice: `models unverified: ${because} · ./start-livetest.sh --refresh-models`,
    };
  }
  const { main, repair } = resolveExecutionRoles(options);
  const roles = [
    ['main', main.model],
    ['repair', repair.model],
    ['design', resolveRole('design', { model: options.designModel, effort: options.designEffort, inheritModel: main.model }).model],
    ['appIcon', resolveRole('appIcon', { inheritModel: main.model }).model],
  ];
  const servedNames = Object.keys(result.cache.models);
  const served = new Set(servedNames);
  const missing = roles.filter(([, model]) => !served.has(model));
  if (missing.length) {
    const names = missing.map(([role, model]) => `${role}=${model}`).join(', ');
    throw new Error(
      `config/execution.json names models this endpoint does not serve: ${names}\n`
      + `  It serves: ${servedNames.join(', ')}\n`
      + '  Fix config/execution.json, or refresh the cache if the endpoint changed:\n'
      + '    ./start-livetest.sh --refresh-models',
    );
  }
  // The provenance travels with the answer rather than being logged every run:
  // it belongs in --dry-run output and run evidence, where someone reading a
  // result can see how old the facts behind it are, not in a line printed on a
  // path whose whole point is to stay silent when nothing is wrong.
  return {
    verified: true,
    models: servedNames,
    fetchedAt: result.cache.fetchedAt,
    measuredDaysAgo: result.measuredDaysAgo,
    claudeCodeVersion: result.cache.claudeCodeVersion ?? null,
  };
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
    schemaVersion: cacheSchemaVersion,
    ...fingerprintLlmEnv(envFile),
    fetchedAt: new Date().toISOString(),
    claudeCodeVersion: claudeCodeVersion(claudeBin),
    // One record per served model. Empty until a probe measures something about
    // it; the names alone are what this file has always carried.
    models: Object.fromEntries(models.map((model) => [model, {}])),
  };
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}

// Recorded, not checked. Which fields Claude Code emits and which of them it
// lets us set is a property of its build, so a number measured through one
// version does not automatically describe another. Reading the current version
// back would cost a process spawn, which the run path cannot afford, so this
// travels with the measurement and is there for whoever reads the file or
// re-runs the probes -- not as a gate nobody can pay for.
function claudeCodeVersion(claudeBin) {
  const shown = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (shown.status !== 0) return null;
  return shown.stdout.match(/\b\d+(?:\.\d+)+[\w.-]*/)?.[0] ?? null;
}
