// Whether the endpoint let a turn start, and how to say so when it did not.
//
// There is no waiting here, and no retry. That is the decision this file exists
// to record, because the obvious design was the wrong one.
//
// The endpoint answers "may this turn start" for free, in milliseconds, at the
// moment of launch: `403 You've reached your concurrent request limit` arrives
// before any generation, costs no tokens, and leaves no half-written state. It
// is tempting to read that as "wait and launch again", and #139 first proposed
// exactly that. The reason it is not implemented: from inside this process we
// cannot tell the two causes apart.
//
//   - The slot we collided with is our own. The design turn's deadline kills the
//     local client, but the relay keeps generating and keeps the slot, so the
//     next launch meets it. That wait is bounded by something measured -- a
//     design document finishes in 27-81s across the models in use.
//   - Somebody else is holding the capacity, or the channel is in the several
//     minutes of 503 that follow a concurrency event. That wait is bounded by
//     nothing we can observe.
//
// The refusal is identical in both cases. So any wait we chose would be a number
// with no stated basis, and the failure it papered over is one worth seeing:
// waiting rewrites "the upstream is out of capacity" into "this run was a bit
// slow", which is the disguise #139 rules out in the first place. Reporting it
// exactly, on the first refusal, is the honest answer -- and it is never worse
// than the behaviour it replaces, where the same refusal ended the run as
// `claude exited 1`.
//
// What is left is reading the refusal correctly, and two guards decide that:
//
//   1. A refusal only means "never started" while nothing was generated. Any
//      assistant content -- text, thinking, a tool call, non-zero output_tokens
//      -- means the turn ran and then failed, which is a different diagnosis and
//      is reported as one.
//   2. Only the shapes measured on this endpoint are recognized as refusals.
//      Quota exhaustion, authentication failures, and every other 403/429/503
//      are reported as themselves. Recognizing too little costs nothing;
//      recognizing too much would put the wrong name on a real fault.

// The two shapes, both quoted from captures against the configured relay.
//
// The 403 is the admission answer itself, as Claude Code relayed it into
// pomodoro-03 and pomodoro-05:
//
//   Failed to authenticate. API Error: 403 You've reached your concurrent
//   request limit. Please wait for your ongoing requests to finish and try
//   again. (request id: 202608221128235306310738268d9d6VMWfEhig)
//
// The 503 is the same event moments later. After one 403 the model returned
//
//   {"code":"model_not_found","type":"new_api_error",
//    "message":"分组 svip 下模型 k3-256k 无可用渠道（distributor）"}
//
// to every subsequent request for about 400 seconds (n=1, met while probing
// #152). The string has two readings and the endpoint does not separate them:
// the model is not served at all, or it was taken away by the concurrency
// event. The first reading is the one start-livetest already refuses before
// spending a turn -- verifyConfiguredModels throws when a configured model is
// missing from the fact table -- so mid-run the second is nearly always true.
// "Nearly" is why the report names both, and why nothing here writes anything
// back into the fact table.
const refusalShapes = [
  {
    kind: 'concurrency',
    httpStatus: 403,
    pattern: /concurrent request limit/i,
    says: 'the upstream is at its concurrent request limit',
  },
  {
    kind: 'no-channel',
    httpStatus: 503,
    pattern: /无可用渠道|model_not_found/i,
    says: 'the upstream says this model has no available channel',
  },
];

// The status as the endpoint stated it, from the field when Claude Code passes
// one on and from its own relayed text when it does not. A shape matches only
// if the status agrees or is absent entirely: the text alone is specific enough
// to identify, and refusing to match when no status is available anywhere would
// drop the reading on whichever path happens not to carry the field.
function statedStatus(event, said) {
  const field = Number(event?.api_error_status ?? event?.apiErrorStatus);
  if (Number.isFinite(field) && field > 0) return field;
  const inText = said.match(/API Error:\s*(\d{3})\b/i);
  return inText ? Number(inText[1]) : null;
}

// The text of a failure Claude Code flagged as coming from the API. Both places
// it surfaces one are read -- the assistant event it marks is_api_error_message,
// and the terminal result event -- and nothing else is. Scanning every event
// would eventually match a model writing about rate limits in its own output,
// and a run that blamed the endpoint because the product mentioned concurrency
// would be worse than one that said nothing.
export function apiErrorText(event) {
  const failed = event?.is_error === true
    || event?.is_api_error_message === true
    || event?.isApiErrorMessage === true;
  if (!failed) return null;
  if (typeof event.result === 'string') return event.result;
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  const said = blocks.filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join(' ');
  return said || null;
}

