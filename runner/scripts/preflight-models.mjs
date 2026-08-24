import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveExecutionRoles, resolveRole } from './execution-policy.mjs';
import { probeContextWindow, probeThinking } from './model-probes.mjs';

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

// Every role's model, including the command-line overrides, because those reach
// the endpoint exactly as configuration does and must be checked and measured on
// the same terms.
function roleModels(options = {}) {
  const { main, repair } = resolveExecutionRoles(options);
  return [
    ['main', main],
    ['repair', repair],
    ['design', resolveRole('design', { model: options.designModel, effort: options.designEffort, inheritModel: main.model })],
    ['appIcon', resolveRole('appIcon', { inheritModel: main.model })],
  ];
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
  const roles = roleModels(options);
  const servedNames = Object.keys(result.cache.models);
  const served = new Set(servedNames);
  const missing = roles.filter(([, role]) => !served.has(role.model));
  if (missing.length) {
    const names = missing.map(([name, role]) => `${name}=${role.model}`).join(', ');
    throw new Error(
      `config/execution.json names models this endpoint does not serve: ${names}\n`
      + `  It serves: ${servedNames.join(', ')}\n`
      + '  Fix config/execution.json, or refresh the cache if the endpoint changed:\n'
      + '    ./start-livetest.sh --refresh-models',
    );
  }
  const notes = [
    ...windowNotes(roles, result.cache),
    ...designDeadlineNote(roles, result.cache),
  ];

  // The provenance travels with the answer rather than being logged every run:
  // it belongs in --dry-run output and run evidence, where someone reading a
  // result can see how old the facts behind it are, not in a line printed on a
  // path whose whole point is to stay silent when nothing is wrong.
  return {
    verified: true,
    notes,
    models: servedNames,
    fetchedAt: result.cache.fetchedAt,
    measuredDaysAgo: result.measuredDaysAgo,
    claudeCodeVersion: result.cache.claudeCodeVersion ?? null,
  };
}

// The one configured value whose intent is unambiguous enough for a machine to
// check: contextWindowTokens exists so that Claude Code compacts before the
// endpoint refuses the request. Set above the real window, compaction comes too
// late and a turn is refused mid-run -- and until the run-path warning existed,
// silently.
//
// A derived limit only warns. k3's 262144 is read from "supports only 256K
// context" on the assumption that K is 1024, and if that assumption is wrong the
// error runs toward making this check useless rather than toward stopping a run
// that would have worked. Refusing to start on an inference we have not
// confirmed would be the more expensive mistake.
function windowNotes(roles, cache) {
  const notes = [];
  for (const [name, role] of roles) {
    const fact = cache.models[role.model]?.contextWindowTokens;
    if (!Number.isFinite(fact?.value)) {
      notes.push(`${name}: nothing has measured ${role.model}'s window, so contextWindowTokens ${role.contextWindowTokens} is unchecked · ./start-livetest.sh --refresh-models`);
      continue;
    }
    if (role.contextWindowTokens <= fact.value) continue;
    const said = `${name} compacts at ${role.contextWindowTokens}, but ${role.model} refuses past ${fact.value}`;
    if (fact.confidence !== 'exact') {
      notes.push(`${said} — that limit is derived rather than stated, so this is a warning: ${fact.evidence}`);
      continue;
    }
    throw new Error(
      `config/execution.json asks for more context than this endpoint gives: ${said}.\n`
      + `  The endpoint said: ${fact.evidence}\n`
      + '  Compaction would come too late and a turn would be refused part-way through the run.\n'
      + '  Lower contextWindowTokens, or refresh the facts if the endpoint changed:\n'
      + '    ./start-livetest.sh --refresh-models',
    );
  }
  return notes;
}

// A report, not a verdict. The design deadline is a budget rather than an
// estimate -- the turn is expected to exceed it sometimes and failure is a
// non-blocking fallback -- so no value of it can be "wrong" and nothing here
// judges one. What is worth saying out loud is how often that budget has been
// enough, computed from the stored samples so it follows the configured
// deadline rather than being frozen at measuring time.
//
// Silent when every sample made it. A line printed on every run that only ever
// says everything is fine is how people stop reading lines.
function designDeadlineNote(roles, cache) {
  const design = roles.find(([name]) => name === 'design')?.[1];
  const samples = cache.models[design?.model]?.referenceTurn?.samples;
  if (!design || !Array.isArray(samples) || !samples.length) return [];
  const within = samples.filter((sample) => sample.complete && sample.ms <= design.timeoutSeconds * 1000);
  if (within.length === samples.length) return [];
  return [`design: at ${design.timeoutSeconds}s, ${within.length} of ${samples.length} reference runs finished a document (${cache.models[design.model].referenceTurn.reference})`];
}

