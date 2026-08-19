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
function bounds(node) {
  const match = String(node?.attributes?.bounds || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  return match ? { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) } : null;
}
export function visibleBundleNames(layout) {
  return [...new Set(collect(layout, (node) => Boolean(node.attributes?.bundleName)).map((node) => node.attributes.bundleName))];
}
function hasHarmonyGoBundle(layout) {
  return visibleBundleNames(layout).includes('com.example.myapplication1.ide');
}
function currentProjectTitle(layout, manifestId) {
  const candidates = collect(layout, (node) => {
    const box = bounds(node);
    const attributes = node.attributes || {};
    return attributes.type === 'Text' && attributes.visible !== 'false' && nodeText(node) === manifestId && box;
  });
  const projectsTab = collect(layout, (node) => node.attributes?.type === 'Button' && nodeText(node) === '项目')[0];
  const projectsBounds = bounds(projectsTab);
  if (projectsBounds) {
    return candidates.filter((node) => bounds(node).bottom <= projectsBounds.top).sort((a, b) => bounds(a).top - bounds(b).top)[0] || null;
  }
  const nodes = collect(layout, () => true);
  const navigationIndex = nodes.indexOf(projectsTab);
  return candidates.find((node) => navigationIndex === -1 || nodes.indexOf(node) < navigationIndex) || null;
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

export function inspectCurrentMiniApp(layout, manifestId, markerIds = []) {
  const title = currentProjectTitle(layout, manifestId);
  const marker = productMarker(layout, markerIds);
  const crash = runtimeError(layout);
  const errors = [];
  if (!hasHarmonyGoBundle(layout)) errors.push('root bundleName is not com.example.myapplication1.ide');
  if (!title) errors.push(`Host current-project title is not exactly ${manifestId}`);
  if (!marker) errors.push(`product subtree lacks a run-specific marker (${markerIds.join(', ') || 'none supplied'})`);
  if (crash) errors.push(`visible runtime error overlay: ${nodeText(crash).slice(0, 180)}`);
  return {
    ok: errors.length === 0,
    manifestId,
    currentProjectTitle: title ? nodeText(title) : '',
    currentProjectBounds: title?.attributes?.bounds || '',
    productMarker: marker?.attributes?.id || marker?.attributes?.key || marker?.attributes?.description || '',
    productMarkerBounds: marker?.attributes?.bounds || '',
    runtimeError: crash ? nodeText(crash) : '',
    errors,
  };
}

export function assertCurrentMiniApp(layout, manifestId, markerIds = [], label = 'layout') {
  const result = inspectCurrentMiniApp(layout, manifestId, markerIds);
  if (!result.ok) throw new Error(`${label} does not prove the current mini app: ${result.errors.join('; ')}`);
  return result;
}
