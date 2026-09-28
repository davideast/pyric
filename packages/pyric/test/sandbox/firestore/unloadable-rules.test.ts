/**
 * A ruleset production would not load, set through the SDK sandbox.
 *
 * `setRules` installs whatever it is given, so a developer sees the effect of
 * a broken save at once. The CLI's rules load paths refuse the same source
 * and keep the rules in force. Both report the one reason, from
 * `rulesSourceRejection`: the sandbox's rules status and each denial the
 * installed ruleset produces carry the message the CLI refuses with.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { inspect, setRules } from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';
import { getFirestore, doc, getDoc } from '../../../src/firestore/index.js';

const UNPARSEABLE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} { allow read: if true }
  }
}`;

const lets = Array.from({ length: 12 }, (_, i) => `      let v${i} = ${i};`).join('\n');
const PAST_COMPILE_LIMIT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function g() {
${lets}
      return v0 == 0;
    }
    match /notes/{id} { allow read: if g(); }
  }
}`;

describe('setRules with a ruleset production would not load', () => {
  for (const [label, source, kind] of [
    ['one that does not parse', UNPARSEABLE, 'parse'],
    ['one past a compile limit', PAST_COMPILE_LIMIT, 'compile'],
  ] as const) {
    test(`${label}: installed, with the CLI's reason as its status and its denial reason`, async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, source);
      // Installed, by design for the SDK.
      expect(inspect(sandbox).rules.source).toBe(source);

      const rejection = rulesSourceRejection(source)!;
      expect(rejection.kind).toBe(kind);
      const reason = `Firestore ${rejection.message}`;
      const status = inspect(sandbox).rules.lint;
      expect(status.findings).toContainEqual({
        rule: kind === 'parse' ? 'PARSE_ERROR' : 'COMPILE_LIMIT',
        severity: 'error',
        message: reason,
      });
      expect(status.errors).toBeGreaterThan(0);

      await expect(getDoc(doc(getFirestore(sandbox), 'notes/n1'))).rejects.toThrow(reason);
      const request = sandbox.history().at(-1) as unknown as { result: string; reasons: string[] };
      expect(request.result).toBe('deny');
      expect(request.reasons.join(' ')).toContain(reason);
    });
  }

  test('the parse reason names the line and column, as the CLI does', () => {
    expect(rulesSourceRejection(UNPARSEABLE)!.message).toMatch(/^rules did not parse at line 4, column \d+: .+\.$/);
    expect(rulesSourceRejection(PAST_COMPILE_LIMIT)!.message).toBe(
      'rules did not compile: Line 17: Maximum allowed variable count of 10 for a given function has been reached.',
    );
  });
});
