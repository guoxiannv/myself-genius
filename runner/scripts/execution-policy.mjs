import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelCapability } from './model-facts.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const configPath = join(root, 'config/execution.json');
const effortLevels = new Set(['low', 'medium', 'high', 'max']);
const designTimeoutCeiling = 55;

// Every field of every role is required. No model name, effort, window, or
// timeout ever falls back to a literal in code, so a field that goes missing
// after an upgrade fails loudly instead of silently changing behavior.
const roleFields = {
  main: ['model', 'effort', 'contextWindow'],
  repair: ['model', 'effort', 'contextWindow', 'limit'],
  design: ['model', 'effort', 'contextWindow', 'timeoutSeconds'],
  appIcon: ['model', 'effort', 'contextWindow', 'timeoutSeconds', 'briefTimeoutSeconds', 'enabled'],
};

export const roleNames = Object.freeze(Object.keys(roleFields));

// The only policy there is. It says where the window comes from -- the model's
// measured capability -- rather than what the window is.
//
// A single-valued field cannot show a difference between its values, which is
// the bar AGENTS.md sets, and fieldCriteria says so rather than pretending
// otherwise. It is here because the alternative is no field at all, and then
// the split between "we choose this" and "the endpoint decides this" survives
// only in someone's memory. A second policy -- compacting deliberately earlier
// than the model allows, so that later prompts are shorter -- is a real want
// with no implementation; when it arrives it is a new value here rather than a
// new schema.
const windowPolicies = new Set(['model-max']);

// Why every field is believed to do something, and how that was seen.
//
// A value written here has to name an observable difference: what is different
// in the output when the field is set one way rather than another. That is the
// bar AGENTS.md sets before a setting may be added, and this table is where the
// bar is met -- the failure it prevents happens at review time, when someone
// adds a field nobody checked, not at startup.
//
// `layer` says how far the value travels: the orchestrator's own code, Claude
// Code's behaviour inside its process, the request body, or the endpoint's
// reading of it. A field can reach a layer and still change nothing beyond it,
// which is exactly what `effort` does.
//
// `status` has a third value, `ineffective`, that must never appear here. A
// field measured to change nothing is deleted, not documented -- keeping one and
// annotating it is how disableAdaptiveThinking survived four roles, a schema, a
// launcher guard and two documents while doing nothing at all. The value exists
// so a finding can be written down; a test stops it from being shipped.
export const fieldCriteria = Object.freeze({
  model: {
    layer: 'request',
    status: 'effective',
    evidence: 'the request body carries it and the reply names the same model; an unserved name comes back 503 model_not_found',
  },
  effort: {
    layer: 'request',
    status: 'unverifiable',
    evidence: 'lands as output_config.effort and all four levels are accepted, but thinking volume did not order across three counterbalanced variants (0/3)',
  },
  contextWindow: {
    layer: 'harness',
    status: 'unverifiable',
    evidence: 'the window it selects is effective -- left unset, Claude Code warns that auto-compact will hold the session to the 200k it assumes -- but the field has one legal value, so no difference between settings can be shown until a second policy exists',
  },
  limit: {
    layer: 'orchestrator',
    status: 'effective',
    evidence: 'the repair loop counts against it and stops the run when reached',
  },
  timeoutSeconds: {
    layer: 'orchestrator',
    status: 'effective',
    evidence: 'the turn is sent SIGINT on the deadline; four live runs recorded ms: 45027 against a 45s value',
  },
  briefTimeoutSeconds: {
    layer: 'orchestrator',
    status: 'effective',
    evidence: 'bounds how long the app icon turn waits for .expo-fast/brief.json before giving up',
  },
  enabled: {
    layer: 'orchestrator',
    status: 'effective',
    evidence: 'false skips the app icon turn entirely, so no request is made',
  },
});

