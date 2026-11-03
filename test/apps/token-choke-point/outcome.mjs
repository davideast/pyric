// What a probe's call came to: the guard's code when the guard refused it
// anywhere in the error's chain, else the first code or message in the chain.
// gaxios, node-fetch and firebase/ai each wrap the refusal their own way.
const GUARD = 'PYRIC_GUARD_BLOCKED';

export function outcomeOf(error) {
  const seen = [];
  const queue = [error];
  while (queue.length > 0 && seen.length < 12) {
    const current = queue.shift();
    if (current === null || typeof current !== 'object') continue;
    seen.push(current);
    for (const key of ['cause', 'error', 'originalError', 'customErrorData']) queue.push(current[key]);
  }
  if (seen.some((item) => item.code === GUARD)) return GUARD;
  if (seen.some((item) => typeof item.message === 'string' && item.message.includes(GUARD))) return GUARD;
  const coded = seen.find((item) => typeof item.code === 'string' || typeof item.code === 'number');
  return String(coded?.code ?? seen[0]?.message ?? error);
}

/** Prints the probe's one result line, with every host the trap caught. */
export function report(name, results) {
  const trapped = [...new Set(globalThis[Symbol.for('scenario.trapped')] ?? [])];
  const guard = globalThis[Symbol.for('pyric.netGuard')]?.mode ?? null;
  console.log(`PROBE ${JSON.stringify({ name, results, trapped, guard })}`);
}
