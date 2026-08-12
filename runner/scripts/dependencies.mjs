#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const helper = join(root, 'skills/expo-harmony-fast/scripts/fast-harmony.mjs');
export const runtimeCorePackages = ['expo-asset', 'expo-constants', 'expo-modules-core'];

function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (options.log) writeFileSync(options.log, output);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? 'unknown'}\n${output}`);
  return { ms: Date.now() - started, output };
}

function sdkRuntimePath(sdkRoot) {
  const candidates = [
    join(sdkRoot, 'packages/@expo/cli/harmony/harmony-go-runtime.json'),
    join(sdkRoot, 'tools/harmony/harmony-go-runtime.json'),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`Harmony Go runtime contract not found under ${sdkRoot}`);
  return path;
}

function packageVersion(modulesRoot, name) {
  return readJson(join(modulesRoot, ...name.split('/'), 'package.json'), {}).version || '';
}

function configuredCaches() {
  return (process.env.EXPO_FAST_MODULE_CACHE || '').split(delimiter).filter(Boolean).map((value) => resolve(value));
}

function npmInvocation() {
  const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  return existsSync(npmCli) ? { command: process.execPath, prefix: [npmCli] } : { command: 'npm', prefix: [] };
}

function installProjectDependencies(project, logName) {
  const npm = npmInvocation();
  return run(npm.command, [
    ...npm.prefix,
    'install',
    '--ignore-scripts',
    '--legacy-peer-deps',
    '--prefer-offline',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
  ], { cwd: project, env: { COREPACK_ENABLE_PROJECT_SPEC: '0' }, log: join(project, '.expo-fast', logName) });
}

export function pinRuntimeDependencies(projectRoot, sdkRoot = resolve(process.env.EXPO_HARMONY_SDK_ROOT || join(root, '../devkit_sdk'))) {
  const project = resolve(projectRoot);
  const runtimePath = sdkRuntimePath(resolve(sdkRoot));
  const runtime = readJson(runtimePath);
  const packagePath = join(project, 'package.json');
  const scaffoldPath = join(project, '.expo-fast/scaffold-package.json');
  const pkg = readJson(packagePath);
  const scaffold = readJson(scaffoldPath);
  if (!pkg || !scaffold) throw new Error(`prepared package contracts are missing under ${project}`);
  pkg.dependencies ||= {};
  scaffold.dependencies ||= {};
  const pins = {};
  for (const name of runtimeCorePackages) {
    const version = runtime.packageVersions?.[name];
    if (!version) throw new Error(`Harmony Go runtime does not declare ${name}`);
    pkg.dependencies[name] = version;
    scaffold.dependencies[name] = version;
    pins[name] = version;
  }
  writeJson(packagePath, pkg);
  writeJson(scaffoldPath, scaffold);
  return { runtimePath, runtimeVersion: runtime.runtimeVersion, pins };
}

function recordRegistryInstall(project, pins, install, cacheFailure = null) {
  const pkg = readJson(join(project, 'package.json'), {});
  const modules = join(project, 'node_modules');
  const names = [...new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})])].sort();
  const fingerprint = readJson(join(project, '.expo-fast/sdk-fingerprint.json'));
  const evidence = {
    schemaVersion: 2,
    strategy: 'registry-install',
    configuredCaches: configuredCaches(),
    cacheFailure,
    installedAt: new Date().toISOString(),
    installMs: install.ms,
    runtimeCorePins: pins,
    actualVersions: Object.fromEntries(names.map((name) => [name, packageVersion(modules, name)])),
    sdkFingerprint: fingerprint,
  };
  writeJson(join(project, '.expo-fast/module-cache.json'), evidence);
  return evidence;
}

export function seedDependencies(projectRoot, sdkRoot = resolve(process.env.EXPO_HARMONY_SDK_ROOT || join(root, '../devkit_sdk'))) {
  const project = resolve(projectRoot);
  const runtime = pinRuntimeDependencies(project, sdkRoot);
  const caches = configuredCaches();
  let cacheFailure = null;
  if (caches.length) {
    const cached = spawnSync(process.execPath, [helper, 'seed-modules', project], {
      cwd: root,
      env: { ...process.env, EXPO_HARMONY_SDK_ROOT: resolve(sdkRoot), EXPO_FAST_MODULE_CACHE: caches.join(delimiter) },
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
    if (cached.status === 0) {
      const evidencePath = join(project, '.expo-fast/module-cache.json');
      const evidence = readJson(evidencePath, { schemaVersion: 2 });
      const runtimeMismatches = Object.entries(runtime.pins)
        .filter(([name, version]) => packageVersion(join(project, 'node_modules'), name) !== version);
      if (!runtimeMismatches.length) {
        evidence.schemaVersion = 2;
        evidence.strategy = 'configured-cache';
        evidence.runtimeCorePins = runtime.pins;
        writeJson(evidencePath, evidence);
        return evidence;
      }
      cacheFailure = `configured cache has incompatible Harmony runtime dependencies: ${runtimeMismatches
        .map(([name, version]) => `${name} expected ${version}, found ${packageVersion(join(project, 'node_modules'), name) || 'missing'}`)
        .join('; ')}`;
    } else {
      cacheFailure = `${cached.stderr || cached.stdout || `cache seed exited ${cached.status}`}`.trim().slice(0, 8000);
    }
  }

  const install = installProjectDependencies(project, 'dependency-install.log');
  return recordRegistryInstall(project, runtime.pins, install, cacheFailure);
}

export function syncDependencies(projectRoot) {
  const project = resolve(projectRoot);
  run(process.execPath, [helper, 'resolve-capabilities', project], { cwd: root });
  const resolution = readJson(join(project, '.expo-fast/capability-selection.json'));
  if (!resolution || resolution.status !== 'pass') throw new Error(`capability selection did not pass under ${project}`);
  const modules = join(project, 'node_modules');
  const expected = Object.fromEntries(resolution.selected.map((entry) => [entry.package, entry.version]));
  const missing = Object.entries(expected)
    .filter(([name, version]) => packageVersion(modules, name) !== version)
    .map(([name]) => name);
  const install = missing.length ? installProjectDependencies(project, 'dependency-sync-install.log') : { ms: 0, output: '' };
  const unresolved = Object.entries(expected).filter(([name, version]) => packageVersion(modules, name) !== version);
  if (unresolved.length) {
    throw new Error(`selected dependency versions are unresolved:\n${unresolved
      .map(([name, version]) => `- ${name}: expected ${version}, found ${packageVersion(modules, name) || 'missing'}`)
      .join('\n')}`);
  }
  const evidencePath = join(project, '.expo-fast/module-cache.json');
  const evidence = readJson(evidencePath, { schemaVersion: 2, strategy: 'registry-install' });
  evidence.schemaVersion = 2;
  evidence.capabilitySelection = '.expo-fast/capability-selection.json';
  evidence.selectedCapabilities = expected;
  evidence.installed = [...new Set([...(evidence.installed || []), ...missing])].sort();
  evidence.actualVersions = {
    ...(evidence.actualVersions || {}),
    ...Object.fromEntries(Object.keys(expected).map((name) => [name, packageVersion(modules, name)])),
  };
  evidence.lastSync = { strategy: 'project-npm-install', installMs: install.ms, installed: missing };
  writeJson(evidencePath, evidence);
  return { resolution, installed: missing, installMs: install.ms };
}

export function stageHarmonyCli(projectRoot, sdkRoot = resolve(process.env.EXPO_HARMONY_SDK_ROOT || join(root, '../devkit_sdk'))) {
  const project = resolve(projectRoot);
  const source = join(resolve(sdkRoot), 'packages/@expo/cli/harmony');
  const installedCli = join(project, 'node_modules/@expo/cli');
  const target = join(installedCli, 'harmony');
  if (!existsSync(join(source, 'expo-harmony.mjs'))) throw new Error(`SDK Harmony CLI is missing: ${source}`);
  if (!existsSync(join(installedCli, 'package.json'))) throw new Error(`project @expo/cli is not installed: ${installedCli}`);
  cpSync(source, target, { recursive: true, force: true });
  return join(target, 'expo-harmony.mjs');
}

export function exportHarmonyGo(projectRoot, outputRoot, sdkRoot = resolve(process.env.EXPO_HARMONY_SDK_ROOT || join(root, '../devkit_sdk'))) {
  const project = resolve(projectRoot);
  const output = resolve(outputRoot);
  mkdirSync(output, { recursive: true });
  const cli = stageHarmonyCli(project, sdkRoot);
  const result = run(process.execPath, [cli, 'export-go', '--app-root', project, '--output-dir', output], { cwd: project, log: join(project, '.expo-fast/export.log') });
  writeJson(join(project, '.expo-fast/sdk-cli.json'), {
    schemaVersion: 1,
    strategy: 'project-installed-cli-with-sdk-harmony-overlay',
    cli: relative(project, cli),
    sdkRoot: resolve(sdkRoot),
    exportedAt: new Date().toISOString(),
  });
  return result;
}

function main() {
  const [command, projectArg, outputArg] = process.argv.slice(2);
  const project = resolve(projectArg || '.');
  if (command === 'seed') { console.log(JSON.stringify(seedDependencies(project), null, 2)); return; }
  if (command === 'sync') { console.log(JSON.stringify(syncDependencies(project), null, 2)); return; }
  if (command === 'export') { exportHarmonyGo(project, resolve(outputArg || join(project, 'dist/harmony-go'))); return; }
  throw new Error('usage: dependencies.mjs seed|sync|export <project> [output]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