function match(said, status) {
  for (const shape of refusalShapes) {
    if (!shape.pattern.test(said)) continue;
    if (status !== null && status !== shape.httpStatus) return null;
    return { kind: shape.kind, says: shape.says, httpStatus: status, evidence: said.trim().slice(0, 300) };
  }
  return null;
}

// Guard 2, over text alone. Exported because two callers have nothing better:
// the app-icon turn asks for --output-format json and so has no event stream,
// and refreshModelCache reads a probe's failure text. Every caller still owes
// guard 1 -- this function cannot see whether anything was generated.
export function refusalFromText(said) {
  if (typeof said !== 'string' || !said) return null;
  return match(said, statedStatus(null, said));
}

// The same reading of one event of a Claude Code stream.
export function admissionRefusal(event) {
  const said = apiErrorText(event);
  if (!said) return null;
  return match(said, statedStatus(event, said));
}

// Guard 1: did this event prove that generation started. Anything the model
// produced counts -- text, thinking, a tool call, a tool result, or a non-zero
// output_tokens -- because each of them means the request was served and the
// turn then failed. A synthetic assistant event carrying an API error does not
// count: it is the refusal being reported, not a reply.
export function producedContent(event) {
  if (!event || typeof event !== 'object') return false;
  if (apiErrorText(event)) return false;
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  if (blocks.some((block) => block?.type === 'text' && String(block.text || '').trim())) return true;
  if (blocks.some((block) => block?.type === 'thinking' || block?.type === 'tool_use' || block?.type === 'tool_result')) return true;
  if (Number(event.message?.usage?.output_tokens) > 0) return true;
  return false;
}

// What a turn watched for while it ran. One object per launch: the caller feeds
// it every event it parses anyway, and afterwards asks it the only two questions
// that matter.
export function admissionWitness() {
  const state = { refusal: null, produced: false };
  return {
    observe(event) {
      if (producedContent(event)) state.produced = true;
      if (!state.refusal) state.refusal = admissionRefusal(event);
      return state;
    },
    // Guard 1 and guard 2 together. A refusal that arrived after any content is
    // not a refusal; it is a turn that failed partway, and it is reported as
    // that instead.
    refused() {
      return state.produced ? null : state.refusal;
    },
    produced() {
      return state.produced;
    },
  };
}

// So a caller can tell this apart from a model failure without reading the
// message. Nothing retries on it: it names what happened, not what to do next.
export const ADMISSION_REFUSED = 'ADMISSION_REFUSED';

// The report. Every line of it is something observed; the message deliberately
// stops short of saying when there will be room, because nothing here knows.
//
// `afterDesignKill` is the one local correlation worth stating. It is not a
// guess: the run knows whether it killed its own design turn moments earlier,
// and killing that turn provably does not cancel the request behind it. Naming
// the most likely collision is the difference between a report someone can act
// on and one that only says the endpoint said no.
export function refusedError(label, refusal, { afterDesignKill = false } = {}) {
  const lines = [
    `${label} never started: ${refusal.says}${refusal.httpStatus ? ` (HTTP ${refusal.httpStatus})` : ''}.`,
    '  Nothing was generated, so no model turn failed here -- the launch was refused.',
  ];
  if (afterDesignKill) {
    lines.push(
      '  This run killed its own design turn on its deadline moments ago. Killing the local'
      + ' client does not cancel the request behind it: the endpoint keeps generating and keeps'
      + ' the slot, so that is the most likely thing this launch collided with.',
    );
  }
  if (refusal.kind === 'no-channel') {
    lines.push(
      '  This answer reads two ways and the endpoint does not separate them: the model was taken'
      + ' away by a concurrency event, or it is no longer served at all. ./start-livetest.sh'
      + ' --refresh-models says which, once the endpoint is answering again.',
    );
  }
  lines.push('  Nothing here waited for room, because nothing here can know how long that would take.');
  lines.push(`  endpoint said: ${refusal.evidence}`);
  const error = new Error(lines.join('\n'));
  error.code = ADMISSION_REFUSED;
  error.admissionRefusal = { ...refusal, turn: label, afterDesignKill };
  return error;
}

export function isAdmissionRefused(error) {
  return error?.code === ADMISSION_REFUSED;
}
