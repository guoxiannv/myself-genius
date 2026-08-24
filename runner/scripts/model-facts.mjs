import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// What the endpoint was measured to be, and nothing about what we asked for.
// This module imports nothing from the repository on purpose: execution-policy
// resolves a role's context window from here, and preflight verifies a
// configuration against here, so anything this file imported back would close a
// cycle between the two.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const llmEnvPath = join(root, '.local/llm.env');
export const cachePath = join(root, '.local/models-cache.json');

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
export function fingerprintLlmEnv(envFile) {
  if (!existsSync(envFile)) return { llmEnvMtimeMs: 0, llmEnvSize: 0 };
  const stats = statSync(envFile);
  return { llmEnvMtimeMs: Math.trunc(stats.mtimeMs), llmEnvSize: stats.size };
}
// Schema 1 held a bare array of model names. Schema 2 keys the same names to a
// record per model, so that a measured capability can be attached to the model
// it belongs to rather than to whichever role happens to name it today. An
// older cache is reported as outdated rather than corrupt: nothing is wrong
// with it, it simply predates the fields that would be read from it.
export const cacheSchemaVersion = 2;

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


// The measured window for one model, or null when nothing has measured it.
// Read while roles are being resolved, so it stays at one stat and one small
// file read -- the same budget the rest of this file was written to.
//
// Returning null rather than a number is the honest answer to "we never asked".
// Its caller sets no window at all in that case, and Claude Code says out loud
// that it is falling back to the 200k it assumes; inventing a figure here would
// be the same move that put 256000 in the configuration in the first place.
export function modelCapability(model, paths = {}) {
  const result = readModelCache(paths);
  if (result.status !== 'fresh') return null;
  const fact = result.cache.models?.[model]?.contextWindowTokens;
  return Number.isFinite(fact?.value) ? fact : null;
}

// Bump when a probe changes what its answer means, so that a record measured by
// an older suite is visibly not the same measurement. A probe that cannot reach
// a verdict records that it could not, and never fails the refresh: the model
// names are the part this file has always been trusted for, and losing them
// because one probe timed out would trade a small gap for a large one.
export const probeSuiteVersion = 1;

// Record what one probe measured about one model, leaving the fingerprint and
// every other model untouched. Kept apart from refreshModelCache because the
// expensive probe is asked for on its own and should not have to re-fetch the
// model list to write down what it learned.
//
// Only a fresh cache accepts a recording. If llm.env has changed, this cache
// describes a different endpoint, and filing a measurement taken against the
// current one under that fingerprint would produce exactly the quiet
// disagreement between configuration and reality this whole effort is about.
export function recordModelFacts(model, facts, paths = {}) {
  const cacheFile = paths.cachePath || cachePath;
  const current = readModelCache(paths);
  if (current.status !== 'fresh') {
    throw new Error(`the model cache is ${current.status}, so there is nothing to record into · ./start-livetest.sh --refresh-models`);
  }
  const { cache } = current;
  if (!cache.models[model]) {
    throw new Error(`this endpoint does not serve ${model}. It serves: ${Object.keys(cache.models).join(', ')}`);
  }
  const measuredAt = new Date().toISOString();
  const stamped = Object.fromEntries(Object.entries(facts).map(([name, fact]) => [name, { ...fact, measuredAt }]));
  cache.models[model] = { ...cache.models[model], ...stamped };
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  return cache.models[model];
}

// What Claude Code itself was measured to do, as opposed to what the endpoint
// does. Kept in the same file because one fact file is simpler than two, but
// under its own key and its own rule: these answers depend on which Claude Code
// build produced them, not on which endpoint llm.env points at.
//
// That is why refreshModelCache carries this section across a change of
// endpoint while dropping every model record. Discarding a measurement of the
// harness because the relay moved would throw away something still true, and
// re-earning it costs another run of the probe.
export function recordHarnessFacts(facts, paths = {}) {
  const cacheFile = paths.cachePath || cachePath;
  const current = readModelCache(paths);
  if (!current.cache) {
    throw new Error(`there is no fact file to record into (${current.status}) · ./start-livetest.sh --refresh-models`);
  }
  const cache = current.cache;
  cache.harness = { ...(cache.harness || {}), ...facts };
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  return cache.harness;
}
