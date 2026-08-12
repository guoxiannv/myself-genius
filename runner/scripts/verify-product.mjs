#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const infrastructurePackages = new Set(['react', 'react-native', 'expo']);

function json(path, fallback = null) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function walk(rootDir, output = []) {
  if (!existsSync(rootDir)) return output;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const path = join(rootDir, entry.name);
    if (entry.isDirectory()) walk(path, output);
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
function productFiles(project) { return [join(project, 'App.tsx'), ...walk(join(project, 'src'))].filter((path) => existsSync(path) && sourceExtensions.has(extname(path))).sort(); }
function digestFiles(paths, root) { const hash = createHash('sha256'); for (const path of paths) hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0'); return hash.digest('hex'); }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function packageName(specifier) { if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/')) return ''; const parts = specifier.split('/'); return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]; }
function importsFrom(source) {
  const matches = [
    ...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
  ];
  return [...new Set(matches.map((match) => packageName(match[1])).filter(Boolean))].sort();
}
function namedImportsFrom(source) {
  const records = [];
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:type\s+)?[^'";]*?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[2];
    const importedPackage = packageName(specifier);
    if (!importedPackage) continue;
    const names = match[1].split(',').map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(Boolean);
    records.push({ package: importedPackage, specifier, names });
  }
  return records;
}
function requiredLiterals(request) {
  const rules = [
    [/今日建议量|剩余量.*剩余天数/s, ['今日建议']],
    [/预计完成日/, ['预计完成']],
    [/休息日/, ['休息日']],
    [/补记/, ['补记']],
    [/逾期目标/, ['逾期']],
    [/周报/, ['周报']],
    [/环比/, ['环比']],
    [/保持、问题、尝试、下周预案|保持.*问题.*尝试.*下周预案/s, ['保持', '问题', '尝试', '下周预案']],
    [/导出 JSON/, ['导出']],
    [/导入/, ['导入']],
    [/清空全部/, ['清空']],
    [/添加到手机主屏幕/, ['主屏幕']],
  ];
  return rules.filter(([pattern]) => pattern.test(request)).flatMap(([, literals]) => literals);
}

