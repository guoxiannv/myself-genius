#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sdk = resolve(process.env.EXPO_HARMONY_SDK_ROOT || '/Users/stefan/Workspaces/fe-project/devkit_sdk');
const skillRoot = resolve(new URL('..', import.meta.url).pathname);
const template = join(skillRoot, 'assets/expo-harmony-template');
const scaffoldCapabilityPackages = ['react-native-svg'];
const harmonyGoRuntimeOverrides = {
  '@react-native-async-storage/async-storage': {
    nativePackage: '@react-native-oh-tpl/async-storage',
    supportedExports: [
      'default',
      'default:clear',
      'default:getAllKeys',
      'default:getItem',
      'default:mergeItem',
      'default:multiGet',
      'default:multiRemove',
      'default:multiSet',
      'default:removeItem',
      'default:setItem',
    ],
  },
};
const coreCachePackages = ['expo', 'react', 'react-native', '@react-native-oh/react-native-harmony', '@react-native-oh/react-native-harmony-cli', '@expo/cli'];
const infrastructurePackages = new Set([
  '@babel/runtime',
  '@expo/cli',
  '@expo/metro',
  '@react-native-community/cli',
  '@react-native-oh/react-native-harmony',
  '@react-native-oh/react-native-harmony-cli',
  'expo',
  'metro',
  'metro-config',
  'react',
  'react-native',
]);

