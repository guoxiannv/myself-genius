import { spawnSync } from 'node:child_process';

const HDC_TEXT_FAILURE = /\[Fail\]|(?:^|\n)\s*error:\s*failed\b|failed to start ability|invalid bundle name/i;

export function hdcOutputFailed(output) {
  return HDC_TEXT_FAILURE.test(String(output || ''));
}

export function parseHdcTargets(output) {
  return String(output || '')
    .split(/\r?\n|\s+/)
    .map((target) => target.trim())
    .filter((target) => target && target !== '[Empty]');
}

export function parseHdcForwardRules(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\S+)\s+tcp:(\d+)\s+tcp:(\d+)\s+\[(Forward|Reverse)\]$/);
      return match ? {
        target: match[1],
        devicePort: Number(match[2]),
        hostPort: Number(match[3]),
        direction: match[4].toLowerCase(),
      } : null;
    })
    .filter(Boolean);
}

export function assignHdcPreviewPorts(pools, basePort = 3333) {
  const targets = [...new Set([
    ...(pools.desktop || []),
    ...(pools.phone || []),
  ].map((target) => String(target || '').trim()).filter(Boolean))];
  const firstPort = Number(basePort);
  if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort + targets.length - 1 > 65535) {
    throw new Error(`invalid Harmony Go device port base: ${basePort}`);
  }
  return Object.fromEntries(targets.map((target, index) => [target, firstPort + index]));
}

export function reversePortCandidates(preferredPort, count = 8) {
  const firstPort = Number(preferredPort);
  const candidateCount = Number(count);
  if (
    !Number.isInteger(firstPort) || firstPort < 1024 ||
    !Number.isInteger(candidateCount) || candidateCount < 1 ||
    firstPort + candidateCount - 1 > 65535
  ) {
    throw new Error(`invalid Harmony Go reverse port range: ${preferredPort} + ${count}`);
  }
  return Array.from({ length: candidateCount }, (_value, index) => firstPort + index);
}

export function discoverHdcPreviewPools(hdc, targets) {
  const pools = { desktop: [], phone: [] };
  for (const target of [...new Set(targets.map((value) => String(value || '').trim()).filter(Boolean))]) {
    const result = spawnSync(hdc, ['-t', target, 'shell', 'param', 'get', 'const.product.devicetype'], { encoding: 'utf8', timeout: 5000 });
    const deviceType = `${result.stdout || ''} ${result.stderr || ''}`.trim().toLowerCase();
    if (/phone|mobile/.test(deviceType)) pools.phone.push(target);
    else if (/2in1|tablet|pc|desktop/.test(deviceType)) pools.desktop.push(target);
  }
  return pools;
}

export function prioritizeHdcPreviewTargets(discoveredTargets, preferredTargets = []) {
  const discovered = [...new Set((discoveredTargets || [])
    .map((target) => String(target || '').trim())
    .filter(Boolean))];
  const connected = new Set(discovered);
  const preferred = [...new Set((preferredTargets || [])
    .map((target) => String(target || '').trim())
    .filter((target) => target && connected.has(target)))];
  const preferredSet = new Set(preferred);
  return [...preferred, ...discovered.filter((target) => !preferredSet.has(target))];
}

export function configuredHdcTarget(env = process.env) {
  return [env.EXPO_FAST_HDC_TARGET, env.HDC_TARGET, env.HP_HDC_TARGET]
    .map((target) => String(target || '').trim())
    .find(Boolean) || '';
}

export function configuredHdcPreviewTargets(env = process.env) {
  return Object.fromEntries([
    ['desktop', env.EXPO_FAST_HDC_DESKTOP_TARGET || env.HP_HDC_DESKTOP_TARGET],
    ['phone', env.EXPO_FAST_HDC_PHONE_TARGET || env.HP_HDC_PHONE_TARGET],
  ].map(([kind, target]) => [kind, String(target || '').trim()]).filter(([, target]) => target));
}

export function selectHdcTarget(targets, requestedTarget = '') {
  const connected = [...new Set(targets.map((target) => String(target || '').trim()).filter(Boolean))];
  const requested = String(requestedTarget || '').trim();

  if (!connected.length) throw new Error('no Harmony target; start the DevEco emulator first');
  if (requested) {
    if (!connected.includes(requested)) {
      throw new Error(`configured Harmony target ${requested} is not connected; connected targets: ${connected.join(', ')}`);
    }
    return requested;
  }
  if (connected.length > 1) {
    throw new Error(`multiple Harmony targets connected (${connected.join(', ')}); set EXPO_FAST_HDC_TARGET, HDC_TARGET, or HP_HDC_TARGET`);
  }
  return connected[0];
}

export function selectHdcPreviewTargets(targets, requestedTargets = {}, primaryTarget = '') {
  const selected = {};
  for (const [kind, requested] of Object.entries(requestedTargets)) {
    if (!['desktop', 'phone'].includes(kind) || !String(requested || '').trim()) continue;
    selected[kind] = selectHdcTarget(targets, requested);
  }
  if (!Object.keys(selected).length) {
    selected.desktop = selectHdcTarget(targets, primaryTarget);
  }
  if (new Set(Object.values(selected)).size !== Object.keys(selected).length) {
    throw new Error('desktop and phone previews must use different Harmony targets');
  }
  return selected;
}
