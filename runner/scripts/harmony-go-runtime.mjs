import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const runnerRoot = resolve(new URL('..', import.meta.url).pathname);

export const DEFAULT_HARMONY_GO_BUNDLE_NAME = 'com.example.myapplication1.ide';

export function harmonyGoShellHapPath(env = process.env) {
  const configured = String(env.EXPO_HARMONY_GO_HAP || '').trim();
  const candidate = configured
    ? resolve(configured)
    : join(runnerRoot, '.harmony-go-shell/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap');
  return existsSync(candidate) ? candidate : '';
}

export function bundleNameFromModuleJson(source, label = 'module.json') {
  let moduleJson;
  try {
    moduleJson = JSON.parse(source);
  } catch (error) {
    throw new Error(`Harmony Go ${label} is not valid JSON: ${error.message}`);
  }
  const bundleName = String(moduleJson?.app?.bundleName || '').trim();
  if (!bundleName) throw new Error(`Harmony Go ${label} has no app.bundleName`);
  return bundleName;
}

export function bundleNameFromHap(hapPath) {
  const result = spawnSync('/usr/bin/unzip', ['-p', hapPath, 'module.json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`could not read Harmony Go module.json from ${hapPath}: ${(result.stderr || result.stdout || '').trim() || `unzip exited ${result.status}`}`);
  }
  return bundleNameFromModuleJson(result.stdout, `${hapPath}:module.json`);
}

export function resolveHarmonyGoBundleName({ env = process.env, hapPath = harmonyGoShellHapPath(env) } = {}) {
  const configured = String(env.EXPO_HARMONY_GO_BUNDLE_NAME || '').trim();
  if (configured) return configured;
  if (hapPath) return bundleNameFromHap(hapPath);
  return DEFAULT_HARMONY_GO_BUNDLE_NAME;
}

export const harmonyGoBundleName = resolveHarmonyGoBundleName();