// Fetch through the launcher so the credentials stay inside it. Out of band
// only: this is the call that costs seconds.
export function refreshModelCache(claudeBin, paths = {}, options = {}) {
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
  // Facts already measured about the same endpoint are carried across, because
  // this refresh runs on every pool build and the expensive probes do not:
  // rebuilding each record from scratch quietly destroyed the reference-turn
  // and effort rows, which cost real turns to produce. Only a fresh cache is
  // carried -- once llm.env changes, the stored facts describe a different
  // endpoint -- and a probe suite bump drops them for the same reason, since a
  // number measured by an older suite is not the same measurement.
  const previous = readModelCache(paths);
  const carried = previous.status === 'fresh' && previous.cache.probeSuiteVersion === probeSuiteVersion
    ? previous.cache.models
    : {};

  // Probed only for the models a run would actually use. Measuring all thirteen
  // would spend most of its time on models no role names, and the expensive
  // probes scale with that list rather than with how useful it is.
  const notice = options.notice || (() => {});
  const wanted = options.probe === false
    ? []
    : [...new Set(roleModels().map(([, role]) => role.model))].filter((model) => models.includes(model));
  const measured = Object.fromEntries(models.map((model) => [model, { ...(carried[model] || {}) }]));
  for (const model of wanted) {
    notice(`probing ${model}`);
    measured[model] = { ...(carried[model] || {}), ...probeModel(claudeBin, model, notice) };
  }
  const cache = {
    schemaVersion: cacheSchemaVersion,
    ...fingerprintLlmEnv(envFile),
    fetchedAt: new Date().toISOString(),
    claudeCodeVersion: claudeCodeVersion(claudeBin),
    probeSuiteVersion,
    // One record per served model, measured for the ones in use and an empty
    // slot for the rest. An empty slot is not a claim about the model; it says
    // nothing was asked.
    models: measured,
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

// Bump when a probe changes what its answer means, so that a record measured by
// an older suite is visibly not the same measurement. A probe that cannot reach
// a verdict records that it could not, and never fails the refresh: the model
// names are the part this file has always been trusted for, and losing them
// because one probe timed out would trade a small gap for a large one.
export const probeSuiteVersion = 1;

function probeModel(claudeBin, model, notice) {
  const measuredAt = new Date().toISOString();
  const stamp = (fact) => ({ ...fact, measuredAt });
  const unmeasured = (error) => stamp({ status: 'unmeasured', evidence: `probe failed: ${error.message}` });
  const record = {};
  try {
    record.contextWindowTokens = stamp(probeContextWindow(claudeBin, model, notice));
  } catch (error) {
    record.contextWindowTokens = unmeasured(error);
  }
  try {
    const thinking = probeThinking(claudeBin, model);
    if (thinking.unmeasured) {
      record.thinkingDisablable = stamp({ status: 'unmeasured', evidence: thinking.unmeasured });
      record.absentThinkingMeansOff = stamp({ status: 'unmeasured', evidence: thinking.unmeasured });
    } else {
      record.thinkingDisablable = stamp(thinking.thinkingDisablable);
      record.absentThinkingMeansOff = stamp(thinking.absentThinkingMeansOff);
    }
  } catch (error) {
    record.thinkingDisablable = unmeasured(error);
    record.absentThinkingMeansOff = unmeasured(error);
  }
  return record;
}

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

// Checked before an expensive probe spends anything. A model this endpoint does
// not serve does not fail fast on its own -- the turn hangs -- so discovering it
// from the write at the end would cost the whole run and measure nothing.
export function assertModelsServed(models, paths = {}) {
  const current = readModelCache(paths);
  if (current.status !== 'fresh') {
    throw new Error(`the model cache is ${current.status}, so the models cannot be checked before spending turns · ./start-livetest.sh --refresh-models`);
  }
  const unserved = models.filter((model) => !current.cache.models[model]);
  if (unserved.length) {
    throw new Error(
      `this endpoint does not serve: ${unserved.join(', ')}\n`
      + `  It serves: ${Object.keys(current.cache.models).join(', ')}`,
    );
  }
  return current.cache;
}
