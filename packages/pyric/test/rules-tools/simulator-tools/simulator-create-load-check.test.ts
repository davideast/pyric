/**
 * `firestore_simulator_create` refuses a source production would not load
 * (FS2-ENF-3a, FS2-ENF-3b). Production won't deploy a ruleset that does not
 * parse, names a service other than `cloud.firestore`, or is past a compile
 * limit. `rules.set` refuses each one and keeps the rules in force; the tool
 * does the same, with the same reason, and leaves the sandbox, its documents
 * and its rules as they were.
 */
import { describe, expect, test } from 'bun:test';
import type { ToolResult } from 'pyric/sandbox/internal';
import { rulesSourceRejection } from 'pyric/rules/internal';
import { setup, type SimulatorRegistry } from './_helpers.js';

const ABORT_CTX = { signal: new AbortController().signal };

/** Reads and writes under `open/` are allowed; everything else is denied. */
const OPEN_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{id} {
      allow read, write: if true;
    }
  }
}`;

const STORAGE_ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const UNPARSEABLE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true }
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
    match /{document=**} { allow read, write: if g(); }
  }
}`;

const MODULES_STORAGE = STORAGE_ALLOW_ALL.replace("rules_version = '2';", "rules_version = '2+modules';");

async function create(reg: SimulatorRegistry, rules: string, documents: Record<string, Record<string, unknown>> = {}): Promise<ToolResult> {
  return reg.get('firestore_simulator_create').execute({ rules, documents } as never, ABORT_CTX);
}

/** A registry seeded with {@link OPEN_ONLY} and one document. */
async function seeded(): Promise<SimulatorRegistry> {
  const reg = setup();
  const result = await create(reg, OPEN_ONLY, { 'open/a': { v: 1 } });
  expect(result.ok).toBe(true);
  return reg;
}

function expectPreviousRulesInForce(reg: SimulatorRegistry): void {
  expect(reg.env.getRules()).toBe(OPEN_ONLY);
  expect(reg.env.getDocument('open/a')).toEqual({ v: 1 });
  expect(reg.env.getDocument('locked/x')).toBeNull();
  expect(reg.env.execute({ method: 'create', path: 'open/b', auth: null, data: { v: 2 } }).allowed).toBe(true);
  expect(reg.env.execute({ method: 'get', path: 'open/a', auth: null }).allowed).toBe(true);
  expect(reg.env.execute({ method: 'create', path: 'locked/y', auth: null, data: { v: 3 } }).allowed).toBe(false);
}

const REFUSED: Array<[string, string]> = [
  ['a Storage ruleset', STORAGE_ALLOW_ALL],
  ['a source that does not parse', UNPARSEABLE],
  ['a source past a compile limit', PAST_COMPILE_LIMIT],
];

describe('firestore_simulator_create refuses what production would not load', () => {
  for (const [label, source] of REFUSED) {
    test(`${label}: ok:false with the shared reason, and the previous rules and documents stay`, async () => {
      const reg = await seeded();
      const rejection = rulesSourceRejection(source)!;
      expect(rejection).not.toBeNull();

      const result = await create(reg, source, { 'locked/x': { from: 'tool' } });

      expect(result).toEqual({
        ok: false,
        summary: `Firestore ${rejection.message}`,
        data: { code: 'RULES_REFUSED', rejection },
      });
      expectPreviousRulesInForce(reg);
    });
  }

  test('a Storage ruleset gives production\'s service reason', async () => {
    const reg = await seeded();
    const result = await create(reg, STORAGE_ALLOW_ALL);
    expect(result.summary).toBe(
      "Firestore rules did not compile: Expected 'service cloud.firestore', got 'service firebase.storage'.",
    );
  });

  test('a 2+modules source is checked after its modules resolve', async () => {
    const reg = await seeded();
    const result = await create(reg, MODULES_STORAGE);
    expect(result.ok).toBe(false);
    expect((result.data as { code?: string }).code).toBe('RULES_REFUSED');
    expectPreviousRulesInForce(reg);
  });

  test('a source production loads still seeds, documents and all', async () => {
    const reg = await seeded();
    const result = await create(reg, OPEN_ONLY.replace('match /open/{id}', 'match /other/{id}'), { 'other/z': { v: 9 } });
    expect(result.ok).toBe(true);
    expect(reg.env.getDocument('open/a')).toBeNull();
    expect(reg.env.getDocument('other/z')).toEqual({ v: 9 });
    expect(reg.env.execute({ method: 'create', path: 'other/b', auth: null, data: { v: 2 } }).allowed).toBe(true);
    expect(reg.env.execute({ method: 'create', path: 'open/b', auth: null, data: { v: 2 } }).allowed).toBe(false);
  });
});
