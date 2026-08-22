import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const configPath = join(root, 'config/execution.json');
const effortLevels = new Set(['low', 'medium', 'high', 'max']);
const designTimeoutCeiling = 55;

// Every field of every role is required. No model name, effort, window, or
// timeout ever falls back to a literal in code, so a field that goes missing
// after an upgrade fails loudly instead of silently changing behavior.
const roleFields = {
  main: ['model', 'effort', 'contextWindowTokens', 'disableAdaptiveThinking'],
  repair: ['model', 'effort', 'contextWindowTokens', 'disableAdaptiveThinking', 'limit'],
  design: ['model', 'effort', 'contextWindowTokens', 'disableAdaptiveThinking', 'timeoutSeconds'],
  appIcon: ['model', 'effort', 'contextWindowTokens', 'disableAdaptiveThinking', 'timeoutSeconds', 'briefTimeoutSeconds', 'enabled'],
};

export const roleNames = Object.freeze(Object.keys(roleFields));

// Reject a configuration that is incomplete, over-complete, or from the old
// schema. Exported so the contract can be exercised without a file on disk.
export function validateExecutionConfig(config) {
  if (config?.schemaVersion !== 2) {
    throw new Error(`config/execution.json schemaVersion must be 2, found ${JSON.stringify(config.schemaVersion)}. Version 1 declared model and effort at the top level; move them under roles.main and roles.repair.`);
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
export function resolveRole(name, overrides = {}) {
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
    contextWindowTokens: requireInteger(`${name} contextWindowTokens`, declared.contextWindowTokens, Number.MAX_SAFE_INTEGER),
    disableAdaptiveThinking: requireBoolean(`${name} disableAdaptiveThinking`, declared.disableAdaptiveThinking),
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

// The environment a role's Claude Code process needs. Both variables are model
// properties, not credentials, so they belong here rather than in llm.env:
// Claude Code applies CLAUDE_CODE_MAX_CONTEXT_TOKENS only to models it does not
// recognize, and would otherwise assume a 200k window and auto-compact the turn.
// claude-isolated refuses to start when llm.env sets either of them, because a
// stale copy there would silently override everything passed here.
export function roleEnv(role) {
  return {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(role.contextWindowTokens),
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: role.disableAdaptiveThinking ? '1' : '0',
  };
}

// Variables that only config/execution.json may set. claude-isolated rejects an
// llm.env that declares any of them.
export const roleOwnedEnvironmentKeys = Object.freeze(Object.keys(roleEnv(resolveRole('main'))));

// The two turn roles, fully resolved. A command-line main override that has no
// matching repair override is inherited by the repair turn, as before.
export function resolveExecutionRoles(options = {}) {
  const main = resolveRole('main', { model: options.model, effort: options.effort });
  const repair = resolveRole('repair', {
    model: options.repairModel || options.model,
    effort: options.repairEffort || options.effort,
    limit: options.repairLimit,
    inheritModel: main.model,
  });
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
