import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { probeEfforts } from './model-probes.mjs';
import { assertModelsServed, recordModelFacts } from './preflight-models.mjs';

// Whether this endpoint's effort levels form an ordered scale, and where the
// order stops holding. Separate from --refresh-models for the same reason the
// timing probe is: measuring this properly needs a task hard enough to make the
// levels differ, and a hard task is not cheap. Twelve turns per model, several
// of them minutes long.
//
// It is worth the cost once per model because the alternative is the failure
// this repository already shipped: a configured value that nothing checks and
// nobody can tell apart from a value that does nothing.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const claude = process.env.CLAUDE_BIN || join(root, '.local/claude-isolated');

export function parseArguments(argv) {
  const options = { models: [], capSeconds: 300 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--model') { options.models.push(value); index += 1; }
    else if (flag === '--cap-seconds') { options.capSeconds = Number(value); index += 1; }
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.models.length) {
    throw new Error(
      'name the models to measure, one --model at a time.\n'
      + '  This probe spends twelve real turns per model, so it never picks for you:\n'
      + '    node scripts/probe-effort-scale.mjs --model <name> [--cap-seconds 300]',
    );
  }
  if (!Number.isFinite(options.capSeconds) || options.capSeconds < 1) throw new Error('--cap-seconds must be seconds');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertModelsServed(options.models);
  for (const model of options.models) {
    const measured = probeEfforts(claude, model, options.capSeconds, (line) => console.log(`  ${line}`));
    recordModelFacts(model, { efforts: measured });
    if (measured.status === 'unmeasured') {
      console.log(`${model}: unmeasured · ${measured.evidence}`);
      continue;
    }
    console.log(`${model}: accepts ${measured.accepted.join(', ')}`);
    console.log(`  low < medium < high in ${measured.variantsRising} variants`
      + `${measured.orderedThroughHigh ? '' : ' — not an ordered scale here'}`);
    console.log(`  ${measured.evidence}`);
  }
  console.log('\nRecorded in .local/models-cache.json. The verdict covers low through high; max was measured but is not claimed to be ordered.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
