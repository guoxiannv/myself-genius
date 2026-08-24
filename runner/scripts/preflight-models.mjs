import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveExecutionRoles, resolveRole } from './execution-policy.mjs';
import { probeContextWindow, probeThinking } from './model-probes.mjs';
import { cacheSchemaVersion, fingerprintLlmEnv, llmEnvPath, cachePath, probeSuiteVersion, readModelCache } from './model-facts.mjs';
import { refusalFromText } from './admission.mjs';

// Verifying a configuration against the measured facts. The facts themselves,
// and reading them, live in model-facts.mjs, which imports nothing from here --
// that is what lets execution-policy resolve a window from the same file
// without the two importing each other.

// Every role's model, including the command-line overrides, because those reach
// the endpoint exactly as configuration does and must be checked and measured on
// the same terms.
function roleModels(options = {}, paths = {}) {
  const { main, repair } = resolveExecutionRoles(options, paths);
  return [
    ['main', main],
    ['repair', repair],
    ['design', resolveRole('design', { model: options.designModel, effort: options.designEffort, inheritModel: main.model }, paths)],
    ['appIcon', resolveRole('appIcon', { inheritModel: main.model }, paths)],
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
  const roles = roleModels(options, paths);
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
    ...windowNotes(roles),
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

// The window is no longer written down beside a role, so a configuration can no
// longer name one the endpoint will refuse -- roleEnv passes on whatever the
// model was measured to accept, and nothing else. The check that used to refuse
// a start over that number is gone with the number: an error made impossible
// needs no detector, and a check that can never fire is decoration of the same
// kind this whole effort removed.
//
// What is left is the case where nothing has measured the model at all. That is
// not an error either -- the run simply uses the 200k Claude Code assumes, and
// says so on its own -- but it is worth naming, because the difference between
// "measured and fine" and "never asked" is invisible from the outside.
//
// A measurement that is itself wrong is still possible, and is still caught: the
// endpoint says its real limit when it refuses a request, and the run reports
// that contradiction where it happens.
function windowNotes(roles) {
  return roles
    .filter(([, role]) => !Number.isFinite(role.contextWindowTokens))
    .map(([name, role]) => `${name}: nothing has measured ${role.model}'s window, so this run compacts at the 200k Claude Code assumes · ./start-livetest.sh --refresh-models`);
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
    measured[model] = keepFactsThroughARefusal(carried[model], probeModel(claudeBin, model, notice), model, notice);
  }
  const cache = {
    schemaVersion: cacheSchemaVersion,
    ...fingerprintLlmEnv(envFile),
    fetchedAt: new Date().toISOString(),
    claudeCodeVersion: claudeCodeVersion(claudeBin),
    probeSuiteVersion,
    // Carried across a change of endpoint, unlike every model record below:
    // what Claude Code does with a flag is a property of Claude Code, and a
    // relay moving does not make it untrue.
    ...(previous.cache?.harness ? { harness: previous.cache.harness } : {}),
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

// One concurrency event makes this endpoint answer 503 no-channel to everything
// for minutes afterwards (#139), and a probe that lands inside that window
// measures nothing. It must not be allowed to say so on top of a real
// measurement: overwriting a fact with "unmeasured" would let one traffic
// accident erase numbers that cost real turns to produce, and the erasure would
// be invisible afterwards. A refusal is not a measurement, so nothing is written
// for it -- and the refresh says which fields it left alone.
function keepFactsThroughARefusal(carried, fresh, model, notice) {
  const merged = { ...(carried || {}), ...fresh };
  const kept = [];
  for (const [name, fact] of Object.entries(fresh)) {
    if (fact?.status !== 'unmeasured') continue;
    if (!refusalFromText(String(fact.evidence || ''))) continue;
    const previous = carried?.[name];
    if (!previous || previous.status === 'unmeasured') continue;
    merged[name] = previous;
    kept.push(name);
  }
  if (kept.length) {
    notice(`${model}: the endpoint refused the probe, so ${kept.join(', ')} keeps what was measured before`);
  }
  return merged;
}

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
      record.thinkingDisableReachesPrompt = stamp({ status: 'unmeasured', evidence: thinking.unmeasured });
    } else {
      record.thinkingDisablable = stamp(thinking.thinkingDisablable);
      record.absentThinkingMeansOff = stamp(thinking.absentThinkingMeansOff);
      record.thinkingDisableReachesPrompt = stamp(thinking.thinkingDisableReachesPrompt);
    }
  } catch (error) {
    record.thinkingDisablable = unmeasured(error);
    record.absentThinkingMeansOff = unmeasured(error);
    record.thinkingDisableReachesPrompt = unmeasured(error);
  }
  return record;
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
