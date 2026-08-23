// What this endpoint says about its own limits, and how to read it. Pure: no
// network, no subprocess, safe on a run path as well as in the offline probes.

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

// The same measurement arriving unasked. A turn refused for being over the
// window is the one moment the endpoint volunteers its real limit on a run
// path, and it costs nothing because a rejected request is not billed.
//
// Claude Code surfaces the endpoint's text twice: on an assistant event flagged
// is_api_error_message, and on the terminal result event, which also carries
// api_error_status. Only those two are read. Scanning the whole trace would
// eventually match a model that wrote "256K context" in its own output, and a
// warning that cries wolf is worse than none.
export function windowFromApiError(event) {
  const failed = event?.is_error === true || event?.is_api_error_message === true;
  if (!failed) return null;
  const said = typeof event.result === 'string'
    ? event.result
    : (Array.isArray(event.message?.content) ? event.message.content : [])
      .filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join(' ');
  const parsed = windowFromRejection(said);
  if (!parsed) return null;
  return { ...parsed, httpStatus: Number(event.api_error_status) || null, evidence: said.trim().slice(0, 300) };
}
