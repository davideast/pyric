/**
 * Host-side write gates (C1) — rules gate (lint + history verification)
 * and app gate (compile/syntax). The binding behaviors under test:
 *
 *   - gates REPORT, they never block: every result is a `WriteValidation`
 *     value, never a throw;
 *   - clean writes produce EMPTY arrays (the "verified clean" signal);
 *   - broken rules surface regressions (previously-succeeded writes now
 *     denied) and classify previously-denied requests into
 *     unblocked / stillDenied;
 *   - gate failure degrades to write-without-validation (`gateError`).
 *
 * Rules-gate tests drive a REAL sandbox via the runner singleton — the
 * same write/denial event stream the playground captures — rather than
 * fabricating replay-internal shapes.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { getFirestore, doc, setDoc, getDoc } from 'pyric/firestore';
import { getRunner, disposeRunner } from '~/lib/sandbox/runner';
import {
  isAppSourcePath,
  isValidationClean,
  summarizeValidation,
  validateAppWrite,
  validateRulesWrite,
} from './write-gates';
import { APP_ENTRY_PATH } from '~/lib/store/files';

/** Lint-clean v1: any signed-in user can read/write /docs. */
const AUTHED_RW = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;

/** Lint-clean proposed edit: reads open to everyone (unblocks captured
 *  unauthenticated reads), writes admin-only (regresses alice's write,
 *  keeps unauthenticated writes denied). */
const OPEN_READ_ADMIN_WRITE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/{id} {
      allow read: if true;
      allow write: if request.auth.uid == 'admin';
    }
  }
}`;

afterEach(() => {
  disposeRunner();
});

describe('validateRulesWrite — rules gate', () => {
  test('clean write on empty history → empty arrays (verified clean)', () => {
    getRunner(); // fresh sandbox, no events
    const v = validateRulesWrite(AUTHED_RW);
    expect(v.gateError).toBeUndefined();
    expect(v.lint).toEqual([]);
    expect(v.regressions).toEqual([]);
    expect(v.stillDenied).toEqual([]);
    expect(v.unblocked).toBe(0);
    expect(isValidationClean(v)).toBe(true);
    expect(summarizeValidation(v)).toBe('validation clean');
  });

  test('parse error → reported in lint, history phases skipped', () => {
    getRunner();
    const v = validateRulesWrite('rules_version = ;; nonsense {');
    expect(v.gateError).toBeUndefined();
    expect(v.lint?.length).toBe(1);
    expect(v.lint?.[0]).toContain('parse error');
    expect(v.regressions).toEqual([]);
    expect(isValidationClean(v)).toBe(false);
  });

  test('lint catches JS-style hallucinations in otherwise-parseable rules', () => {
    getRunner();
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/{id} {
      allow read: if resource.data.title.toLowerCase() == 'x';
    }
  }
}`;
    const v = validateRulesWrite(src);
    expect(v.gateError).toBeUndefined();
    expect((v.lint?.length ?? 0) > 0).toBe(true);
    expect(isValidationClean(v)).toBe(false);
  });

  test('regression + unblocked + stillDenied classification over real captured history', async () => {
    const runner = getRunner();
    const sandbox = runner.getSandbox();

    // 1. A write that SUCCEEDS under the current rules → captured write event.
    expect(runner.deployRules(AUTHED_RW).ok).toBe(true);
    const alice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(alice, 'docs', 'd1'), { title: 'hi' });

    // 2. Unauthenticated requests get DENIED → captured denied request events.
    const anon = getFirestore(sandbox.withAuth(null));
    await expect(getDoc(doc(anon, 'docs', 'd1'))).rejects.toThrow(); // will be unblocked
    await expect(setDoc(doc(anon, 'docs', 'd2'), { t: 1 })).rejects.toThrow(); // stays denied

    // 3. Proposed edit: reads open to everyone, writes admin-only.
    const v = validateRulesWrite(OPEN_READ_ADMIN_WRITE);
    expect(v.gateError).toBeUndefined();
    expect(v.lint).toEqual([]);
    // alice's previously-succeeded write is now denied → regression.
    expect(v.regressions?.map((r) => r.path)).toEqual(['docs/d1']);
    expect(v.regressions?.[0]?.uid).toBe('alice');
    // the denied unauthenticated READ is now allowed → unblocked; the
    // denied unauthenticated WRITE stays denied.
    expect(v.unblocked).toBe(1);
    expect(v.stillDenied?.map((e) => e.path)).toEqual(['docs/d2']);
    expect(v.stillDenied?.[0]?.uid).toBeNull();
    // regressions make the write non-clean; the summary names the evidence.
    expect(isValidationClean(v)).toBe(false);
    expect(summarizeValidation(v)).toContain('1 regression');
    expect(summarizeValidation(v)).toContain('1 denial unblocked');
  });

  test('re-deploying the SAME semantics over history → clean', async () => {
    const runner = getRunner();
    const sandbox = runner.getSandbox();
    expect(runner.deployRules(AUTHED_RW).ok).toBe(true);
    const alice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(alice, 'docs', 'd1'), { title: 'hi' });

    const v = validateRulesWrite(AUTHED_RW);
    expect(v.regressions).toEqual([]);
    expect(isValidationClean(v)).toBe(true);
  });

  test('gate failure degrades to write-without-validation, never throws', () => {
    const v = validateRulesWrite(AUTHED_RW, {
      history: () => {
        throw new Error('sandbox exploded');
      },
      snapshot: () => ({}),
    });
    expect(v.gateError).toContain('sandbox exploded');
    expect(isValidationClean(v)).toBe(false);
    expect(summarizeValidation(v)).toContain('validation skipped');
  });
});

