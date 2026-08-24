#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreCachePackages, resolveCapabilities, scaffoldCapabilityPackages } from './fast-harmony.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const runtimeCorePackages = ['expo-asset', 'expo-constants', 'expo-modules-core'];
export const webRuntimePackages = ['react-dom', 'react-native-web'];

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

function webRuntimePins(pkg) {
  return Object.fromEntries(webRuntimePackages
    .map((name) => [name, pkg.dependencies?.[name] || ''])
    .filter(([, version]) => version));
}

function configuredCaches() {
  return (process.env.EXPO_FAST_MODULE_CACHE || '').split(delimiter).filter(Boolean).map((value) => resolve(root, value));
}

function npmInvocation() {
  const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  try {
    readFileSync(npmCli);
    return { command: process.execPath, prefix: [npmCli] };
  } catch {
    return { command: 'npm', prefix: [] };
  }
}

export function assertDependencyRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node.js 22.13 or newer is required; found ${process.version} at ${process.execPath}`);
  }
  const npm = npmInvocation();
  const result = spawnSync(npm.command, [...npm.prefix, '--version'], {
    env: process.env,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    throw new Error([
      `npm is not usable with the configured Node runtime ${process.execPath}`,
      output || result.error?.message || `npm exited ${result.status ?? 'unknown'}`,
      'Set EXPO_FAST_NODE to a readable Node.js installation that includes an accessible npm command.',
    ].join('\n'));
  }
  return { node: process.version, nodePath: process.execPath, npm: output };
}

export function installProjectDependencies(project, logName, exactDependencies = {}, runner = run) {
  const npm = npmInvocation();
  const exactSpecs = Object.entries(exactDependencies)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => `${name}@${version}`);
  const invoke = (extraFlags) => runner(npm.command, [
    ...npm.prefix,
    'install',
    ...exactSpecs,
    ...(exactSpecs.length ? ['--no-save'] : []),
    '--ignore-scripts',
    '--legacy-peer-deps',
    ...extraFlags,
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
  ], { cwd: project, env: { COREPACK_ENABLE_PROJECT_SPEC: '0' }, log: join(project, '.expo-fast', logName) });

  // --prefer-offline keeps repeated installs fast, but it also lets npm answer
  // from a cached package document without revalidating it. The SDK pins exact
  // versions, so a document cached before one of them was published makes that
  // version look nonexistent and the install fails with ETARGET naming whichever
  // package happens to be stale. Retry once against the registry, which both
  // resolves the version and refreshes the cache for later runs.
  try {
    return invoke(['--prefer-offline']);
  } catch (error) {
    if (!/\bETARGET\b|No matching version found/.test(String(error?.message || ''))) throw error;
    return invoke([]);
  }
}

function assertCompatibleCache(cache, fingerprint) {
  const mismatches = coreCachePackages
    .map((name) => [name, fingerprint?.packageVersions?.[name], packageVersion(cache, name)])
    .filter(([, expected, actual]) => expected && expected !== actual);
  if (mismatches.length) {
    throw new Error(`module cache does not match selected SDK:\n${mismatches
      .map(([name, expected, actual]) => `- ${name}: expected ${expected}, found ${actual || 'missing'}`)
      .join('\n')}`);
  }
}

function mergeMissingCacheEntries(source, target) {
  for (const entry of readdirSync(source)) {
    const sourceEntry = join(source, entry);
    const targetEntry = join(target, entry);
    if (!entry.startsWith('@')) {
      if (!existsSync(targetEntry)) cpSync(sourceEntry, targetEntry, { recursive: true, mode: 2, dereference: true });
      continue;
    }
    mkdirSync(targetEntry, { recursive: true });
    for (const packageName of readdirSync(sourceEntry)) {
      const sourcePackage = join(sourceEntry, packageName);
      const targetPackage = join(targetEntry, packageName);
      if (!existsSync(targetPackage)) cpSync(sourcePackage, targetPackage, { recursive: true, mode: 2, dereference: true });
    }
  }
}

function seedFromConfiguredCache(project, caches, runtimePins) {
  const fingerprint = readJson(join(project, '.expo-fast/sdk-fingerprint.json'));
  if (!fingerprint) throw new Error(`SDK fingerprint is missing under ${project}`);
  const compatible = [];
  const rejected = [];
  for (const cache of caches.filter(existsSync)) {
    try {
      assertCompatibleCache(cache, fingerprint);
      compatible.push(cache);
    } catch (error) {
      rejected.push({ cache, reason: error.message });
    }
  }
  const primary = compatible[0];
  if (!primary) {
    throw new Error(`no compatible node_modules cache\n${rejected
      .map((item) => `${item.cache}: ${item.reason}`)
      .join('\n')}`);
  }

  const modules = join(project, 'node_modules');
  cpSync(primary, modules, { recursive: true, mode: 2, dereference: true });
  for (const cache of compatible.slice(1)) mergeMissingCacheEntries(cache, modules);

  const pkg = readJson(join(project, 'package.json'), {});
  const scaffoldPins = Object.fromEntries(scaffoldCapabilityPackages
    .map((name) => [name, pkg.dependencies?.[name] || ''])
    .filter(([, version]) => version));
  const expected = { ...scaffoldPins, ...runtimePins, ...webRuntimePins(pkg) };
  const missingEntries = Object.entries(expected)
    .filter(([name, version]) => packageVersion(modules, name) !== version);
  const install = missingEntries.length
    ? installProjectDependencies(project, 'dependency-cache-fill.log', Object.fromEntries(missingEntries))
    : { ms: 0, output: '' };
  const unresolved = Object.entries(expected)
    .filter(([name, version]) => packageVersion(modules, name) !== version);
  if (unresolved.length) {
    throw new Error(`configured cache dependencies are unresolved:\n${unresolved
      .map(([name, version]) => `- ${name}: expected ${version}, found ${packageVersion(modules, name) || 'missing'}`)
      .join('\n')}`);
  }

  const actualNames = [...new Set([...coreCachePackages, ...Object.keys(expected)])].sort();
  const evidence = {
    schemaVersion: 2,
    strategy: 'configured-cache',
    configuredCaches: caches,
    selected: primary,
    rejected,
    installed: missingEntries.map(([name]) => name).sort(),
    installedAt: new Date().toISOString(),
    installMs: install.ms,
    runtimeCorePins: runtimePins,
    actualVersions: Object.fromEntries(actualNames.map((name) => [name, packageVersion(modules, name)])),
    sdkFingerprint: fingerprint,
  };
  writeJson(join(project, '.expo-fast/module-cache.json'), evidence);
  return evidence;
}

export function pinRuntimeDependencies(projectRoot, sdkRoot = resolve(root, process.env.EXPO_HARMONY_SDK_ROOT || '../sdk')) {
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

export function seedDependencies(projectRoot, sdkRoot = resolve(root, process.env.EXPO_HARMONY_SDK_ROOT || '../sdk')) {
  const project = resolve(projectRoot);
  const runtime = pinRuntimeDependencies(project, sdkRoot);
  const caches = configuredCaches();
  let cacheFailure = null;
  if (caches.length) {
    try { return seedFromConfiguredCache(project, caches, runtime.pins); }
    catch (error) { cacheFailure = String(error.stack || error).slice(0, 8000); }
  }

  const install = installProjectDependencies(project, 'dependency-install.log');
  return recordRegistryInstall(project, runtime.pins, install, cacheFailure);
}

export function syncDependencies(projectRoot) {
  const project = resolve(projectRoot);
  const resolution = resolveCapabilities(project);
  if (!resolution || resolution.status !== 'pass') throw new Error(`capability selection did not pass under ${project}`);
  const modules = join(project, 'node_modules');
  const selectedCapabilities = Object.fromEntries(resolution.selected.map((entry) => [entry.package, entry.version]));
  const runtimeDependencies = resolution.runtimeDependencies || {};
  const pkg = readJson(join(project, 'package.json'), {});
  const expected = { ...selectedCapabilities, ...runtimeDependencies, ...webRuntimePins(pkg) };
  const missingEntries = Object.entries(expected)
    .filter(([name, version]) => packageVersion(modules, name) !== version);
  const missing = missingEntries.map(([name]) => name);
  const install = missing.length
    ? installProjectDependencies(project, 'dependency-sync-install.log', Object.fromEntries(missingEntries))
    : { ms: 0, output: '' };
  const unresolved = Object.entries(expected).filter(([name, version]) => packageVersion(modules, name) !== version);
  if (unresolved.length) {
    throw new Error(`selected or runtime dependency versions are unresolved:\n${unresolved
      .map(([name, version]) => `- ${name}: expected ${version}, found ${packageVersion(modules, name) || 'missing'}`)
      .join('\n')}`);
  }
  const evidencePath = join(project, '.expo-fast/module-cache.json');
  const evidence = readJson(evidencePath, { schemaVersion: 2, strategy: 'registry-install' });
  evidence.schemaVersion = 2;
  evidence.capabilitySelection = '.expo-fast/capability-selection.json';
  evidence.selectedCapabilities = selectedCapabilities;
  evidence.runtimeDependencies = runtimeDependencies;
  evidence.installed = [...new Set([...(evidence.installed || []), ...missing])].sort();
  evidence.actualVersions = {
    ...(evidence.actualVersions || {}),
    ...Object.fromEntries(Object.keys(expected).map((name) => [name, packageVersion(modules, name)])),
  };
  evidence.lastSync = { strategy: 'project-npm-install', installMs: install.ms, installed: missing };
  writeJson(evidencePath, evidence);
  return { resolution, installed: missing, runtimeDependencies, installMs: install.ms };
}

export function stageHarmonyCli(projectRoot, sdkRoot = resolve(root, process.env.EXPO_HARMONY_SDK_ROOT || '../sdk')) {
  const project = resolve(projectRoot);
  const source = join(resolve(sdkRoot), 'packages/@expo/cli/harmony');
  const installedCli = join(project, 'node_modules/@expo/cli');
  const target = join(installedCli, 'harmony');
  if (!existsSync(join(source, 'expo-harmony.mjs'))) throw new Error(`SDK Harmony CLI is missing: ${source}`);
  if (!existsSync(join(installedCli, 'package.json'))) throw new Error(`project @expo/cli is not installed: ${installedCli}`);
  cpSync(source, target, { recursive: true, force: true });
  return join(target, 'expo-harmony.mjs');
}

export function exportHarmonyGo(projectRoot, outputRoot, sdkRoot = resolve(root, process.env.EXPO_HARMONY_SDK_ROOT || '../sdk')) {
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

function walkFiles(rootDir, output = []) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const path = join(rootDir, entry.name);
    if (entry.isDirectory()) walkFiles(path, output);
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export function inspectExpoWebExport(projectRoot, outputRoot) {
  const project = resolve(projectRoot);
  const output = resolve(outputRoot);
  const outputRelative = relative(project, output);
  if (!outputRelative || outputRelative.startsWith('..') || outputRelative.startsWith('/')) {
    throw new Error(`Expo web output must stay inside the generated project: ${output}`);
  }
  const entryPoint = join(output, 'index.html');
  if (!existsSync(entryPoint) || !statSync(entryPoint).isFile()) {
    throw new Error(`Expo web export is missing index.html: ${output}`);
  }
  const files = walkFiles(output);
  const javascriptFiles = files.filter((path) => /\.js$/i.test(path));
  if (!javascriptFiles.length) {
    throw new Error(`Expo web export contains no JavaScript bundle: ${output}`);
  }
  const html = readFileSync(entryPoint, 'utf8');
  if (!/<div\s+id=["']root["']/i.test(html) || !/<script\b/i.test(html)) {
    throw new Error(`Expo web index.html is not a runnable app entry: ${entryPoint}`);
  }
  return {
    schemaVersion: 1,
    status: 'ready',
    entryPoint: 'index.html',
    fileCount: files.length,
    totalBytes: files.reduce((sum, path) => sum + statSync(path).size, 0),
  };
}

export function exportExpoWeb(projectRoot, outputRoot = join(resolve(projectRoot), 'dist/web')) {
  const project = resolve(projectRoot);
  const output = resolve(outputRoot);
  const outputRelative = relative(project, output);
  if (!outputRelative || outputRelative.startsWith('..') || outputRelative.startsWith('/')) {
    throw new Error(`Expo web output must stay inside the generated project: ${output}`);
  }
  rmSync(output, { recursive: true, force: true });
  const cli = join(project, 'node_modules/expo/bin/cli');
  if (!existsSync(cli)) throw new Error(`project Expo CLI is missing: ${cli}`);
  const result = run(process.execPath, [
    cli,
    'export',
    '--platform',
    'web',
    '--output-dir',
    output,
  ], { cwd: project, log: join(project, '.expo-fast/web-export.log') });
  const evidence = {
    ...inspectExpoWebExport(project, output),
    exportedAt: new Date().toISOString(),
    durationMs: result.ms,
  };
  writeJson(join(output, '.expo-web-export.json'), evidence);
  writeJson(join(project, '.expo-fast/web-export.json'), {
    ...evidence,
    output: outputRelative,
  });
  return evidence;
}

function main() {
  const [command, projectArg, outputArg] = process.argv.slice(2);
  const project = resolve(projectArg || '.');
  if (command === 'check') { console.log(JSON.stringify(assertDependencyRuntime(), null, 2)); return; }
  if (command === 'seed') { console.log(JSON.stringify(seedDependencies(project), null, 2)); return; }
  if (command === 'sync') { console.log(JSON.stringify(syncDependencies(project), null, 2)); return; }
  if (command === 'export') { exportHarmonyGo(project, resolve(outputArg || join(project, 'dist/harmony-go'))); return; }
  if (command === 'export-web') { exportExpoWeb(project, resolve(outputArg || join(project, 'dist/web'))); return; }
  throw new Error('usage: dependencies.mjs check | seed|sync|export|export-web <project> [output]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
