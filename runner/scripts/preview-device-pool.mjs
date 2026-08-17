import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_POOL_ROOT = '/private/tmp/genius-expo-preview-pool';
const DEFAULT_LEASE_SECONDS = 90;
const DEFAULT_QUARANTINE_SECONDS = 60;
const DEFAULT_WAIT_SECONDS = 3600;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function safeTarget(target) {
  return String(target || '').replace(/[^A-Za-z0-9._-]+/g, '_');
}

function uniqueTargets(targets) {
  return [...new Set((targets || []).map((target) => String(target || '').trim()).filter(Boolean))];
}

function ensurePoolLayout(root) {
  mkdirSync(join(root, 'queue'), { recursive: true });
  mkdirSync(join(root, 'leases'), { recursive: true });
  mkdirSync(join(root, 'quarantine'), { recursive: true });
}

async function withAllocatorLock(root, action) {
  const lock = join(root, '.allocator-lock');
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true });
      } catch {}
      if (Date.now() >= deadline) throw new Error(`timed out waiting for preview allocator lock: ${lock}`);
      await sleep(100);
    }
  }
  try { return await action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function leasePath(root, target) {
  return join(root, 'leases', `${safeTarget(target)}.json`);
}

function quarantinePath(root, target) {
  return join(root, 'quarantine', `${safeTarget(target)}.json`);
}

function validLease(path, now = Date.now()) {
  const lease = readJson(path);
  if (!lease) return null;
  const expiresAt = Date.parse(String(lease.expires_at || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= now || !processAlive(Number(lease.pid))) return null;
  return lease;
}

function validQuarantine(path, now = Date.now()) {
  const quarantine = readJson(path);
  if (!quarantine) return null;
  const expiresAt = Date.parse(String(quarantine.expires_at || ''));
  return Number.isFinite(expiresAt) && expiresAt > now ? quarantine : null;
}

function cleanupStale(root) {
  const leasesRoot = join(root, 'leases');
  for (const name of readdirSync(leasesRoot)) {
    const path = join(leasesRoot, name);
    if (!validLease(path)) rmSync(path, { force: true });
  }
  const quarantineRoot = join(root, 'quarantine');
  for (const name of readdirSync(quarantineRoot)) {
    const path = join(quarantineRoot, name);
    if (!validQuarantine(path)) rmSync(path, { force: true });
  }
  const queueRoot = join(root, 'queue');
  for (const name of readdirSync(queueRoot)) {
    const path = join(queueRoot, name);
    const ticket = readJson(path);
    if (!ticket || !processAlive(Number(ticket.pid))) rmSync(path, { force: true });
  }
}

function queueNames(root, kind) {
  return readdirSync(join(root, 'queue'))
    .filter((name) => name.endsWith('.json'))
    .filter((name) => {
      const ticket = readJson(join(root, 'queue', name));
      return ticket?.kind === kind && ticket?.priority !== 'live';
    })
    .sort();
}

function chooseFree(root, candidates) {
  return candidates.find((target) =>
    !validLease(leasePath(root, target)) && !validQuarantine(quarantinePath(root, target))
  ) || '';
}

function createLeaseRecord({ leaseId, runId, target, kind, leaseSeconds }) {
  const now = new Date();
  return {
    schema_version: 1,
    lease_id: leaseId,
    run_id: runId,
    pid: process.pid,
    target,
    kind,
    leased_at: now.toISOString(),
    heartbeat_at: now.toISOString(),
    expires_at: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
  };
}

export function configuredPreviewPools(env = process.env) {
  const list = (value) => uniqueTargets(String(value || '').split(/[\s,]+/));
  const desktops = list(env.EXPO_FAST_HDC_DESKTOP_TARGETS || env.HP_HDC_DESKTOP_TARGETS);
  const phones = list(env.EXPO_FAST_HDC_PHONE_TARGETS || env.HP_HDC_PHONE_TARGETS);
  const desktopFallback = String(env.EXPO_FAST_HDC_DESKTOP_TARGET || env.HP_HDC_DESKTOP_TARGET || '').trim();
  const phoneFallback = String(env.EXPO_FAST_HDC_PHONE_TARGET || env.HP_HDC_PHONE_TARGET || '').trim();
  return {
    desktop: desktops.length ? desktops : uniqueTargets([desktopFallback]),
    phone: phones.length ? phones : uniqueTargets([phoneFallback]),
  };
}

export async function acquirePreviewDevice({
  runId,
  kind,
  availableTargets,
  root = process.env.EXPO_FAST_DEVICE_POOL_ROOT || DEFAULT_POOL_ROOT,
  waitSeconds = Number(process.env.EXPO_FAST_PREVIEW_WAIT_SECONDS || DEFAULT_WAIT_SECONDS),
  leaseSeconds = Number(process.env.EXPO_FAST_PREVIEW_LEASE_SECONDS || DEFAULT_LEASE_SECONDS),
  quarantineSeconds = Number(process.env.EXPO_FAST_PREVIEW_QUARANTINE_SECONDS || DEFAULT_QUARANTINE_SECONDS),
  onWait = () => {},
}) {
  if (!['desktop', 'phone'].includes(kind)) throw new Error(`invalid preview device kind: ${kind}`);
  if (typeof availableTargets !== 'function') throw new Error('availableTargets must be a function');
  const resolvedRoot = resolve(root);
  ensurePoolLayout(resolvedRoot);
  const safeRunId = String(runId || randomUUID()).replace(/[^A-Za-z0-9._-]+/g, '-');
  const ticketName = `${String(Date.now()).padStart(16, '0')}-${String(process.pid).padStart(10, '0')}-${safeRunId}-${randomUUID()}.json`;
  const ticketPath = join(resolvedRoot, 'queue', ticketName);
  writeJsonAtomic(ticketPath, {
    schema_version: 1,
    run_id: runId,
    pid: process.pid,
    kind,
    queued_at: new Date().toISOString(),
  });
  const deadline = Date.now() + Math.max(1, waitSeconds) * 1000;
  let announced = false;
  try {
    while (Date.now() < deadline) {
      const allocation = await withAllocatorLock(resolvedRoot, async () => {
        cleanupStale(resolvedRoot);
        if (queueNames(resolvedRoot, kind)[0] !== ticketName) return null;
        const target = chooseFree(resolvedRoot, uniqueTargets(await availableTargets(kind)));
        if (!target) return null;
        const leaseId = randomUUID();
        const records = [createLeaseRecord({ leaseId, runId, target, kind, leaseSeconds })];
        writeJsonAtomic(leasePath(resolvedRoot, target), records[0]);
        rmSync(ticketPath, { force: true });
        return { leaseId, kind, target, targets: { [kind]: target }, records };
      });
      if (allocation) {
        let released = false;
        const heartbeat = setInterval(() => {
          if (released) return;
          void withAllocatorLock(resolvedRoot, async () => {
            if (released) return;
            const now = new Date();
            for (const record of allocation.records) {
              const path = leasePath(resolvedRoot, record.target);
              const current = readJson(path);
              if (current?.lease_id !== allocation.leaseId) continue;
              writeJsonAtomic(path, {
                ...current,
                heartbeat_at: now.toISOString(),
                expires_at: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
              });
            }
          }).catch(() => {});
        }, Math.max(1000, Math.floor(leaseSeconds * 1000 / 3)));
        heartbeat.unref();
        return {
          ...allocation,
          root: resolvedRoot,
          async quarantine(target, reason = '') {
            await withAllocatorLock(resolvedRoot, async () => {
              const record = allocation.records.find((entry) => entry.target === target);
              if (!record) return;
              const path = leasePath(resolvedRoot, target);
              if (readJson(path)?.lease_id === allocation.leaseId) rmSync(path, { force: true });
              const now = new Date();
              writeJsonAtomic(quarantinePath(resolvedRoot, target), {
                schema_version: 1,
                target,
                kind: record.kind,
                run_id: runId,
                reason: String(reason).slice(0, 1000),
                quarantined_at: now.toISOString(),
                expires_at: new Date(now.getTime() + Math.max(1, quarantineSeconds) * 1000).toISOString(),
              });
              allocation.records = allocation.records.filter((entry) => entry.target !== target);
              allocation.target = '';
              delete allocation.targets[record.kind];
            });
          },
          async release() {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            await withAllocatorLock(resolvedRoot, async () => {
              for (const record of allocation.records) {
                const path = leasePath(resolvedRoot, record.target);
                if (readJson(path)?.lease_id === allocation.leaseId) rmSync(path, { force: true });
              }
            });
          },
        };
      }
      if (!announced) {
        announced = true;
        onWait({ status: 'queued', kind, queuedAt: new Date().toISOString() });
      }
      await sleep(1000);
    }
    throw new Error(`timed out after ${waitSeconds}s waiting for one ${kind} preview device`);
  } finally {
    if (existsSync(ticketPath)) rmSync(ticketPath, { force: true });
  }
}

export async function acquirePreviewDevices({ pools, connectedTargets, ...options }) {
  const requestedKinds = ['desktop', 'phone'].filter((kind) => uniqueTargets(pools?.[kind]).length);
  if (!requestedKinds.length) throw new Error('preview pools require at least one device');
  const leases = [];
  try {
    for (const kind of requestedKinds) {
      const candidates = uniqueTargets(pools[kind]);
      const lease = await acquirePreviewDevice({
        ...options,
        kind,
        availableTargets: async () => {
          const connected = new Set(uniqueTargets(await connectedTargets()));
          return candidates.filter((target) => connected.has(target));
        },
      });
      leases.push(lease);
    }
    const records = leases.flatMap((lease) => lease.records);
    const targets = Object.assign({ desktop: '', phone: '' }, ...leases.map((lease) => lease.targets));
    return {
      leaseId: leases.map((lease) => lease.leaseId).join(','),
      records,
      targets,
      async quarantine(target, reason = '') {
        const lease = leases.find((entry) => entry.target === target);
        if (lease) await lease.quarantine(target, reason);
      },
      async release() {
        await Promise.all(leases.map((lease) => lease.release()));
      },
    };
  } catch (error) {
    await Promise.all(leases.map((lease) => lease.release()));
    throw error;
  }
}
