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
