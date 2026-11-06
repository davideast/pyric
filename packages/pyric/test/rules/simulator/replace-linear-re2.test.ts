/**
 * `replace()` runs on the linear RE2 matcher `split()` and `matches()` use,
 * and both searches stay linear when a higher-priority branch cannot match
 * (#1332, #1890, #1891, #1892, #2211, replace() half; #1895).
 *
 * Every `replace()` case of the 2026-11-03 Firestore rules hunt capture
 * `c1-re2-replace-split` (row firestore-rules#232) runs here, each through
 * `setRules` and a `setDoc` in the in-process sandbox, and must give the
 * verdict production gave, read from the committed observation. They cover
 * scoped and inline flags (`sf0` to `sf6`), `(?U)` (`ug0`, `ug1`), `\pL`,
 * `[[:alpha:]]` and `\Q..\E` (`pl0` to `qe1`), an astral character as one
 * code point (`as0` to `as3`), `\z` and `\A` under `(?m)` (`za0`, `za1`),
 * empty matches (`em0` to `em2`) and replacement templates (`tp0` to `tp2`).
 *
 * The timing guards are pyric's own: before this change `split()` read the
 * rest of the subject once per match of `.*x|a` and took about 1.5 s on
 * 8,000 characters.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getFirestore, setDoc } from 'pyric/firestore';

type Verdict = 'ALLOW' | 'DENY';

const OBSERVATION = join(
  import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'firestore-rules',
  'rules-firestore-re2-replace-and-split-dialect.json',
);

/** Production's verdict on each captured case, by description. */
const production = (JSON.parse(readFileSync(OBSERVATION, 'utf8')) as { behavior: Record<string, Verdict> }).behavior;

/** The rules expression of a case described as `id: expression`, as the capture sent it. */
function guardOf(description: string): string {
  return description.slice(description.indexOf(': ') + 2);
}

function rulesFor(guard: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow create: if ${guard};
    }
  }
}`;
}

/** Whether a create of `c/1` holding `s` is allowed under `guard`. */
async function createAllowed(guard: string, s: string): Promise<boolean> {
  const sandbox = initializeSandbox();
  setRules(sandbox, rulesFor(guard));
  try {
    await setDoc(doc(getFirestore(sandbox), 'c/1'), { s });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'permission-denied') return false;
    throw err;
  }
}

const replaceCases = Object.entries(production).filter(([description]) => description.includes('.replace('));

describe("replace() gives production's verdict on every c1-re2-replace-split case", () => {
  test('the capture has 23 replace() cases', () => {
    expect(replaceCases).toHaveLength(23);
  });

  for (const [description, verdict] of replaceCases) {
    test(description, async () => {
      expect(await createAllowed(guardOf(description), '')).toBe(verdict === 'ALLOW');
    });
  }
});

describe('a higher-priority branch that cannot match costs nothing per search', () => {
  const subject = 'a'.repeat(8000);
  const guards = {
    split: "request.resource.data.s.split('.*x|a').size() == 1",
    replace: "request.resource.data.s.replace('.*x|a', '') == ''",
  };
  for (const [method, guard] of Object.entries(guards)) {
    test(`${method}() with .*x|a on 8,000 characters allows within 400 ms`, async () => {
      await createAllowed(guard, 'warm up');
      const started = performance.now();
      const allowed = await createAllowed(guard, subject);
      const elapsed = performance.now() - started;
      expect(allowed).toBe(true);
      expect(elapsed).toBeLessThan(400);
    });
  }
});
