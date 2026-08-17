#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  installAndOpen,
  prepareHarmonyGoTarget,
  verifyHarmonyGoForeground,
} from './run-livetest.mjs';

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    options[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const project = resolve(options.project || '');
  const target = String(options.target || '').trim();
  const gateway = new URL(options.gatewayOrigin || 'http://127.0.0.1:3353');
  const devicePort = Number(options.devicePort || 3333);
  if (!target) throw new Error('desktop preview target is required');
  if (gateway.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(gateway.hostname)) {
    throw new Error(`desktop preview gateway must be loopback HTTP: ${gateway}`);
  }
  if (!Number.isSafeInteger(devicePort) || devicePort < 1 || devicePort > 65535) {
    throw new Error(`invalid desktop preview device port: ${devicePort}`);
  }

  const manifest = JSON.parse(readFileSync(join(project, '.expo-fast/manifest.json'), 'utf8'));
  const activeDevicePort = prepareHarmonyGoTarget(
    'desktop',
    target,
    devicePort,
    Number(gateway.port || 80),
  );
  await verifyHarmonyGoForeground(project, 'desktop', target);
  const result = await installAndOpen(
    project,
    target,
    manifest.id,
    'desktop-live',
    activeDevicePort,
    { replaceInstalled: options.reuseInstalled !== 'true' },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
