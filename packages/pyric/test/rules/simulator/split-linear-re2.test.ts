/**
 * `split()` runs on the linear RE2 matcher `matches()` uses and reads the
 * pattern as production does (#1895, #1890, #1891, #1892, split half; the
 * replace() half is separate).
 *
 * Production captures from the 2026-11-03 Firestore rules hunt:
 * - `c10-script-classes-and-redos` `rd0`: `s.split('(a+)+b').size() == 1` on a
 *   run of `a` with no `b` ALLOWS at once; pyric backtracked for time
 *   exponential in the run's length.
 * - `c1-re2-replace-split` `as2` and `c9-re2-more` `ar1`: an emoji is one
 *   code point, so `'a😀b'.split('[^ab]') == ['a', 'b']` and
 *   `'a😀'.split('[😀-😂]') == ['a']` ALLOW.
 * - `c1-re2-replace-split` `sf4`: a scoped `(?i:b)` covers only `b`, so
 *   `'Ab'.split('a(?i:b)') == ['Ab']` ALLOWS.
 * - `c1-re2-replace-split` `pl2`: `\pL` is a letter class, so
 *   `'1a2'.split('\\pL') == ['1', '2']` ALLOWS.
 * - `c1-re2-replace-split` `as7`: `'a😀b'.split('').size() == 3` DENIES, so
 *   an empty pattern still splits the pair, as JavaScript's split does.
 *
 * Inferred, not observed through `split()`: the `(?U)` and `\z`/`\A` cases
 * below come from RE2's semantics and from c1's `replace()` captures of the
 * same patterns (`ug0` and `ug1`: `(?U)` makes `a+` ungreedy; `za0` and
 * `za1`: under `(?m)`, `\z` and `\A` stay the absolute end and start).
 * Production was not asked these `split()` guards.
 *
 * Each guard reads its subject from the written document, and each case runs
 * through `setRules` and a `setDoc` in the in-process sandbox.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getFirestore, setDoc } from 'pyric/firestore';

/** A rules string literal for `pattern`, backslashes escaped. */
function literal(pattern: string): string {
  return `'${pattern.replaceAll('\\', '\\\\')}'`;
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

function splitGuard(pattern: string, pieces: string): string {
  return `request.resource.data.s.split(${literal(pattern)}) == ${pieces}`;
}

describe('split() on a nested repeat runs in linear time', () => {
  test('rd0: (a+)+b on 40 a characters allows within 50 ms', async () => {
    const guard = `request.resource.data.s.split(${literal('(a+)+b')}).size() == 1`;
    await createAllowed(guard, 'warm up');
    const started = performance.now();
    const allowed = await createAllowed(guard, 'a'.repeat(40));
    const elapsed = performance.now() - started;
    expect(allowed).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('split() reads an astral character as one code point', () => {
  test("as2: 'a😀b'.split('[^ab]') is ['a', 'b']", async () => {
    expect(await createAllowed(splitGuard('[^ab]', "['a', 'b']"), 'a😀b')).toBe(true);
  });

  test("ar1: 'a😀'.split('[😀-😂]') is ['a']", async () => {
    expect(await createAllowed(splitGuard('[😀-😂]', "['a']"), 'a😀')).toBe(true);
  });

  test("as7: 'a😀b'.split('') does not have size three", async () => {
    const guard = `request.resource.data.s.split('').size() == 3`;
    expect(await createAllowed(guard, 'a😀b')).toBe(false);
  });
});

describe('split() reads flags and classes as the matcher parses them', () => {
  test("sf4: 'Ab'.split('a(?i:b)') is ['Ab']", async () => {
    expect(await createAllowed(splitGuard('a(?i:b)', "['Ab']"), 'Ab')).toBe(true);
  });

  test("pl2: '1a2'.split('\\pL') is ['1', '2']", async () => {
    expect(await createAllowed(splitGuard('\\pL', "['1', '2']"), '1a2')).toBe(true);
  });
});

describe('split() reads (?U) as ungreedy (inferred from the replace() captures ug0 and ug1)', () => {
  test('(?U)X.*b splits at each shortest match', async () => {
    expect(await createAllowed(splitGuard('(?U)X.*b', "['a', 'c', 'd']"), 'aXbcXbd')).toBe(true);
  });

  test('(?U)X.*?b is greedy again', async () => {
    expect(await createAllowed(splitGuard('(?U)X.*?b', "['a', 'd']"), 'aXbcXbd')).toBe(true);
  });

  test('X.*b without the flag splits at the longest match (control)', async () => {
    expect(await createAllowed(splitGuard('X.*b', "['a', 'd']"), 'aXbcXbd')).toBe(true);
  });
});

describe('split() keeps \\z and \\A absolute under (?m) (inferred from the replace() captures za0 and za1)', () => {
  test('(?m)a\\z does not match before a newline', async () => {
    expect(await createAllowed(splitGuard('(?m)a\\z', "['a\\nb']"), 'a\nb')).toBe(true);
  });

  test('(?m)\\Ab does not match after a newline', async () => {
    expect(await createAllowed(splitGuard('(?m)\\Ab', "['a\\nb']"), 'a\nb')).toBe(true);
  });

  test('(?m)a$ still matches before a newline (control)', async () => {
    expect(await createAllowed(splitGuard('(?m)a$', "['', '\\nb']"), 'a\nb')).toBe(true);
  });
});
