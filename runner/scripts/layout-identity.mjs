import { harmonyGoBundleName } from './harmony-go-runtime.mjs';

const HARMONY_GO_ACTIVE_MINI_APP_ID_PREFIX = 'harmony-go-active-mini-app-';
const BUILD_IDENTITY_NODE_ID_PREFIX = 'genius-build-';
const HARMONY_GO_CATALOG_MINI_APP_ID_PREFIX = 'harmony-go-catalog-mini-app-';

export function harmonyGoActiveMiniAppNodeId(manifestId) {
  return `${HARMONY_GO_ACTIVE_MINI_APP_ID_PREFIX}${manifestId}`;
}

export function harmonyGoCatalogMiniAppNodeId(manifestId) {
  return `${HARMONY_GO_CATALOG_MINI_APP_ID_PREFIX}${manifestId}`;
}

function children(node) { return node?.children || []; }
function collect(node, predicate, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (predicate(node)) output.push(node);
  for (const child of children(node)) collect(child, predicate, output);
  return output;
}
function nodeText(node) {
  const attributes = node?.attributes || {};
  return attributes.text || attributes.originalText || attributes.description || '';
}
export function visibleBundleNames(layout) {
  return [...new Set(collect(layout, (node) => Boolean(node.attributes?.bundleName)).map((node) => node.attributes.bundleName))];
}
export function buildIdentityNodeId(stamp) {
  return `${BUILD_IDENTITY_NODE_ID_PREFIX}${stamp}`;
}
// A direct-HAP install has no host to vouch for it, so the build stamps itself
// into its own accessibility tree; buildIdentityModule in hap-build.mjs shapes
// the node so a dumpLayout keeps it. Read from `id` or `key` because uitest
// reports a React Native testID on both. Presence in the tree is the whole
// claim; visibility is deliberately not required.
export function observedBuildStamps(layout) {
  const stamped = collect(layout, (node) => {
    const identity = node.attributes?.id || node.attributes?.key;
    return typeof identity === 'string' && identity.startsWith(BUILD_IDENTITY_NODE_ID_PREFIX);
  });
  return [...new Set(stamped
    .map((node) => String(node.attributes.id || node.attributes.key).slice(BUILD_IDENTITY_NODE_ID_PREFIX.length))
    .filter(Boolean))];
}
export function hasBuildIdentity(layout, stamp) {
  return Boolean(stamp) && observedBuildStamps(layout).includes(String(stamp));
}
function hasHarmonyGoBundle(layout, expectedBundleName = harmonyGoBundleName) {
  return visibleBundleNames(layout).includes(expectedBundleName);
}
function currentProjectTitle(layout, manifestId) {
  const identity = harmonyGoActiveMiniAppNodeId(manifestId);
  return collect(layout, (node) => {
    const attributes = node.attributes || {};
    return attributes.type === 'Text' && attributes.visible !== 'false' && attributes.id === identity;
  })[0] || null;
}
function productMarker(layout, markerIds) {
  const wanted = new Set(markerIds.filter(Boolean));
  return collect(layout, (node) => {
    const attributes = node.attributes || {};
    return attributes.visible !== 'false' && (wanted.has(attributes.id) || wanted.has(attributes.key) || wanted.has(attributes.description));
  })[0] || null;
}
function runtimeError(layout) {
  return collect(layout, (node) => {
    const attributes = node.attributes || {};
    if (attributes.visible === 'false') return false;
    const text = nodeText(node);
    return /^(?:Error:|Unhandled (?:JS |JavaScript )?(?:Exception|Error))|RNOH ERROR CONTEXT|Cannot find native module/i.test(text);
  })[0] || null;
}

export function inspectCurrentMiniApp(layout, manifestId, markerIds = [], expectedBundleName = harmonyGoBundleName) {
  const title = currentProjectTitle(layout, manifestId);
  const marker = productMarker(layout, markerIds);
  const crash = runtimeError(layout);
  const errors = [];
  if (!hasHarmonyGoBundle(layout, expectedBundleName)) errors.push(`root bundleName is not ${expectedBundleName}`);
  if (!title) errors.push(`Host active mini-app id is not exactly ${manifestId}`);
  if (!marker) errors.push(`product subtree lacks a run-specific marker (${markerIds.join(', ') || 'none supplied'})`);
  if (crash) errors.push(`visible runtime error overlay: ${nodeText(crash).slice(0, 180)}`);
  return {
    ok: errors.length === 0,
    manifestId,
    currentProjectId: title ? manifestId : '',
    currentProjectTitle: title ? nodeText(title) : '',
    currentProjectBounds: title?.attributes?.bounds || '',
    productMarker: marker?.attributes?.id || marker?.attributes?.key || marker?.attributes?.description || '',
    productMarkerBounds: marker?.attributes?.bounds || '',
    runtimeError: crash ? nodeText(crash) : '',
    errors,
  };
}

export function catalogProjectCard(layout, manifestId) {
  const identity = harmonyGoCatalogMiniAppNodeId(manifestId);
  return collect(layout, (node) => {
    const attributes = node.attributes || {};
    return attributes.visible !== 'false' && attributes.id === identity;
  })[0] || null;
}

export function catalogHasProject(layout, manifestId) {
  return catalogProjectCard(layout, manifestId) !== null;
}

export function catalogVisibleProjectIds(layout) {
  return [...new Set(collect(layout, (node) => {
    const id = node.attributes?.id;
    return node.attributes?.visible !== 'false' && typeof id === 'string' && id.startsWith(HARMONY_GO_CATALOG_MINI_APP_ID_PREFIX);
  }).map((node) => node.attributes.id.slice(HARMONY_GO_CATALOG_MINI_APP_ID_PREFIX.length)).filter(Boolean))];
}

export function catalogFingerprint(layout) {
  return collect(layout, (node) => {
    const id = node.attributes?.id;
    return node.attributes?.visible !== 'false' && typeof id === 'string' && id.startsWith(HARMONY_GO_CATALOG_MINI_APP_ID_PREFIX);
  }).map((node) => `${node.attributes.id}@${node.attributes?.bounds || ''}`).join('|');
}

export function assertCurrentMiniApp(layout, manifestId, markerIds = [], label = 'layout', expectedBundleName = harmonyGoBundleName) {
  const result = inspectCurrentMiniApp(layout, manifestId, markerIds, expectedBundleName);
  if (!result.ok) throw new Error(`${label} does not prove the current mini app: ${result.errors.join('; ')}`);
  return result;
}
