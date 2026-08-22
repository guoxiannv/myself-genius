import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(LIB_DIR, "..", "..");

export const DEFAULT_OPENBITFUN_PROXY_ENV_FILE = resolve(
  PROJECT_ROOT,
  ".openbitfun",
  "openbitfun-proxy.env",
);

export function parseEnvFile(filePath) {
  const values = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function resolveOpenBitfunProxyEnvFile(env = process.env) {
  return resolve(String(env.OPENBITFUN_PROXY_ENV_FILE || DEFAULT_OPENBITFUN_PROXY_ENV_FILE));
}

export function loadOpenBitfunProxyEnv(env = process.env) {
  const envFile = resolveOpenBitfunProxyEnvFile(env);
  if (!existsSync(envFile)) {
    return { env: { ...env }, envFile, loaded: false };
  }
  return {
    // The repository-local file is the single source of truth for proxy
    // routing, so stale shell variables cannot silently override it.
    env: { ...env, ...parseEnvFile(envFile) },
    envFile,
    loaded: true,
  };
}
