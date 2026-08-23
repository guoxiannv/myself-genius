import { spawnSync } from 'node:child_process';

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

// Both forms below were observed on the configured endpoint:
//
//   deepseek-v4-flash  400  This model's maximum context length is 1048576
//                           tokens. However, you requested 1624100 tokens
//                           (1624084 in the messages, 16 in the completion)
//   k3-256k            401  k3-256k supports only 256K context
//
// They are not equally precise, and the difference matters more than it looks.
// The first states the limit; the second states a magnitude, and "256K" does
// not say whether K is 1000 or 1024. Reading it as 256000 is exactly the value
// this repository shipped and exactly the value that was wrong, so a derived
// number is labelled as derived rather than quietly promoted. Anything neither
// pattern matches is recorded as unmeasured: guessing here would reproduce the
// failure the probes exist to prevent.
export function windowFromRejection(message) {
  const exact = message.match(/maximum context length is (\d+)/i);
  if (exact) return { value: Number(exact[1]), confidence: 'exact' };
  const magnitude = message.match(/(\d+)\s*K\b[^.]*context/i);
  if (magnitude) return { value: Number(magnitude[1]) * 1024, confidence: 'derived' };
  return null;
}

// A rejected request is not billed, so the probe starts above every window it
// expects to meet and only grows if that was not enough. An accepted rung is
// the expensive case and is reported as such by the caller; it is not wasted,
// because it proves the window is at least that large.
const windowLadder = [1_600_000, 6_400_000];

export function probeContextWindow(claudeBin, model, notice = () => {}) {
  let acceptedTokens = 0;
  for (const [rung, target] of windowLadder.entries()) {
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
    const next = windowLadder[rung + 1];
    notice(`${model}: accepted about ${target.toLocaleString('en-US')} tokens, which is billed.`
      + (next ? ` Growing the probe to ${next.toLocaleString('en-US')}.` : ' No larger probe to try.'));
  }
  return {
    status: 'unmeasured',
    atLeastTokens: acceptedTokens,
    evidence: `accepted about ${acceptedTokens.toLocaleString('en-US')} tokens without rejecting`,
  };
}

// Two small requests that differ in one field. The verdict rests on the reply:
// a thinking block, and the thinking_tokens the endpoint reports for it. That
// is the observable difference the rule above demands -- a relay that merely
// hid the block while the model still thought would leave the token count
// behind, and this would catch it.
function thinkingTokens(reply) {
  const blocks = Array.isArray(reply.json?.content) ? reply.json.content : [];
  const counted = reply.json?.usage?.output_tokens_details?.thinking_tokens;
  return {
    present: blocks.some((block) => block?.type === 'thinking') || Number(counted) > 0,
    counted: Number.isFinite(counted) ? counted : null,
  };
}

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
  };
}
