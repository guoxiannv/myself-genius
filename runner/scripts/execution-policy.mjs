import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const effortLevels = new Set(['low', 'medium', 'high', 'max']);

export const executionDefaults = Object.freeze(
  JSON.parse(readFileSync(join(root, 'config/execution.json'), 'utf8')),
);

export function resolveExecution(options = {}) {
  const model = options.model || executionDefaults.model;
  const effort = options.effort || executionDefaults.effort;
  const repairModel = options.repairModel || options.model || executionDefaults.repairModel || model;
  const repairEffort = options.repairEffort || options.effort || executionDefaults.repairEffort || effort;
  if (!model || !repairModel) throw new Error('main and repair models must be configured');
  for (const [label, value] of [['effort', effort], ['repair effort', repairEffort]]) {
    if (!effortLevels.has(value)) throw new Error(`${label} must be low, medium, high, or max`);
  }
  return { model, effort, repairModel, repairEffort };
}