export function auditProductSource(projectRoot, requestPath = join(projectRoot, '.expo-fast/request.md')) {
  const project = resolve(projectRoot);
  const files = productFiles(project);
  const sources = files.map((path) => ({ path, value: readFileSync(path, 'utf8') }));
  const combined = sources.map((entry) => entry.value).join('\n');
  const request = existsSync(requestPath) ? readFileSync(requestPath, 'utf8') : '';
  const catalog = json(join(project, '.expo-fast/capability-catalog.json'), { available: [] });
  const pkg = json(join(project, 'package.json'), {});
  const declared = new Set(Object.keys(pkg.dependencies || {}));
  const catalogued = new Set((catalog.available || []).map((entry) => entry.package));
  const imports = [...new Set(sources.flatMap((entry) => importsFrom(entry.value)))].sort();
  const namedImports = sources.flatMap((entry) => namedImportsFrom(entry.value).map((record) => ({ file: relative(project, entry.path), ...record })));
  const errors = [];
  const warnings = [];
  if (!files.length) errors.push('No App.tsx/src product sources found.');
  for (const imported of imports) {
    if (!declared.has(imported) && !infrastructurePackages.has(imported)) errors.push(`Source imports undeclared package: ${imported}`);
    if (!infrastructurePackages.has(imported) && !catalogued.has(imported) && !imported.startsWith('@babel/')) errors.push(`Source imports package absent from capability catalog: ${imported}`);
  }
  for (const record of namedImports) {
    if (infrastructurePackages.has(record.package)) continue;
    const capability = (catalog.available || []).find((entry) => entry.package === record.package);
    if (!capability) continue;
    const supported = new Set(capability.supportedExports || []);
    for (const name of record.names) {
      if (!supported.has(name) && !supported.has(`${record.specifier}:${name}`)) errors.push(`${record.file} imports unsupported ${record.specifier} export ${name}`);
    }
  }
  const requireCapability = (pattern, packages, behavior) => {
    if (!pattern.test(request)) return;
    const supportedPackages = packages.filter((name) => catalogued.has(name));
    if (!supportedPackages.length) {
      errors.push(`Requested ${behavior} has no available platform capability in the active catalog (${packages.join(' or ')}).`);
      return;
    }
    if (!supportedPackages.some((name) => imports.includes(name))) {
      errors.push(`Requested ${behavior} must use a catalog-selected platform capability: ${supportedPackages.join(' or ')}.`);
    }
  };
  const jsonExportRequested = /导出\s*JSON|JSON\s*导出|export\s+(?:a\s+)?JSON/i.test(request);
  if (jsonExportRequested) {
    requireCapability(/./, ['expo-sharing'], 'JSON export');
    if (imports.includes('expo-sharing') && !/\bshareAsync\s*\(/.test(combined)) errors.push('Requested JSON export must call expo-sharing shareAsync in the direct action.');
  }
  if (jsonExportRequested && /导入|import/i.test(request)) {
    requireCapability(/./, ['expo-document-picker'], 'JSON import');
    if (imports.includes('expo-document-picker') && !/\bgetDocumentAsync\s*\(/.test(combined)) errors.push('Requested JSON import must call expo-document-picker getDocumentAsync in the direct action.');
  }
  const clipboardRequested = /(?:复制|拷贝)(?:周报|文本|内容|JSON)?|copy(?:\s+to)?\s+clipboard/i.test(request);
  if (clipboardRequested) {
    requireCapability(/./, ['expo-clipboard'], 'clipboard copy');
    if (imports.includes('expo-clipboard') && !/\bsetStringAsync\s*\(/.test(combined)) errors.push('Requested clipboard copy must call expo-clipboard setStringAsync.');
  }
  requireCapability(/触觉|震动|haptic/i, ['expo-haptics'], 'haptic feedback');
  requireCapability(/状态栏|status\s*bar/i, ['expo-status-bar'], 'status-bar control');
  const svgRequested = /inline\s*svg|SVG|图标|icon/i.test(request);
  if (svgRequested) {
    if (!imports.includes('react-native-svg')) errors.push('Request requires inline SVG but source does not import react-native-svg.');
    if (!/<(?:Svg|Path|Circle|Rect|Line|Polyline|Polygon)\b/.test(combined)) errors.push('Request requires inline SVG but source contains no SVG primitives.');
    if (/from\s+['"][^'"]*(?:lucide|vector-icons|iconoir|phosphor|heroicons)[^'"]*['"]/i.test(combined)) errors.push('External icon libraries are forbidden; use local react-native-svg primitives.');
    if (/[⌂▥▦◉]/u.test(combined)) errors.push('Source contains forbidden text glyph icons (⌂/▥/▦/◉).');
    if (/\p{Extended_Pictographic}/u.test(combined)) errors.push('Source contains emoji; production icons must be inline SVG.');
  }
  const iconSources = sources.filter((entry) => /(?:^|\/)icons\.tsx$/.test(relative(project, entry.path).replaceAll('\\', '/')));
  for (const entry of iconSources) {
    if (/<(?:Circle|Line|Polyline|Rect|Polygon)\b/.test(entry.value)) {
      errors.push(`${relative(project, entry.path)} must use Path-only production icon geometry for Harmony Go; encode other shapes as path commands.`);
    }
  }
  const browserStorageRequested = /localStorage|即时保存/.test(request);
  const persistenceRequested = browserStorageRequested || /持久化|本地保存|离线保存|重启后.*(?:保留|恢复)/.test(request);
  if (persistenceRequested) {
    const usesAsyncStorage = imports.includes('@react-native-async-storage/async-storage');
    const usesSecureStore = imports.includes('expo-secure-store');
    if (browserStorageRequested && !usesAsyncStorage) errors.push('Browser-style bulk localStorage requires the catalogued AsyncStorage package.');
    if (!browserStorageRequested && !usesAsyncStorage && !usesSecureStore) errors.push('Persistent native data requires a catalog-selected storage capability.');
    if (usesAsyncStorage && !/AsyncStorage\s*\.\s*getItem\s*\(/.test(combined)) errors.push('Persistence contract requires AsyncStorage.getItem hydration.');
    if (usesAsyncStorage && !/AsyncStorage\s*\.\s*setItem\s*\(/.test(combined)) errors.push('Persistence contract requires AsyncStorage.setItem saves.');
    if (usesSecureStore && !/\bgetItemAsync\s*\(/.test(combined)) errors.push('SecureStore persistence requires getItemAsync hydration.');
    if (usesSecureStore && !/\bsetItemAsync\s*\(/.test(combined)) errors.push('SecureStore persistence requires setItemAsync saves.');
    if (/\blocalStorage\s*\./.test(combined)) errors.push('Browser localStorage is invalid in this native Harmony app; use AsyncStorage.');
    if (usesAsyncStorage) {
      const slug = json(join(project, 'app.json'), {})?.expo?.slug || basename(project);
      if (!combined.includes(slug)) errors.push(`AsyncStorage key must be namespaced with the mini-app slug/id: ${slug}`);
    }
  }
  if (/四个\s*Tab|四个页面|4\s*Tabs?|four\s+tabs?/i.test(request)) {
    for (const label of ['今日', '看板', '周报', '我的']) if (!combined.includes(label)) errors.push(`Four-tab contract is missing visible label: ${label}`);
  }
  if (/近\s*14\s*天.*SVG|SVG.*近\s*14\s*天/s.test(request) && !/<(?:Rect|Path)\b/.test(combined)) errors.push('The 14-day chart must be drawn with inline SVG shapes.');
  for (const literal of [...new Set(requiredLiterals(request))]) if (!combined.includes(literal)) errors.push(`Requested product surface is absent from source: ${literal}`);
  const testIds = [...combined.matchAll(/\btestID\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const minimumTestIds = /四个\s*Tab|四个页面|4\s*Tabs?|four\s+tabs?/i.test(request) ? 6 : 2;
  if (new Set(testIds).size < minimumTestIds) errors.push(`Source needs at least ${minimumTestIds} stable literal testID values; found ${new Set(testIds).size}.`);
  const templateMarkers = ['Product starter', '把明确任务变成可验证的体验', '请删除全部模板文案和示例数据', '核心状态闭环'];
  for (const marker of templateMarkers) if (combined.includes(marker)) errors.push(`Template residue remains in product source: ${marker}`);
  const multiDeviceRequested = /(?:手机|phone)[\s\S]*(?:平板|tablet)[\s\S]*(?:电脑|桌面|desktop|computer)|(?:平板|tablet)[\s\S]*(?:电脑|桌面|desktop|computer)/i.test(request);
  if (multiDeviceRequested) {
    if (!/useWindowDimensions\s*\(/.test(combined)) errors.push('Multi-device layout must use useWindowDimensions logical-width evidence.');
    if (!/\b640\b/.test(combined)) errors.push('Multi-device layout is missing the phone/tablet logical breakpoint 640.');
    if (!/\b1280\b/.test(combined)) errors.push('Multi-device layout is missing the tablet/desktop logical breakpoint 1280.');
    if (/(?:多栏|多列|multi[ -]?column)/i.test(request) && !/(?:flexWrap\s*:\s*['"]wrap|numColumns\s*=|(?:flexBasis|width)\s*:\s*['"](?:4[5-9]|50)%)/.test(combined)) errors.push('Requested desktop multi-column layout has no wrapping, column-count, or near-half-width card evidence.');
    if (/\{\s*(?:isDesktop|desktop)\s*&&\s*(?:navigation|nav)\s*\}\s*<View\b[^>]*(?:frame|shell|container)/i.test(combined)) errors.push('Desktop navigation appears before/outside the layout frame; sidebar and main must be siblings inside the same horizontal root container.');
  }
  const evidence = { schemaVersion: 1, status: errors.length ? 'fail' : 'pass', auditedAt: new Date().toISOString(), productInputSha256: digestFiles([...files, join(project, 'app.json'), join(project, 'package.json')].filter(existsSync).sort(), project), files: files.map((path) => relative(project, path)), imports, namedImports, testIds: [...new Set(testIds)].sort(), errors, warnings };
  writeJson(join(project, '.expo-fast/source-audit.json'), evidence);
  writeFileSync(join(project, '.expo-fast/source-audit.log'), `${[...errors, ...warnings].join('\n')}${errors.length || warnings.length ? '\n' : ''}`);
  return evidence;
}

export function verifyHarmonyGoArtifacts(projectRoot, outputRoot = join(projectRoot, 'dist/harmony-go')) {
  const project = resolve(projectRoot); const output = resolve(outputRoot); const errors = [];
  const runtimePath = join(output, 'runtime.json'); const catalogPath = join(output, 'catalog.json');
  const sourceAudit = json(join(project, '.expo-fast/source-audit.json'));
  const fingerprint = json(join(project, '.expo-fast/sdk-fingerprint.json'));
  const capabilityCatalog = json(join(project, '.expo-fast/capability-catalog.json'), { available: [] });
  const pkg = json(join(project, 'package.json'), {});
  const runtime = json(runtimePath); const catalog = json(catalogPath);
  if (!runtime || !statSafe(runtimePath)) errors.push('Harmony Go runtime.json is missing, empty, or invalid.');
  if (!Array.isArray(catalog) || !statSafe(catalogPath)) errors.push('Harmony Go catalog.json is missing, empty, or invalid.');
  const artifacts = [];
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    const manifestPath = join(output, String(entry.manifestUrl || '').replace(/^\//, ''));
    const manifest = json(manifestPath);
    if (!manifest || !statSafe(manifestPath)) { errors.push(`Manifest is missing, empty, or invalid: ${relative(project, manifestPath)}`); continue; }
    const bundlePath = join(output, String(manifest.bundle?.url || '').replace(/^\//, ''));
    const actualSha256 = statSafe(bundlePath) ? sha256(bundlePath) : '';
    if (!actualSha256) errors.push(`Bundle is missing or empty: ${relative(project, bundlePath)}`);
    if (runtime?.runtimeVersion !== manifest.runtimeVersion) errors.push(`Manifest ${manifest.id} runtimeVersion differs from runtime.json.`);
    if (fingerprint?.runtimeVersion && fingerprint.runtimeVersion !== runtime?.runtimeVersion) errors.push('Exported runtimeVersion differs from the selected SDK fingerprint.');
    if (manifest.bundle?.sha256 !== actualSha256) errors.push(`Bundle SHA-256 differs from manifest for ${manifest.id}.`);
    const required = manifest.requiredPackageVersions || {};
    for (const imported of sourceAudit?.imports || []) {
      if (infrastructurePackages.has(imported) || imported.startsWith('@babel/')) continue;
      const selected = (capabilityCatalog.available || []).find((entry) => entry.package === imported)?.version || '';
      const declared = pkg.dependencies?.[imported] || pkg.devDependencies?.[imported] || '';
      if (!required[imported]) errors.push(`Manifest ${manifest.id} omits imported runtime package ${imported}.`);
      if (selected && required[imported] && required[imported] !== selected) errors.push(`Manifest ${manifest.id} requires ${imported}@${required[imported]}, but the capability catalog selected ${selected}.`);
      if (/^\d/.test(declared) && required[imported] && required[imported] !== declared) errors.push(`Manifest ${manifest.id} requires ${imported}@${required[imported]}, but package.json pins ${declared}.`);
    }
    artifacts.push({ id: manifest.id, manifest: relative(project, manifestPath), bundle: relative(project, bundlePath), bytes: statSafe(bundlePath) ? statSync(bundlePath).size : 0, sha256: actualSha256, requiredPackageVersions: manifest.requiredPackageVersions || {} });
  }
  if (!artifacts.length) errors.push('Harmony Go catalog has no exported mini app artifacts.');
  if (sourceAudit?.status !== 'pass') errors.push('Source audit evidence is missing or not passing.');
  const evidence = { schemaVersion: 1, status: errors.length ? 'fail' : 'pass', verifiedAt: new Date().toISOString(), runtimeVersion: runtime?.runtimeVersion || '', sdkFingerprint: fingerprint || null, productInputSha256: sourceAudit?.productInputSha256 || '', sourceAudit: '.expo-fast/source-audit.json', catalog: relative(project, catalogPath), artifacts, errors };
  writeJson(join(project, '.expo-fast/build-evidence.json'), evidence);
  if (runtime && statSafe(runtimePath)) writeJson(join(project, '.expo-fast/runtime.json'), runtime);
  if (artifacts[0]) writeFileSync(join(project, '.expo-fast/manifest.json'), readFileSync(join(project, artifacts[0].manifest)));
  return evidence;
}
function statSafe(path) { try { return statSync(path).isFile() && statSync(path).size > 0; } catch { return false; } }

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [command, projectArg, outputArg] = process.argv.slice(2); const project = resolve(projectArg || '.');
  const result = command === 'audit' ? auditProductSource(project) : command === 'artifacts' ? verifyHarmonyGoArtifacts(project, resolve(outputArg || join(project, 'dist/harmony-go'))) : null;
  if (!result) throw new Error('usage: verify-product.mjs audit|artifacts <project> [output]');
  console.log(JSON.stringify(result, null, 2)); if (result.status !== 'pass') process.exitCode = 1;
}
