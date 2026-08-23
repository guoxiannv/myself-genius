import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesignPrompt, readDesignTrace, designTurnInvocation } from './run-livetest.mjs';
import { resolveRole } from './execution-policy.mjs';
import { assertModelsServed, recordModelFacts } from './preflight-models.mjs';

// How long a reference turn takes, measured the only way it can be: by running
// it. Deliberately separate from --refresh-models, which is called by
// setup-harmony-pool.sh and must stay cheap -- this is the one probe that
// spends real turns, so it is asked for explicitly and names its models
// explicitly. There is no "probe everything" switch on purpose.
//
// What it produces is a pair per sample, duration and bytes, not a single
// duration. #139 showed why: a design turn's length is dominated by how much
// document the request calls for, and that is a property of the request rather
// than of the model. One number would look like a property of the model and
// would be wrong the first time a heavier request arrived. The pair lets a
// reader separate what the model costs to start from what each byte costs, and
// the reference is recorded beside it so nobody mistakes the figure for a
// verdict about every request.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const claude = process.env.CLAUDE_BIN || join(root, '.local/claude-isolated');

export function parseArguments(argv) {
  const options = { models: [], samples: 3, capSeconds: 300, request: 'prompts/ledger.md' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--model') { options.models.push(value); index += 1; }
    else if (flag === '--samples') { options.samples = Number(value); index += 1; }
    else if (flag === '--cap-seconds') { options.capSeconds = Number(value); index += 1; }
    else if (flag === '--request') { options.request = value; index += 1; }
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.models.length) {
    throw new Error(
      'name the models to time, one --model at a time.\n'
      + '  This probe spends real turns, so it never picks for you:\n'
      + '    node scripts/probe-turn-timing.mjs --model <name> [--model <name>] [--samples 3]',
    );
  }
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error('--samples must be a whole number of runs');
  if (!Number.isFinite(options.capSeconds) || options.capSeconds < 1) throw new Error('--cap-seconds must be seconds');
  return options;
}

// The turn runs without the production deadline. Enforcing 45s here would only
// ever record 45s, which is the number we are trying to decide rather than the
// one we can measure. The cap exists to stop a hang, not to shape the result,
// and a sample that hits it is reported as capped rather than counted.
async function timeOneTurn(role, prompt, capSeconds) {
  const { args, env } = designTurnInvocation(role, prompt);
  const started = Date.now();
  let trace = '';
  const outcome = await new Promise((settle) => {
    const child = spawn(claude, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let capped = false;
    let killTimer;
    const timer = setTimeout(() => { capped = true; child.kill('SIGINT'); killTimer = setTimeout(() => child.kill('SIGKILL'), 750); }, capSeconds * 1000);
    child.stdout.on('data', (chunk) => { trace += chunk; });
    child.stderr.on('data', (chunk) => { trace += chunk; });
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(killTimer); settle({ capped, failed: String(error.message) }); });
    child.on('exit', (code) => { clearTimeout(timer); clearTimeout(killTimer); settle({ capped, exitCode: code }); });
  });
  const { html, usable } = readDesignTrace(trace);
  return { ms: Date.now() - started, bytes: html.length, complete: usable, capped: outcome.capped, exitCode: outcome.exitCode ?? null };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const requestPath = isAbsolute(options.request) ? options.request : join(root, options.request);
  if (!existsSync(requestPath)) throw new Error(`no such request file: ${requestPath}`);
  const request = readFileSync(requestPath, 'utf8').trim();
  const prompt = buildDesignPrompt(request);
  const reference = options.request.replace(/^.*\//, '').replace(/\.md$/, '');

  assertModelsServed(options.models);

  for (const model of options.models) {
    // The role is the design role with this model substituted, so the turn is
    // shaped exactly like the one in production. Its context window still comes
    // from configuration rather than from the model, which is the split this
    // work has not reached yet; here it only moves auto-compaction, and a
    // single turn never reaches it.
    const role = resolveRole('design', { model });
    const samples = [];
    for (let run = 1; run <= options.samples; run += 1) {
      const sample = await timeOneTurn(role, prompt, options.capSeconds);
      samples.push(sample);
      const shape = sample.complete ? `${sample.bytes}B complete` : sample.capped ? 'capped' : `${sample.bytes}B incomplete`;
      console.log(`${model} ${run}/${options.samples}  ${(sample.ms / 1000).toFixed(1)}s  ${shape}`);
    }
    const completed = samples.filter((sample) => sample.complete);
    recordModelFacts(model, {
      referenceTurn: {
        reference,
        samples: samples.map(({ ms, bytes, complete, capped }) => ({ ms, bytes, complete, capped })),
        // The maximum observed, with the sample count beside it. Not a
        // percentile: these are single-digit sample sizes and a p95 drawn from
        // them would read as precision that is not there.
        observedMaxMs: Math.max(...samples.map((sample) => sample.ms)),
        completedOf: `${completed.length}/${samples.length}`,
        confidence: 'reference-request-only',
        evidence: `${reference}: ${samples.map((sample) => `${(sample.ms / 1000).toFixed(1)}s/${sample.bytes}B${sample.complete ? '' : sample.capped ? ' capped' : ' incomplete'}`).join(', ')}`,
      },
    });
    console.log(`${model}: max ${(Math.max(...samples.map((sample) => sample.ms)) / 1000).toFixed(1)}s over ${samples.length} samples, ${completed.length} complete`);
  }
  console.log('\nRecorded in .local/models-cache.json. These figures describe this reference request only.');
}

// Guarded so the module can be imported for its argument handling without
// spending a turn, the same way run-livetest.mjs guards its own entry point.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
