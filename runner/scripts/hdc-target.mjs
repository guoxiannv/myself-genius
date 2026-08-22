import { spawnSync } from 'node:child_process';

const HDC_TEXT_FAILURE = /\[Fail\]|(?:^|\n)\s*error:\s*failed\b|failed to start ability|invalid bundle name/i;

export function hdcOutputFailed(output) {
  return HDC_TEXT_FAILURE.test(String(output || ''));
}

// hdc exits 0 even when a command failed, so hdcOutputFailed classifies by text.
// That makes "the bundle is not installed" indistinguishable from a real fault,
// yet it is the normal state before a first install: there is no process to stop
// and nothing to uninstall. Recognise each command's own absence signature so it
// can be allowed through without also allowing the failures that matter -- a
// process that survives `install -r` and gets photographed as the new build, or
// persisted data from the previous build that the new one silently inherits.
const HDC_FORCE_STOP_BUNDLE_ABSENT = /\b10104002\b|package name is not installed/i;
const HDC_UNINSTALL_BUNDLE_ABSENT = /\b9568386\b|uninstall missing installed bundle/i;

export function hdcForceStopBundleAbsent(output) {
  return HDC_FORCE_STOP_BUNDLE_ABSENT.test(String(output || ''));
}

export function hdcUninstallBundleAbsent(output) {
  return HDC_UNINSTALL_BUNDLE_ABSENT.test(String(output || ''));
}

// hdc has no built-in timeout, and a device channel that stops responding does
// not fail: anything needing the device daemon (shell, install, file, fport,
// rport) blocks forever while `list targets` keeps reporting Connected. Bound
// every call so a dead channel surfaces as an error instead of a silent hang.
export const HDC_PROBE_TIMEOUT_MS = 5_000;
export const HDC_SESSION_TIMEOUT_MS = 15_000;
export const HDC_DEVICE_TIMEOUT_MS = 120_000;
export const HDC_TRANSFER_TIMEOUT_MS = 600_000;

const HDC_SESSION_COMMANDS = new Set(['list', 'checkserver', 'tconn', 'version']);
const HDC_TRANSFER_COMMANDS = new Set(['install', 'uninstall', 'file']);

function hdcCommandWord(args) {
  const values = (args || []).map((value) => String(value ?? ''));
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '-t' || value === '-s') { index += 1; continue; }
    if (value.startsWith('-')) continue;
    return value;
  }
  return '';
}

export function hdcCommandTarget(args) {
  const values = (args || []).map((value) => String(value ?? ''));
  const index = values.indexOf('-t');
  return index >= 0 && index + 1 < values.length ? values[index + 1] : '';
}

// Session commands are answered by the hdc server and stay responsive even when
// the device is gone; everything else needs the device daemon and is what hangs.
export function hdcCommandKind(args) {
  const command = hdcCommandWord(args);
  if (HDC_TRANSFER_COMMANDS.has(command)) return 'transfer';
  if (HDC_SESSION_COMMANDS.has(command)) return 'session';
  return 'device';
}

export function hdcCommandTimeoutMs(args) {
  const kind = hdcCommandKind(args);
  if (kind === 'transfer') return HDC_TRANSFER_TIMEOUT_MS;
  if (kind === 'session') return HDC_SESSION_TIMEOUT_MS;
  return HDC_DEVICE_TIMEOUT_MS;
}

export function hdcTimeoutMessage(args, timeoutMs) {
  const command = `hdc ${(args || []).join(' ')}`;
  const seconds = Math.round(Number(timeoutMs) / 1000);
  if (hdcCommandKind(args) === 'session') {
    return `${command} timed out after ${seconds}s; the hdc server is not responding. Restart it with: hdc kill -r`;
  }
  const target = hdcCommandTarget(args) || '<target>';
  return (
    `${command} timed out after ${seconds}s; the device channel is not responding. ` +
    '"hdc list targets" keeps reporting the device as Connected in this state. ' +
    `Recover with: hdc tconn ${target} -remove && hdc tconn ${target}`
  );
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
    const result = spawnSync(hdc, ['-t', target, 'shell', 'param', 'get', 'const.product.devicetype'], { encoding: 'utf8', timeout: HDC_PROBE_TIMEOUT_MS });
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
