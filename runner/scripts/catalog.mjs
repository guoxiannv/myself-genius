import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const project = resolve(process.argv[2] || '.');
const script = resolve('skills/expo-harmony-fast/scripts/fast-harmony.mjs');
const result = spawnSync(process.execPath, [script, 'catalog', project], { stdio: 'inherit' });
process.exitCode = result.status || 0;
