/**
 * ─── r52-prototype-named-keys ──────────────────────────────────────────────
 * CS-1: pyric's simulator builds the post-write tree from plain JavaScript
 * objects, so a written key named `__proto__` never lands in it and the
 * key's `.validate` never runs. This asks whether production stores such keys
 * and runs their rules like any other key's.
 *
 * Captured 2026-10-26. A set at /__proto__ is an ordinary key in production:
 * its $k .validate runs and a string is denied, where pyric allows. The object
 * and update cases carrying an own __proto__ key were allowed in production;
 * the likeliest reading is that the client SDK drops that key before sending,
 * so the write reaches the server without it. They pin the end-to-end result,
 * not the rules engine.
 */
import type { RtdbScenarioRecord } from './types.ts';

const numbersOnly = { '.write': 'auth != null', $k: { '.validate': 'newData.isNumber()' } };

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a key named __proto__ is dropped from the simulated post-write tree, so its .validate is skipped; production stores it as an ordinary key.',
  provenance:
    'Drafted from the 2026-10-26 RTDB hunt (CS-1). Captured by deploy-observe-restore against pyric-oracle-rtdb on 2026-10-26 in observations/rtdb-rules/rules-rtdb-r52-prototype-named-keys.json.',
  rules: JSON.stringify({
    path: numbersOnly,
    value: numbersOnly,
    patch: numbersOnly,
    ctor: numbersOnly,
  }),
  cases: [
    { description: 'CS-1: a string set at /__proto__ under a number-only $k', expectation: 'DENY', operation: 'write', opPath: '/path/__proto__', authPresent: true, newData: 'x' },
    { description: 'CS-1: a number set at /__proto__ under a number-only $k', expectation: 'ALLOW', operation: 'write', opPath: '/path/__proto__', authPresent: true, newData: 1 },
    { description: 'CS-1: an object with a __proto__ string under a number-only $k', expectation: 'ALLOW', operation: 'write', opPath: '/value', authPresent: true, newData: JSON.parse('{"__proto__":"x"}') },
    { description: 'CS-1: an update writing a __proto__ string under a number-only $k', expectation: 'ALLOW', operation: 'update', opPath: '/patch', authPresent: true, newData: JSON.parse('{"__proto__":"x"}') },
    { description: 'CS-1: a string set at /constructor under a number-only $k', expectation: 'DENY', operation: 'write', opPath: '/ctor/constructor', authPresent: true, newData: 'x' },
    { description: 'CS-1 control: a string set at /plain under a number-only $k', expectation: 'DENY', operation: 'write', opPath: '/path/plain', authPresent: true, newData: 'x' },
    { description: 'CS-1 control: a number set at /plain under a number-only $k', expectation: 'ALLOW', operation: 'write', opPath: '/path/plain', authPresent: true, newData: 1 },
  ],
};