// Reject a configuration that is incomplete, over-complete, or from the old
// schema. Exported so the contract can be exercised without a file on disk.
export function validateExecutionConfig(config) {
  if (config?.schemaVersion !== 4) {
    throw new Error(
      `config/execution.json schemaVersion must be 4, found ${JSON.stringify(config.schemaVersion)}.`
      + ' Version 1 declared model and effort at the top level; move them under roles.main and roles.repair.'
      + ' Version 2 declared disableAdaptiveThinking on every role; delete those four lines, because the'
      + ' variable it set leaves the request byte-for-byte identical whether it is 1, 0, or unset.'
      + ' Version 3 wrote contextWindowTokens as a number; replace it with contextWindow: "model-max",'
      + ' because a window is a property of the model and is now read from what the endpoint was measured'
      + ' to accept rather than written down beside whichever role happens to name that model today.',
    );
  }
  for (const name of roleNames) {
    const role = config.roles?.[name];
    if (!role || typeof role !== 'object') throw new Error(`config/execution.json is missing roles.${name}`);
    for (const field of roleFields[name]) {
      if (!Object.hasOwn(role, field)) throw new Error(`config/execution.json is missing roles.${name}.${field}`);
    }
    for (const field of Object.keys(role)) {
      if (!roleFields[name].includes(field)) throw new Error(`config/execution.json declares an unknown field roles.${name}.${field}`);
    }
  }
  for (const name of Object.keys(config.roles)) {
    if (!roleNames.includes(name)) throw new Error(`config/execution.json declares an unknown role: ${name}`);
  }
  // Checked here rather than while a role is resolved, because unlike effort
  // this one has no command-line override: the closed set is known the moment
  // the file is read, so a value outside it is a bad file rather than a bad run.
  for (const name of roleNames) {
    const policy = config.roles[name].contextWindow;
    if (!windowPolicies.has(policy)) {
      throw new Error(
        `config/execution.json roles.${name}.contextWindow must be ${[...windowPolicies].map((value) => `"${value}"`).join(' or ')}, found ${JSON.stringify(policy)}.`
        + ' It names where the window comes from, not what the window is: the number is read from what the endpoint was measured to accept.',
      );
    }
  }
  return config;
}

function readConfig() {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(`config/execution.json is missing: ${configPath}\nGit tracks this file; restore it with "git checkout -- runner/config/execution.json".`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`config/execution.json is not valid JSON: ${error.message}`);
  }
  return validateExecutionConfig(config);
}

export const executionConfig = Object.freeze(readConfig());

function requireModel(label, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty model name`);
  return value;
}

function requireEffort(label, value) {
  if (!effortLevels.has(value)) throw new Error(`${label} must be low, medium, high, or max`);
  return value;
}

function requireInteger(label, value, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  return value;
}

function requireBoolean(label, value) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`);
  return value;
}

