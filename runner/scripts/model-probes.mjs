import { spawnSync } from 'node:child_process';
import { windowFromRejection } from './endpoint-limits.mjs';

// Offline probes. Nothing here may run on a run path: every function below
// spends a network round trip, and several spend tokens.
//
// The rule each probe obeys is that its verdict must rest on a difference we
// can observe in the reply, never on the request being accepted. An endpoint
// that ignores a field answers exactly like one that honors it, so "no error"
// measures nothing. Where no observable difference exists, the probe records
// that it could not tell rather than reporting success.

// Sent through the launcher, which owns the credentials. Response headers come
// back on stderr and the body on stdout, so a rejection is readable rather than
// collapsed into an exit code -- which matters because a rejection is often the
// measurement itself.
export function completion(claudeBin, body, timeoutSeconds = 120) {
  const sent = spawnSync(claudeBin, ['--genius-completion', String(timeoutSeconds)], {
    input: JSON.stringify(body),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (sent.error) return { failed: String(sent.error.message) };
  const status = Number(sent.stderr?.match(/^HTTP\/[\d.]+\s+(\d{3})/m)?.[1]) || 0;
  let json = null;
  try {
    json = JSON.parse(sent.stdout);
  } catch { /* a streamed or truncated body is not an error here */ }
  return { status, json, body: sent.stdout, stderr: sent.stderr };
}

// One repeat measured at exactly 7 tokens: 232,000 of them were counted as
// 1,624,084 by the endpoint itself, in the rejection quoted below. The count
// only has to be the right order of magnitude, because the number we keep comes
// from the endpoint's own message rather than from this estimate.
const filler = 'lorem ipsum dolor sit amet consectetur ';
const tokensPerRepeat = 7;

// A rejected request is not billed, so the probe starts above every window it
// expects to meet and only grows if that was not enough. An accepted rung is
// the expensive case and is reported as such by the caller; it is not wasted,
// because it proves the window is at least that large.
export const windowLadder = [1_600_000, 6_400_000];

// The ladder is a parameter so a test can exercise the escalation without
// pushing tens of megabytes through a pipe for it; the sizes themselves are
// pinned separately. What the tests need to hold is the behaviour -- grow on
// acceptance, announce the cost, stop with a lower bound -- not the volume.
export function probeContextWindow(claudeBin, model, notice = () => {}, ladder = windowLadder) {
  let acceptedTokens = 0;
  for (const [rung, target] of ladder.entries()) {
    const reply = completion(claudeBin, {
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: filler.repeat(Math.ceil(target / tokensPerRepeat)) }],
    }, 600);
    if (reply.failed) return { status: 'unmeasured', evidence: `could not reach the endpoint: ${reply.failed}` };
    const rejection = reply.json?.error?.message;
    if (reply.status >= 400 && rejection) {
      const parsed = windowFromRejection(rejection);
      if (!parsed) return { status: 'unmeasured', evidence: `rejected without naming a window: ${rejection}` };
      return { ...parsed, evidence: rejection };
    }
    if (reply.status !== 200) {
      return { status: 'unmeasured', evidence: `unexpected reply: HTTP ${reply.status} ${reply.body.slice(0, 200)}` };
    }
    acceptedTokens = target;
    const next = ladder[rung + 1];
    notice(`${model}: accepted about ${target.toLocaleString('en-US')} tokens, which is billed.`
      + (next ? ` Growing the probe to ${next.toLocaleString('en-US')}.` : ' No larger probe to try.'));
  }
  return {
    status: 'unmeasured',
    atLeastTokens: acceptedTokens,
    evidence: `accepted about ${acceptedTokens.toLocaleString('en-US')} tokens without rejecting`,
  };
}

// Prompt tokens as the endpoint counted them, summed over the cache buckets. A
// near-repeated body moves the same number out of input_tokens and into
// cache_read_input_tokens, so reading one bucket alone reports a difference
// that is only caching -- and the second request here is a near-repeat of the
// first by construction, so that mistake would fire every time.
function promptTokens(reply) {
  const usage = reply.json?.usage;
  if (!usage) return null;
  const total = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
  return total > 0 ? total : null;
}

function thinkingTokens(reply) {
  const blocks = Array.isArray(reply.json?.content) ? reply.json.content : [];
  const counted = reply.json?.usage?.output_tokens_details?.thinking_tokens;
  return {
    present: blocks.some((block) => block?.type === 'thinking') || Number(counted) > 0,
    counted: Number.isFinite(counted) ? counted : null,
  };
}

