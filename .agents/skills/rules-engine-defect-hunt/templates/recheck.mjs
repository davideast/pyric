// Re-check findings against a built pyric checkout.
// Usage: PYRIC=<path to a built pyric checkout> node recheck.mjs
//
// Each check asserts the CORRECT behavior and prints OPEN or FIXED, so the same
// script is evidence before a fix and proof after it. Add one `check` per
// finding; keep the observed values in the output line.
const P = process.env.PYRIC;
if (!P) throw new Error('Set PYRIC to a built pyric checkout');

const { rtdbRules } = await import(`${P}/packages/pyric/dist/rules/index.js`);

const lines = [];
async function check(id, describe, run) {
  try {
    const { correct, observed } = await run();
    lines.push(`${correct ? 'FIXED ' : 'OPEN  '} ${id.padEnd(8)} ${describe} → ${observed}`);
  } catch (error) {
    lines.push(`ERROR  ${id.padEnd(8)} ${describe} → ${String(error?.message ?? error).slice(0, 120)}`);
  }
}

const decide = (ruleset, c) =>
  ruleset.simulate([{ expectation: 'ALLOW', data: {}, auth: { uid: 'u', token: {} }, ...c }]).cases[0].decision;

// Example: production fails a rule whose arithmetic gets a boolean, even under
// `|| true` (observations/rtdb-rules/rules-rtdb-r36-runtime-arithmetic-types.json).
await check('EXAMPLE', 'true - 1 == 0 || true', () => {
  const ruleset = rtdbRules({ rules: { a: { '.read': "data.child('v').val() - 1 == 0 || true" } } });
  const decision = decide(ruleset, { operation: 'read', path: '/a', data: { a: { v: true } } });
  return { correct: decision === 'DENY', observed: decision };
});

console.log(lines.join('\n'));