// Resolve one role into the exact model, effort, and limits a spawn will use.
// `overrides` carries command-line values only; anything it omits comes from
// configuration, and anything configuration omits is an error, never a default.
// `paths` points the capability lookup at a different fact file. Threaded
// through rather than left implicit because a role's window now depends on a
// file, and a dependency a test cannot vary is one nobody can check.
export function resolveRole(name, overrides = {}, paths = {}) {
  const declared = executionConfig.roles[name];
  if (!declared) throw new Error(`unknown execution role: ${name}`);

  // A null model means "inherit the main role". The rule lives here; the model
  // name it resolves to lives only in configuration. `inheritModel` lets a
  // caller supply the main model it already resolved, so that a command-line
  // --model override reaches the inheriting roles too.
  const inherited = declared.model === null
    ? (overrides.inheritModel || executionConfig.roles.main.model)
    : declared.model;
  const role = {
    name,
    model: requireModel(`${name} model`, overrides.model || inherited),
    effort: requireEffort(`${name} effort`, overrides.effort || declared.effort),
    contextWindow: declared.contextWindow,
    // The measured window for whichever model this role resolved to, so a
    // --model override and appIcon's inheritance both carry the right one
    // without anybody maintaining a second number beside the first. null when
    // nothing has measured it; roleEnv then sets no window at all.
    contextWindowTokens: modelCapability(requireModel(`${name} model`, overrides.model || inherited), paths)?.value ?? null,
  };

  if (name === 'repair') {
    const maximum = requireInteger('repair limit', declared.limit, Number.MAX_SAFE_INTEGER);
    role.limit = requireInteger('repair limit', Number(overrides.limit ?? maximum), maximum);
  }
  if (name === 'design') {
    // Configuration is reviewed, so an out-of-range value there is an error. A
    // command-line value is ad hoc and documented as capped, so it clamps.
    requireInteger('design timeoutSeconds', declared.timeoutSeconds, designTimeoutCeiling);
    const requested = Number(overrides.timeoutSeconds ?? declared.timeoutSeconds);
    role.timeoutSeconds = Number.isFinite(requested)
      ? Math.min(designTimeoutCeiling, Math.max(1, Math.trunc(requested)))
      : declared.timeoutSeconds;
  }
  if (name === 'appIcon') {
    role.timeoutSeconds = requireInteger('appIcon timeoutSeconds', declared.timeoutSeconds, Number.MAX_SAFE_INTEGER);
    role.briefTimeoutSeconds = requireInteger('appIcon briefTimeoutSeconds', declared.briefTimeoutSeconds, Number.MAX_SAFE_INTEGER);
    role.enabled = requireBoolean('appIcon enabled', declared.enabled);
  }
  return role;
}

// The environment a role's Claude Code process needs. The window is a model
// property rather than a credential, so it belongs here rather than in llm.env:
// Claude Code applies CLAUDE_CODE_MAX_CONTEXT_TOKENS only to models it does not
// recognize, and would otherwise assume a 200k window and auto-compact the turn.
// claude-isolated refuses to start when llm.env sets it, because a stale copy
// there would silently override everything passed here.
//
// Nothing is set when nothing has measured this model. Claude Code then says so
// itself -- it warns that auto-compact will hold the session to the 200k it
// assumes -- which is both louder and more accurate than a number we would have
// had to invent. A run in that state is using less context than the model
// allows, not more, so it degrades rather than fails.
//
// The value never reaches the request body, which is why it could not be
// trusted on its name for so long: it only decides when this process compacts,
// and is not the endpoint's hard limit, so a window set too high is never
// rejected -- it just compacts too late.
export function roleEnv(role) {
  if (!Number.isFinite(role.contextWindowTokens)) return {};
  return {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(role.contextWindowTokens),
  };
}

// Variables that only config/execution.json may set. claude-isolated rejects an
// llm.env that declares any of them. Written out rather than sampled from a
// resolved role, because a role whose model has never been measured sets no
// window at all -- and what llm.env may not claim does not depend on whether
// anyone has run the probes.
export const roleOwnedEnvironmentKeys = Object.freeze(['CLAUDE_CODE_MAX_CONTEXT_TOKENS']);

// The two turn roles, fully resolved. A command-line main override that has no
// matching repair override is inherited by the repair turn, as before.
export function resolveExecutionRoles(options = {}, paths = {}) {
  const main = resolveRole('main', { model: options.model, effort: options.effort }, paths);
  const repair = resolveRole('repair', {
    model: options.repairModel || options.model,
    effort: options.repairEffort || options.effort,
    limit: options.repairLimit,
    inheritModel: main.model,
  }, paths);
  return { main, repair };
}

// The same resolution in the flat shape the orchestrator records as evidence.
export function resolveExecution(options = {}) {
  const { main, repair } = resolveExecutionRoles(options);
  return {
    model: main.model,
    effort: main.effort,
    repairModel: repair.model,
    repairEffort: repair.effort,
    repairLimit: repair.limit,
  };
}

export const executionDefaults = Object.freeze(resolveExecution());