// Two small requests that differ in one field, read on both sides.
//
// The reply side decides the verdict: a thinking block, and the thinking_tokens
// the endpoint reports for it. That is the observable difference the rule above
// demands -- a relay that merely hid the block while the model still thought
// would leave the token count behind, and this would catch it.
//
// The request side says how far the field got, which the reply alone cannot
// tell. Measured on this relay, turning thinking off also shrinks the prompt
// the endpoint counts, by a per-model amount that does not vary with the
// message: 68 tokens on k3-256k and 79 on deepseek-v4-flash, over three message
// lengths each. Nothing a relay does to a reply can shorten the prompt it
// billed, so this separates "the model was told not to think" from "the block
// was stripped on the way back". It costs no extra turn -- both numbers come
// out of the two requests already being sent.
export function probeThinking(claudeBin, model) {
  const ask = (extra) => completion(claudeBin, {
    model,
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Name three primary colors.' }],
    ...extra,
  }, 180);
  const absent = ask({});
  const disabled = ask({ thinking: { type: 'disabled' } });
  for (const [name, reply] of [['without the field', absent], ['with thinking disabled', disabled]]) {
    if (reply.failed) return { unmeasured: `could not reach the endpoint ${name}: ${reply.failed}` };
    if (reply.status !== 200) return { unmeasured: `HTTP ${reply.status} ${name}: ${reply.body.slice(0, 200)}` };
  }
  const before = thinkingTokens(absent);
  const after = thinkingTokens(disabled);
  const promptBefore = promptTokens(absent);
  const promptAfter = promptTokens(disabled);
  const seen = (side) => (side.counted === null ? (side.present ? 'a thinking block' : 'none') : `${side.counted} thinking tokens`);
  return {
    // Whether this model can be told to stop thinking at all.
    thinkingDisablable: {
      value: before.present && !after.present,
      confidence: 'exact',
      evidence: `${seen(before)} with no thinking field, ${seen(after)} with thinking disabled`,
    },
    // What the endpoint makes of the field being absent. Claude Code omits it
    // entirely when MAX_THINKING_TOKENS is 0, so this decides whether that has
    // any chance of meaning what it looks like.
    absentThinkingMeansOff: {
      value: !before.present,
      confidence: 'exact',
      evidence: `no thinking field sent, reply carried ${seen(before)}`,
    },
    // Which side the field changed. Kept apart from the verdict because it
    // answers a different question: thinkingDisablable says the thinking went
    // away, this says whether it went away before the model saw the prompt or
    // somewhere on the way back. A false here alongside a true above is the
    // signature of a relay hiding the block rather than an endpoint honoring
    // the field, and that is worth being able to read off the fact table.
    thinkingDisableReachesPrompt: promptBefore === null || promptAfter === null
      ? { status: 'unmeasured', evidence: 'the endpoint reported no prompt tokens, so which side changed cannot be told' }
      : {
        value: promptBefore !== promptAfter,
        confidence: 'exact',
        evidence: `${promptBefore} prompt tokens with no thinking field, ${promptAfter} with thinking disabled`
          + (promptBefore === promptAfter
            ? ' (identical, so only the reply changed)'
            : ` (differs by ${Math.abs(promptBefore - promptAfter)}, so the field changed what the model was sent)`),
      },
  };
}

// A probe stimulus has to be hard enough for the difference it looks for to
// exist. Asked a one-line riddle, low/medium/high/max all land within noise of
// one another, and the honest-looking verdict "no observable difference" is
// simply wrong -- the task never needed more thinking. Deriving a recurrence
// moves the numbers far enough apart to read, which is all this claims:
// whether they then order is a separate question, and not one a fixed level
// order could answer -- see levelOrder below.
//
// So "no difference" has two causes, a dead knob and a weak stimulus, and only
// the second is ours. A probe that cannot tell them apart reports our own
// blind spot as a property of the endpoint, which is the failure this suite
// exists to prevent, pointed the other way.
const effortLevels = ['low', 'medium', 'high', 'max'];

