/**
 * `firestore_simulator_create` refuses a source production would not load:
 * a syntax error, duplicate declarations of one service, or a compile-limit
 * violation. Under `#1434`, a `service firebase.storage` ruleset compiles in
 * production and denies every Firestore operation, so the tool seeds it and
 * denies client reads and writes.
 */
import { describe, expect, test } from 'bun:test';
import type { ToolResult } from 'pyric/sandbox/internal';
import { rulesSourceRejection } from 'pyric/rules/internal';
import { setup, type SimulatorRegistry } from './_helpers.js';

const ABORT_CTX = { signal: new AbortController().signal };

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

const DUPLICATE_FIRESTORE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{id} { allow read: if true; }
  }
}
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{id} { allow read: if false; }
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

const UNRESOLVED_MODULES_STORAGE = `rules_version = '2+modules';
import { missingHelper } from './missing.rules';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read: if missingHelper(); }
  }
}`;

async function create(
  reg: SimulatorRegistry,
  rules: string,
  documents: Record<string, Record<string, unknown>> = {},
): Promise<ToolResult> {
  return reg.get('firestore_simulator_create').execute({ rules, documents } as never, ABORT_CTX);
}

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
  ['duplicate service declarations', DUPLICATE_FIRESTORE],
  ['a source that does not parse', UNPARSEABLE],
  ['a source past a compile limit', PAST_COMPILE_LIMIT],
];

describe('firestore_simulator_create load check and wrong-service behavior', () => {
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

  test('a Storage ruleset seeds cleanly and denies every Firestore operation (#1434)', async () => {
    const reg = await seeded();
    const result = await create(reg, STORAGE_ALLOW_ALL, { 'open/z': { v: 9 } });
    expect(result.ok).toBe(true);
    expect(reg.env.getDocument('open/z')).toEqual({ v: 9 });
    expect(reg.env.execute({ method: 'get', path: 'open/z', auth: null }).allowed).toBe(false);
    expect(reg.env.execute({ method: 'create', path: 'open/b', auth: null, data: { v: 2 } }).allowed).toBe(false);
  });

  test('an unresolved 2+modules source fails module resolution and keeps previous rules', async () => {
    const reg = await seeded();
    const result = await create(reg, UNRESOLVED_MODULES_STORAGE);
    expect(result.ok).toBe(false);
    expectPreviousRulesInForce(reg);
  });
});