describe('validateAppWrite — compile gate', () => {
  test('isAppSourcePath covers .tsx and .ts only', () => {
    expect(isAppSourcePath('/workspace/src/App.tsx')).toBe(true);
    expect(isAppSourcePath('/workspace/src/lib/util.ts')).toBe(true);
    expect(isAppSourcePath('/workspace/firestore.rules')).toBe(false);
    expect(isAppSourcePath('/workspace/notes.txt')).toBe(false);
  });

  test('valid TSX module → empty compile array (clean)', async () => {
    const v = await validateAppWrite(
      '/workspace/src/components/Card.tsx',
      `export function Card({ title }: { title: string }) { return <div>{title}</div>; }`,
    );
    expect(v.gateError).toBeUndefined();
    expect(v.compile).toEqual([]);
    expect(isValidationClean(v)).toBe(true);
  });

  test('broken TSX → compile error surfaced, write not blocked', async () => {
    const v = await validateAppWrite(
      '/workspace/src/components/Broken.tsx',
      `export function Broken() { return <div>{oops</div>; }`,
    );
    expect(v.gateError).toBeUndefined();
    expect((v.compile?.length ?? 0) > 0).toBe(true);
    expect(isValidationClean(v)).toBe(false);
    expect(summarizeValidation(v)).toContain('compile error');
  });

  test('entry path degrades to syntax check when the browser pipeline is unavailable (Node)', async () => {
    // In the headless harness the vite `?url` wasm import can't load, so
    // the entry falls back to the syntax-level transform — clean source
    // still reports clean rather than a gateError.
    const v = await validateAppWrite(
      APP_ENTRY_PATH,
      `export default function App() { return <p>hello</p>; }`,
    );
    expect(v.gateError).toBeUndefined();
    expect(v.compile).toEqual([]);
  });

  test('plain .ts module with a type-level-only construct compiles (no type-check, syntax only)', async () => {
    const v = await validateAppWrite(
      '/workspace/src/lib/types.ts',
      `export interface Task { id: string; done: boolean }`,
    );
    expect(v.compile).toEqual([]);
  });
});
