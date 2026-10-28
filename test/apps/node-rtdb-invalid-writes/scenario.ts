// RP-1 and RP-6 (#1362): a process started with `node --import
// @pyric/cli/register` against the Node host makes RTDB writes the SDK
// refuses. Production's SDK throws each one synchronously and stores nothing.
// The hosted transport is JSON, where NaN becomes null, so before the fix
// `set(ref, NaN)` resolved and deleted the value firebase-admin then read.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Attempt { threw: boolean; message: string | null; before: unknown; stored: unknown }

function attempt(output: string, name: string): Attempt {
  const match = output.match(new RegExp(`^${name.replaceAll('.', '\\.')} (.*)$`, 'm'));
  assert.ok(match, `no ${name} line in:\n${output}`);
  return JSON.parse(match[1]) as Attempt;
}

const PRIORITY_RULE = 'must be a valid Firebase priority (a string, finite number, server value, or null).';

/** What each write must throw, and the value firebase-admin reads before and after it. */
const EXPECTED: Record<string, { message: string; seeded: unknown; priority?: number }> = {
  'set.nan': { message: "set failed: value argument contains NaN in property 'a'", seeded: 1 },
  'update.nan': { message: "update failed: values argument contains NaN in property 'b.k'", seeded: { j: 1, k: 5 } },
  'setPriority.nan': { message: `setPriority failed: priority argument is NaN, but ${PRIORITY_RULE}`, seeded: 5, priority: 3 },
  'set.undefined': { message: "set failed: value argument contains undefined in property 'd.k'", seeded: { k: 5 } },
  'update.array': {
    message: 'update failed: values argument  must be an object containing the children to replace.',
    seeded: { j: 1, k: 5 },
  },
};

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const { output } = await app.step('a registered process makes RTDB writes the SDK refuses', () =>
    app.serverScript('writes.mjs', [], { env: { PYRIC_SANDBOX: `remote:${host.url}` } }));

  await app.step('each write throws at the call and firebase-admin reads the seeded value', () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const result = attempt(output, name);
      assert.equal(result.threw, true, `${name} must throw at the call:\n${output}`);
      assert.equal(result.message, expected.message, `${name}:\n${output}`);
      const seed = { value: expected.seeded, priority: expected.priority ?? null };
      assert.deepEqual(result.before, seed, `${name} seed:\n${output}`);
      assert.deepEqual(result.stored, result.before, `${name} changed stored data:\n${output}`);
    }
  });
});