// Variants defeat any caching between levels while keeping the task identical
// in kind, so levels are compared within a variant rather than across runs.
// Each answer was checked by brute force before use (n=12 gives 466 by both
// the recurrence and enumeration), which makes a wrong answer a fact about the
// model rather than about the question.
const effortVariants = [
  { n: 30, answer: '2692538' },
  { n: 34, answer: '18454930' },
  { n: 38, answer: '126491972' },
];
function effortTask(n) {
  return `How many binary strings of length ${n} contain no three consecutive identical characters? `
    + 'Derive the recurrence, then compute the exact integer. End your reply with the answer alone on the final line.';
}

// Not every model reports thinking_tokens -- one of the two configured models
// returns the block without the count -- so the size falls back to the text
// itself, and which one was used travels with the number.
function thinkingSize(reply) {
  const counted = reply.json?.usage?.output_tokens_details?.thinking_tokens;
  if (Number.isFinite(counted)) return { size: counted, unit: 'thinking tokens' };
  const blocks = Array.isArray(reply.json?.content) ? reply.json.content : [];
  const written = blocks.filter((block) => block?.type === 'thinking').map((block) => String(block.thinking || '')).join('');
  return { size: written.length, unit: 'thinking characters' };
}

function answerText(reply) {
  const blocks = Array.isArray(reply.json?.content) ? reply.json.content : [];
  return blocks.filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join('');
}

// Counterbalanced, because a fixed order cannot be told apart from drift. Both
// earlier hand-runs sent low, medium, high, max in that order every time; if the
// endpoint speeds up or slows down over the couple of minutes a variant takes,
// that alone manufactures a monotonic-looking result. One run came out ordered
// in 3 of 3 variants and the next in 0 of 3, which is what a confound looks
// like from the inside. Rotating the order per variant means a drift in either
// direction can no longer produce a consistent ordering.
function levelOrder(index) {
  return effortLevels.map((_, offset) => effortLevels[(offset + index) % effortLevels.length]);
}

export function probeEfforts(claudeBin, model, capSeconds = 300, notice = () => {}) {
  const measured = [];
  for (const [index, variant] of effortVariants.entries()) {
    for (const level of levelOrder(index)) {
      const reply = completion(claudeBin, {
        model,
        max_tokens: 8192,
        output_config: { effort: level },
        messages: [{ role: 'user', content: effortTask(variant.n) }],
      }, capSeconds);
      if (reply.failed) return { status: 'unmeasured', evidence: `could not reach the endpoint: ${reply.failed}` };
      if (reply.status !== 200) {
        measured.push({ n: variant.n, level, rejected: reply.json?.error?.message?.slice(0, 80) || `HTTP ${reply.status}` });
        notice(`${model} ${level} n=${variant.n}: rejected`);
        continue;
      }
      const { size, unit } = thinkingSize(reply);
      const right = answerText(reply).replace(/,/g, '').includes(variant.answer);
      measured.push({ n: variant.n, level, size, unit, right });
      notice(`${model} ${level} n=${variant.n}: ${size} ${unit}${right ? '' : ', wrong answer'}`);
    }
  }

  const rejected = measured.filter((row) => row.rejected);
  const accepted = effortLevels.filter((level) => measured.some((row) => row.level === level && !row.rejected));

  // Judged on low < medium < high only. max is left out of the verdict because
  // it did not hold: in one of three variants it produced less thinking than
  // low. Reporting all four as an ordered scale would overstate what the
  // numbers show.
  const rising = effortVariants.filter((variant) => {
    const at = (level) => measured.find((row) => row.n === variant.n && row.level === level && !row.rejected)?.size;
    const [low, medium, high] = ['low', 'medium', 'high'].map(at);
    return [low, medium, high].every(Number.isFinite) && low < medium && medium < high;
  }).length;

  const unit = measured.find((row) => row.unit)?.unit || 'thinking';
  const order = effortVariants.map((_, index) => levelOrder(index)[0]).join('/');
  const shown = effortLevels
    .map((level) => `${level} ${measured.filter((row) => row.level === level).map((row) => row.rejected ? 'rejected' : row.size).join('/')}`)
    .join(', ');
  return {
    accepted,
    orderedThroughHigh: rising === effortVariants.length,
    variantsRising: `${rising}/${effortVariants.length}`,
    wrongAnswers: measured.filter((row) => row.right === false).length,
    confidence: 'exact',
    evidence: `${unit} over ${effortVariants.length} paired variants, each starting at a different level (${order}): ${shown}`
      + (rejected.length ? `; rejected: ${rejected.map((row) => `${row.level} (${row.rejected})`).join(', ')}` : ''),
  };
}
