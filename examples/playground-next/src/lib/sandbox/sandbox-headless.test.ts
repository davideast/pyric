/**
 * Tier 2 verification: does @pyric/sandbox run headlessly in Node, and do
 * the sandbox tools (which reach it via the module-singleton `getRunner()`,
 * NOT ctx.sandbox) work end-to-end without a browser?
 *
 * Exercises the REAL path: deploy rules → seed docs via the real
 * `seed_firestore_data_as_admin` tool → read them back via `getRunner()`
 * and the real `sandbox_discover_paths` tool. If `initializeSandbox()` /
 * `getInternalEnv()` / `adminSetDocument()` are browser-bound this fails
 * here, which is exactly the question Tier 2 needs answered.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import type { ToolHandler } from '@inbrowser/agent';

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    },
  };
}

const ctx = {} as never;
const PERMISSIVE =
  "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /{document=**} { allow read, write: if true; }\n  }\n}";

let getRunner: () => {
  deployRules: (s: string) => { ok: boolean; messages: { severity: string; text: string }[] };
  readState: () => Record<string, unknown>;
  getSandbox: () => unknown;
};
let disposeRunner: () => void;
let seed: ToolHandler;
let discover: ToolHandler;

beforeAll(async () => {
  ({ getRunner, disposeRunner } = await import('~/lib/sandbox/runner'));
  seed = (await import('~/lib/tools/diagnostics/seed-firestore-data')).buildSeedFirestoreDataHandler() as ToolHandler;
  discover = (await import('~/lib/tools/core/sandboxDiscover')).buildSandboxDiscoverHandler() as ToolHandler;
});

describe('@pyric/sandbox runs headlessly via getRunner()', () => {
  test('initializeSandbox + setRules run in Node (rules parse; engine executes)', () => {
    disposeRunner();
    const dep = getRunner().deployRules(PERMISSIVE);
    // The rules ENGINE ran in Node: a result with messages, no parse error.
    // (ok is false here only because the security linter flags public
    // write as a critical finding — correct behavior, not a node issue.)
    expect(Array.isArray(dep.messages)).toBe(true);
    expect(dep.messages.some((m) => /PARSE ERROR/.test(m.text))).toBe(false);

    // An auth-gated ruleset that doesn't trip the public-write finding
    // deploys clean — proving the deploy gate itself works headlessly.
    const owner =
      "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /users/{uid} { allow read, write: if request.auth != null && request.auth.uid == uid; }\n  }\n}";
    expect(getRunner().deployRules(owner).ok).toBe(true);
  });

  test('seed tool writes docs that getRunner().readState() reads back', async () => {
    disposeRunner();
    getRunner().deployRules(PERMISSIVE);
    const r = await seed.execute(
      {
        operations: [
          { path: 'users/alice', data: { name: 'Alice', role: 'admin' } },
          { path: 'users/bob', data: { name: 'Bob' } },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect((r.data as { applied: number }).applied).toBe(2);

    const state = getRunner().readState();
    expect(Object.keys(state)).toContain('users/alice');
    expect((state['users/alice'] as { name?: string }).name).toBe('Alice');
  });

  test('sandbox_discover_paths sees the seeded collection', async () => {
    disposeRunner();
    getRunner().deployRules(PERMISSIVE);
    await seed.execute({ operations: [{ path: 'tasks/t1', data: { title: 'x', ownerId: 'alice' } }] }, ctx);
    const d = await discover.execute({}, ctx);
    expect(d.ok).toBe(true);
    expect(JSON.stringify(d.data)).toContain('tasks');
  });

  test('delete op via seed tool removes a doc', async () => {
    disposeRunner();
    getRunner().deployRules(PERMISSIVE);
    await seed.execute({ operations: [{ path: 'users/alice', data: { name: 'Alice' } }] }, ctx);
    await seed.execute({ operations: [{ path: 'users/alice', method: 'delete' }] }, ctx);
    expect(Object.keys(getRunner().readState())).not.toContain('users/alice');
  });
});