function json(path, fallback = null) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; }
function writeJson(path, value) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: options.cwd, env: { ...process.env, ...(options.env || {}) }, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (options.log) writeFileSync(options.log, `${result.stdout || ''}${result.stderr || ''}`);
  if (result.status !== 0) throw new Error(`${cmd} exited with ${result.status ?? 'unknown'}\n${result.stderr || result.stdout || ''}`);
  return result.stdout || '';
}
function walk(rootDir, out = []) { if (!existsSync(rootDir)) return out; for (const e of readdirSync(rootDir, { withFileTypes: true })) { const p = join(rootDir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; }
function sha256Files(paths, root = sdk) { const hash = createHash('sha256'); for (const path of [...paths].sort()) hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0'); return hash.digest('hex'); }
function replacePlaceholders(projectDir, values) {
  for (const path of walk(projectDir)) {
    if (!/\.(?:[cm]?[jt]sx?|json|md|txt|gitignore)$/.test(path)) continue;
    let content = readFileSync(path, 'utf8');
    for (const [key, value] of Object.entries(values)) content = content.replaceAll(`__${key}__`, value);
    writeFileSync(path, content);
  }
}
function packageRoot(name) {
  const direct = join(sdk, 'packages', ...name.split('/'));
  if (existsSync(join(direct, 'package.json'))) return direct;
  if (name.startsWith('@expo/')) return join(sdk, 'packages', `expo-${name.slice('@expo/'.length)}`);
  return direct;
}
function runtimeContract() {
  const candidates = [
    join(sdk, 'packages/@expo/cli/harmony/harmony-go-runtime.json'),
    join(sdk, 'tools/harmony/harmony-go-runtime.json'),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`Harmony Go runtime contract not found under ${sdk}`);
  return { path, value: json(path) };
}
function supportContracts() {
  const packageContracts = walk(join(sdk, 'packages')).filter((path) => basename(path) === 'harmony-support.json');
  const compatibilityContracts = walk(join(sdk, 'tools/harmony/support/compatibility')).filter((path) => path.endsWith('.json'));
  const contracts = new Map();
  for (const path of [...packageContracts, ...compatibilityContracts].sort()) {
    const record = json(path);
    if (!record?.package) continue;
    if (contracts.has(record.package)) throw new Error(`duplicate Harmony support contract for ${record.package}`);
    contracts.set(record.package, { path, ...record });
  }
  return [...contracts.values()];
}
function contractPasses(record) { return record.validation?.contract && record.validation?.hapBuild && record.validation?.emulator && record.supportLevel !== 'L0' && record.stability !== 'unsupported'; }
function contractVersion(record) { return json(join(packageRoot(record.package), 'package.json'), {}).version || record.contractVersion || ''; }
function catalogEntry(record, version, evidence) {
  return {
    package: record.package,
    version,
    contractVersion: record.contractVersion || version,
    implementation: record.implementation || '',
    supportedExports: [...(record.supportedExports || [])].sort(),
    deferredExports: [...(record.deferredExports || [])].sort(),
    unsupportedExports: [...(record.unsupportedExports || [])].sort(),
    limitations: record.limitations || [],
    constraints: record.constraints || [],
    permissions: record.permissions || [],
    requiredSysCaps: record.requiredSysCaps || [],
    harmonyPorts: record.harmonyPorts || [],
    validation: record.validation || {},
    supportLevel: record.supportLevel,
    stability: record.stability,
    supportContract: relative(sdk, record.path),
    evidence,
  };
}
function sdkFingerprint() {
  const runtime = runtimeContract();
  const contractPaths = [...supportContracts().map((entry) => entry.path), runtime.path];
  const revision = spawnSync('git', ['-C', sdk, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', sdk, 'status', '--short'], { encoding: 'utf8' });
  const templatePackage = json(join(template, 'package.json'), {});
  const packageVersions = {};
  for (const name of coreCachePackages) {
    const packageJson = json(join(packageRoot(name), 'package.json')) || json(join(sdk, 'node_modules', ...name.split('/'), 'package.json'));
    packageVersions[name] = templatePackage.dependencies?.[name] || templatePackage.devDependencies?.[name] || packageJson?.version || runtime.value.packageVersions?.[name] || '';
  }
  for (const name of [...scaffoldCapabilityPackages, ...Object.keys(harmonyGoRuntimeOverrides)]) packageVersions[name] = runtime.value.packageVersions?.[name] || '';
  return {
    schemaVersion: 1,
    sdkRoot: sdk,
    sdkRevision: revision.status === 0 ? revision.stdout.trim() : '',
    sdkDirty: status.status === 0 && status.stdout.trim().length > 0,
    runtimeVersion: runtime.value.runtimeVersion,
    packageVersions,
    contractsSha256: sha256Files(contractPaths),
  };
}
function catalog(projectDir) {
  const runtime = runtimeContract();
  const records = supportContracts();
  const available = records.filter(contractPasses).map((record) => catalogEntry(
    record,
    contractVersion(record),
    record.path.includes('/support/compatibility/') ? 'compatibility-contract' : 'harmony-support',
  ));
  const unavailable = records.filter((record) => !contractPasses(record)).map((record) => ({
    ...catalogEntry(record, contractVersion(record), record.path.includes('/support/compatibility/') ? 'compatibility-contract' : 'harmony-support'),
    reason: !record.validation?.contract || !record.validation?.hapBuild
      ? 'no passing contract and HAP build'
      : 'does not satisfy emulator-validated policy',
  }));
  for (const [packageName, override] of Object.entries(harmonyGoRuntimeOverrides)) {
    const version = runtime.value.packageVersions?.[packageName];
    const nativeVersion = runtime.value.packageVersions?.[override.nativePackage];
    if (!version || !nativeVersion) continue;
    const record = records.find((entry) => entry.package === packageName) || { package: packageName, path: runtime.path };
    const remove = (entries) => { const index = entries.findIndex((entry) => entry.package === packageName); if (index >= 0) entries.splice(index, 1); };
    remove(available); remove(unavailable);
    available.push({
      ...catalogEntry(record, version, 'harmony-go-runtime'),
      supportedExports: override.supportedExports,
      limitations: [
        ...(record.limitations || []),
        `Harmony Go pins the JavaScript package to ${packageName}@${version} and embeds ${override.nativePackage}@${nativeVersion}; this host-specific contract does not claim support for ${record.contractVersion || 'another'} upstream.`,
      ],
      validation: { runtime: true, harmonyGoHost: true },
      supportLevel: 'runtime-embedded',
      stability: 'runtime-pinned',
      runtimeOverride: { nativePackage: override.nativePackage, nativeVersion },
    });
  }
  available.sort((a, b) => a.package.localeCompare(b.package));
  unavailable.sort((a, b) => a.package.localeCompare(b.package));
  const fingerprint = sdkFingerprint();
  const output = { schemaVersion: 3, sdkRoot: sdk, policy: 'emulator-validated-or-runtime-embedded', baseline: { expo: runtime.value.packageVersions.expo, react: fingerprint.packageVersions.react, reactNative: runtime.value.nativeRuntime?.reactNative, rnoh: runtime.value.nativeRuntime?.rnoh, harmonyApi: runtime.value.nativeRuntime?.harmonyApi, runtimeVersion: runtime.value.runtimeVersion }, contractsSha256: fingerprint.contractsSha256, available, unavailable, unavailableCount: unavailable.length, generatedAt: new Date().toISOString(), authority: 'Product capabilities must be direct package.json dependencies at the exact available[] version. Expo modules and registered React Native compatibility packages share this catalog.' };
  mkdirSync(join(projectDir, '.expo-fast'), { recursive: true });
  writeJson(join(projectDir, '.expo-fast/capability-catalog.json'), output);
  writeJson(join(projectDir, '.expo-fast/sdk-fingerprint.json'), fingerprint);
  return output;
}
function configurePackageJson(projectDir, capabilityCatalog) {
  const path = join(projectDir, 'package.json');
  const pkg = json(path);
  pkg.dependencies ||= {};
  for (const packageName of scaffoldCapabilityPackages) {
    const capability = capabilityCatalog.available.find((entry) => entry.package === packageName);
    if (!capability?.version) throw new Error(`scaffold capability is unavailable: ${packageName}`);
    pkg.dependencies[packageName] = capability.version;
  }
  writeJson(path, pkg);
  writeJson(join(projectDir, '.expo-fast/scaffold-package.json'), pkg);
}
function prepare(projectDir, requestFile) {
  mkdirSync(projectDir, { recursive: true });
  if (readdirSync(projectDir).length) throw new Error(`target must be empty: ${projectDir}`);
  if (!existsSync(join(template, 'metro.harmony.config.js'))) throw new Error(`self-contained template is incomplete: ${template}`);
  cpSync(template, projectDir, { recursive: true });
  const slug = basename(projectDir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'generated';
  replacePlaceholders(projectDir, { APP_NAME: slug, APP_SLUG: slug, APP_SCHEME: slug.replaceAll('-', ''), BUNDLE_IDENTIFIER: `com.fwxt.fast.${slug.replaceAll('-', '.')}`.slice(0, 127) });
  const app = json(join(projectDir, 'app.json')); app.expo.name = slug; app.expo.slug = slug; app.expo.scheme = slug; app.expo.harmony.bundleIdentifier = `com.fwxt.fast.${slug.replaceAll('-', '.')}`.slice(0, 127); writeJson(join(projectDir, 'app.json'), app);
  mkdirSync(join(projectDir, '.expo-fast'), { recursive: true });
  writeFileSync(join(projectDir, '.expo-fast/request.md'), readFileSync(resolve(requestFile)));
  const capabilityCatalog = catalog(projectDir);
  configurePackageJson(projectDir, capabilityCatalog);
  return projectDir;
}
function packageVersion(modulesRoot, name) { return json(join(modulesRoot, ...name.split('/'), 'package.json'), {}).version || ''; }
function assertCoreCache(cache, fingerprint) {
  const mismatches = coreCachePackages.map((name) => [name, fingerprint.packageVersions[name], packageVersion(cache, name)]).filter(([, expected, actual]) => expected && expected !== actual);
  if (mismatches.length) throw new Error(`module cache does not match selected SDK:\n${mismatches.map(([name, expected, actual]) => `- ${name}: expected ${expected}, found ${actual || 'missing'}`).join('\n')}`);
}
function moduleCaches() {
  const configured = (process.env.EXPO_FAST_MODULE_CACHE || '').split(delimiter).filter(Boolean).map((value) => resolve(value));
  if (configured.length) return configured;
  return ['/Users/stefan/Workspaces/fe-project/expo-app/test-project-go/node_modules', '/Users/stefan/Workspaces/fe-project/expo-app/expo-runner-livetest-go/node_modules'];
}
function resolveCapabilities(projectDir) {
  const pkg = json(join(projectDir, 'package.json'), {});
  const scaffold = json(join(projectDir, '.expo-fast/scaffold-package.json'), {});
  const capabilityCatalog = json(join(projectDir, '.expo-fast/capability-catalog.json'), { available: [], unavailable: [] });
  const available = new Map(capabilityCatalog.available.map((entry) => [entry.package, entry]));
  const unavailable = new Map(capabilityCatalog.unavailable.map((entry) => [entry.package, entry]));
  const dependencies = pkg.dependencies || {};
  const scaffoldDependencies = scaffold.dependencies || {};
  const errors = [];
  const selected = [];

  for (const [packageName, version] of Object.entries(scaffoldDependencies)) {
    if (dependencies[packageName] !== version) errors.push(`fixed scaffold dependency ${packageName} must remain ${version}`);
  }
  const packageContract = Object.fromEntries(Object.entries(pkg).filter(([key]) => key !== 'dependencies'));
  const scaffoldContract = Object.fromEntries(Object.entries(scaffold).filter(([key]) => key !== 'dependencies'));
  if (stableJson(packageContract) !== stableJson(scaffoldContract)) errors.push('Product implementation may change only package.json dependencies.');
  for (const [packageName, version] of Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) {
    if (infrastructurePackages.has(packageName)) {
      if (!Object.hasOwn(scaffoldDependencies, packageName)) errors.push(`Product implementation may not add infrastructure dependency ${packageName}`);
      continue;
    }
    const capability = available.get(packageName);
    if (!capability) {
      const rejected = unavailable.get(packageName);
      errors.push(rejected
        ? `${packageName}@${version} is unavailable: ${rejected.reason}`
        : `${packageName}@${version} is absent from the active capability catalog`);
      continue;
    }
    if (version !== capability.version) errors.push(`${packageName} must use exact catalog version ${capability.version}; found ${version}`);
    selected.push({
      package: packageName,
      version: capability.version,
      origin: Object.hasOwn(scaffoldDependencies, packageName) ? 'scaffold' : 'product',
      implementation: capability.implementation,
      supportedExports: capability.supportedExports,
      limitations: capability.limitations,
      evidence: capability.evidence,
      supportContract: capability.supportContract,
    });
  }
  const result = {
    schemaVersion: 1,
    status: errors.length ? 'fail' : 'pass',
    resolvedAt: new Date().toISOString(),
    catalogContractsSha256: capabilityCatalog.contractsSha256 || '',
    selected,
    errors,
  };
  writeJson(join(projectDir, '.expo-fast/capability-selection.json'), result);
  if (errors.length) throw new Error(`capability resolution failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  return result;
}
function installMissingPackages(projectDir, expectedVersions) {
  const target = join(projectDir, 'node_modules');
  const missing = Object.keys(expectedVersions).filter((name) => packageVersion(target, name) !== expectedVersions[name]);
  if (!missing.length) return [];
  const staging = mkdtempSync(join(tmpdir(), 'expo-fast-selected-packages.'));
  try {
    writeJson(join(staging, 'package.json'), { name: 'expo-fast-selected-packages', version: '1.0.0', private: true, dependencies: Object.fromEntries(missing.map((name) => [name, expectedVersions[name]])) });
    const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    const command = existsSync(npmCli) ? process.execPath : 'npm';
    const args = existsSync(npmCli) ? [npmCli, 'install'] : ['install'];
    run(command, [...args, '--ignore-scripts', '--legacy-peer-deps', '--prefer-offline', '--no-audit', '--no-fund', '--package-lock=false', '--save-exact'], { cwd: staging, env: { COREPACK_ENABLE_PROJECT_SPEC: '0' } });
    const stagingModules = join(staging, 'node_modules');
    for (const entry of readdirSync(stagingModules)) {
      if (entry === '.bin') continue;
      const from = join(stagingModules, entry); const to = join(target, entry);
      if (entry.startsWith('@')) {
        mkdirSync(to, { recursive: true });
        for (const scopedEntry of readdirSync(from)) {
          const scopedTarget = join(to, scopedEntry);
          if (missing.includes(`${entry}/${scopedEntry}`)) rmSync(scopedTarget, { recursive: true, force: true });
          if (!existsSync(scopedTarget)) cpSync(join(from, scopedEntry), scopedTarget, { recursive: true, mode: 2, dereference: true });
        }
      } else {
        if (missing.includes(entry)) rmSync(to, { recursive: true, force: true });
        if (!existsSync(to)) cpSync(from, to, { recursive: true, mode: 2, dereference: true });
      }
    }
    const unresolved = missing.filter((name) => packageVersion(target, name) !== expectedVersions[name]);
    if (unresolved.length) throw new Error(`failed to prepare selected package(s): ${unresolved.join(', ')}`);
    return missing;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function seedModules(projectDir) {
  const fingerprint = json(join(projectDir, '.expo-fast/sdk-fingerprint.json')) || sdkFingerprint();
  const caches = moduleCaches().filter(existsSync);
  let primary;
  const rejected = [];
  for (const cache of caches) {
    try { assertCoreCache(cache, fingerprint); primary = cache; break; } catch (error) { rejected.push({ cache, reason: error.message }); }
  }
  if (!primary) throw new Error(`no compatible node_modules cache\n${rejected.map((item) => `${item.cache}: ${item.reason}`).join('\n')}`);
  const target = join(projectDir, 'node_modules');
  cpSync(primary, target, { recursive: true, mode: 2, dereference: true });
  for (const cache of caches.filter((path) => path !== primary)) {
    try { assertCoreCache(cache, fingerprint); } catch { continue; }
    for (const entry of readdirSync(cache)) { const from = join(cache, entry); const to = join(target, entry); if (!existsSync(to)) cpSync(from, to, { recursive: true, mode: 2, dereference: true }); }
  }
  const pkg = json(join(projectDir, 'package.json'), {});
  const expected = Object.fromEntries(scaffoldCapabilityPackages.map((name) => [name, pkg.dependencies?.[name] || '']).filter(([, version]) => version));
  const installed = installMissingPackages(projectDir, expected);
  const actualVersions = Object.fromEntries([...coreCachePackages, ...scaffoldCapabilityPackages].map((name) => [name, packageVersion(target, name)]));
  writeJson(join(projectDir, '.expo-fast/module-cache.json'), { schemaVersion: 1, selected: primary, rejected, installed, actualVersions, sdkFingerprint: fingerprint });
}
function syncDependencies(projectDir) {
  const resolution = resolveCapabilities(projectDir);
  const expected = Object.fromEntries(resolution.selected.map((entry) => [entry.package, entry.version]));
  const installed = installMissingPackages(projectDir, expected);
  const target = join(projectDir, 'node_modules');
  const unresolved = Object.entries(expected).filter(([name, version]) => packageVersion(target, name) !== version);
  if (unresolved.length) throw new Error(`selected dependency versions are unresolved:\n${unresolved.map(([name, version]) => `- ${name}: expected ${version}, found ${packageVersion(target, name) || 'missing'}`).join('\n')}`);
  const cachePath = join(projectDir, '.expo-fast/module-cache.json');
  const cache = json(cachePath, { schemaVersion: 1 });
  cache.capabilitySelection = '.expo-fast/capability-selection.json';
  cache.selectedCapabilities = expected;
  cache.installed = [...new Set([...(cache.installed || []), ...installed])].sort();
  cache.actualVersions = { ...(cache.actualVersions || {}), ...Object.fromEntries(Object.keys(expected).map((name) => [name, packageVersion(target, name)])) };
  writeJson(cachePath, cache);
  return resolution;
}
function localizePackageJson(projectDir) {
  const path = join(projectDir, 'package.json'); const pkg = json(path); const local = ['expo', '@expo/cli', '@expo/metro', '@expo/metro-config', '@react-native-oh/react-native-harmony', '@react-native-oh/react-native-harmony-cli', 'expo-modules-core'];
  for (const name of local) { const base = packageRoot(name); if (existsSync(join(base, 'package.json'))) { if (pkg.dependencies?.[name]) pkg.dependencies[name] = `file:${base}`; if (pkg.devDependencies?.[name]) pkg.devDependencies[name] = `file:${base}`; } }
  pkg.dependencies ||= {}; pkg.dependencies['@expo/metro-runtime'] ||= '57.0.7'; writeJson(path, pkg);
}
function exportGo(projectDir, outputDir) { mkdirSync(outputDir, { recursive: true }); const cli = join(sdk, 'packages/@expo/cli/harmony/expo-harmony.mjs'); return run(process.execPath, [cli, 'export-go', '--app-root', projectDir, '--output-dir', outputDir], { cwd: projectDir, capture: true, log: join(projectDir, '.expo-fast/export.log') }); }
function main() {
  const [command, projectArg, requestArg] = process.argv.slice(2); const project = resolve(projectArg || '.');
  if (command === 'catalog') { console.log(JSON.stringify(catalog(project), null, 2)); return; }
  if (command === 'prepare') { prepare(project, requestArg); console.log(project); return; }
  if (command === 'seed-modules') { seedModules(project); return; }
  if (command === 'resolve-capabilities') { console.log(JSON.stringify(resolveCapabilities(project), null, 2)); return; }
  if (command === 'sync-dependencies') { console.log(JSON.stringify(syncDependencies(project), null, 2)); return; }
  if (command === 'install') { localizePackageJson(project); run('npm', ['install', '--legacy-peer-deps'], { cwd: project }); return; }
  if (command === 'export-go') { exportGo(project, resolve(requestArg || join(project, 'dist/harmony-go'))); return; }
  throw new Error('usage: fast-harmony.mjs catalog|prepare|seed-modules|resolve-capabilities|sync-dependencies|install|export-go <project> [request/output]');
}
try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
