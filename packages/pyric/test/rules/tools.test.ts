/**
 * Smoke tests for the Slice 8 factory shape — verify each handler
 * dispatches correctly through `createDispatch(registry)` and
 * returns the expected `ToolResult` shape.
 */

import { describe, it, expect } from 'bun:test';
import { createToolRegistry, createDispatch } from '@inbrowser/agent';
import type { ProjectScope } from '@pyric/cli/deploy';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { createFirestoreRulesTools, createFirestoreSimulatorTools } from '../../src/rules/internal/node.js';

const fakeScope: ProjectScope = {
  projectId: 'p',
  resolveToken: async () => 'tkn',
};

const fakeCtx = { signal: new AbortController().signal };

describe('createFirestoreRulesTools — without scope', () => {
  const tools = createFirestoreRulesTools();

  it('emits 5 handlers (no firestore_test_rules without scope; stdlib + lint + resolve come from the browser-safe factory)', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'firestore_simulate_rules',
      'firestore_rules_stdlib_list',
      'firestore_rules_stdlib_get',
      'firestore_lint_rules',
      'firestore_resolve_modules',
    ]);
  });

  it('handlers dispatch via createToolRegistry + createDispatch', async () => {
    const registry = createToolRegistry();
    for (const t of tools) registry.register(t);
    const dispatch = createDispatch(registry);
    const result = await dispatch.execute(
      {
        id: '1',
        name: 'firestore_lint_rules',
        args: {
          source: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if true; }
  }
}`,
        },
      },
      fakeCtx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Lint clean');
  });

  it('firestore_simulate_rules runs in-process via SimulateFirestoreRulesHandler', async () => {
    const registry = createToolRegistry();
    for (const t of tools) registry.register(t);
    const dispatch = createDispatch(registry);
    const result = await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulate_rules',
        args: {
          source: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if request.auth != null; }
  }
}`,
          testCases: [
            {
              description: 'authed allow',
              expectation: 'ALLOW',
              method: 'get',
              path: 'x/y',
              auth: { uid: 'alice' },
            },
          ],
        },
      },
      fakeCtx,
    );
    expect(result.ok).toBe(true);
  });

  it('firestore_resolve_modules surfaces failure via ok: false', async () => {
    const registry = createToolRegistry();
    for (const t of tools) registry.register(t);
    const dispatch = createDispatch(registry);
    const result = await dispatch.execute(
      {
        id: '1',
        name: 'firestore_resolve_modules',
        args: {
          source: `rules_version = '2+modules';
import { nope } from 'does-not-exist';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if nope(); }
  }
}`,
        },
      },
      fakeCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Resolve failed');
  });
});

describe('createFirestoreRulesTools — with scope', () => {
  const tools = createFirestoreRulesTools({ scope: fakeScope });

  it('emits 6 handlers when scope is supplied (adds firestore_test_rules to the 5-handler default)', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'firestore_simulate_rules',
      'firestore_rules_stdlib_list',
      'firestore_rules_stdlib_get',
      'firestore_lint_rules',
      'firestore_resolve_modules',
      'firestore_test_rules',
    ]);
  });
});

describe('createFirestoreSimulatorTools', () => {
  // Per-test fresh LocalEnvironment; the factory's `resolveSandbox`
  // returns the per-test ref so each test sees a clean sandbox.
  function setup() {
    const env = new LocalEnvironment();
    const tools = createFirestoreSimulatorTools({ resolveSandbox: () => env });
    const registry = createToolRegistry();
    for (const t of tools) registry.register(t);
    const dispatch = createDispatch(registry);
    return { env, tools, dispatch };
  }

  const SAMPLE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth.uid == resource.data.owner ||
                            request.auth.uid == request.resource.data.owner;
    }
  }
}`;

  it('emits all 9 simulator tool names', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'firestore_simulator_create',
      'firestore_simulator_execute',
      'firestore_simulator_read',
      'firestore_simulator_batch',
      'firestore_create_with_auto_id',
      'firestore_simulator_undo',
      'firestore_simulator_redo',
      'firestore_simulator_events',
      'firestore_simulator_transaction',
    ]);
  });

  it('firestore_simulator_create seeds the sandbox', async () => {
    const { dispatch, env } = setup();
    const result = await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: {
          rules: SAMPLE_RULES,
          documents: { 'notes/n1': { body: 'hello', owner: 'alice' } },
        },
      },
      fakeCtx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('1 document');
    expect(env.getDocument('notes/n1')).toEqual({ body: 'hello', owner: 'alice' });
  });

  // Note: simulator_create uses 'Module resolve failed' (the
  // simulator-internal resolver call), while the top-level
  // firestore_resolve_modules tool uses 'Resolve failed'. Two
  // separate code paths.
  it('firestore_simulator_create surfaces module-resolve failures via ok: false', async () => {
    const { dispatch } = setup();
    const result = await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: {
          rules: `rules_version = '2+modules';
import { nope } from 'does-not-exist';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if nope(); }
  }
}`,
        },
      },
      fakeCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Module resolve failed');
  });

  it('firestore_simulator_execute allows authorised writes and denies others', async () => {
    const { dispatch } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: { rules: SAMPLE_RULES },
      },
      fakeCtx,
    );

    const allow = await dispatch.execute(
      {
        id: '2',
        name: 'firestore_simulator_execute',
        args: {
          method: 'create',
          path: 'notes/n1',
          auth: { uid: 'alice' },
          data: { body: 'hi', owner: 'alice' },
        },
      },
      fakeCtx,
    );
    expect(allow.ok).toBe(true);
    const allowData = allow.data as { allowed: boolean };
    expect(allowData.allowed).toBe(true);

    const deny = await dispatch.execute(
      {
        id: '3',
        name: 'firestore_simulator_execute',
        args: {
          method: 'create',
          path: 'notes/n2',
          auth: { uid: 'bob' },
          data: { body: 'nope', owner: 'alice' },
        },
      },
      fakeCtx,
    );
    expect(deny.ok).toBe(false);
    const denyData = deny.data as { allowed: boolean; debugMessages: string[] };
    expect(denyData.allowed).toBe(false);
    expect(denyData.debugMessages.length).toBeGreaterThan(0);
  });

  it('firestore_simulator_read returns admin-bypass docs by default; honours evaluateRules', async () => {
    const { dispatch } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: {
          rules: SAMPLE_RULES,
          documents: { 'notes/n1': { body: 'hi', owner: 'alice' } },
        },
      },
      fakeCtx,
    );

    const adminRead = await dispatch.execute(
      { id: '2', name: 'firestore_simulator_read', args: { path: 'notes/n1' } },
      fakeCtx,
    );
    expect(adminRead.ok).toBe(true);
    expect((adminRead.data as { document: unknown }).document).toEqual({
      body: 'hi',
      owner: 'alice',
    });

    const ruleDeny = await dispatch.execute(
      {
        id: '3',
        name: 'firestore_simulator_read',
        args: {
          path: 'notes/n1',
          method: 'get',
          auth: { uid: 'bob' },
          evaluateRules: true,
        },
      },
      fakeCtx,
    );
    expect(ruleDeny.ok).toBe(false);
    expect((ruleDeny.data as { allowed: boolean }).allowed).toBe(false);
  });

  it('firestore_simulator_batch rolls back when any op denies', async () => {
    const { dispatch, env } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: { rules: SAMPLE_RULES },
      },
      fakeCtx,
    );

    const denied = await dispatch.execute(
      {
        id: '2',
        name: 'firestore_simulator_batch',
        args: {
          auth: { uid: 'alice' },
          operations: [
            { method: 'create', path: 'notes/a', data: { body: 'ok', owner: 'alice' } },
            { method: 'create', path: 'notes/b', data: { body: 'evil', owner: 'mallory' } },
          ],
        },
      },
      fakeCtx,
    );
    expect(denied.ok).toBe(false);
    // Neither doc should have been written.
    expect(env.getDocument('notes/a')).toBeNull();
    expect(env.getDocument('notes/b')).toBeNull();
  });

  it('firestore_simulator_undo reverses the last allowed write', async () => {
    const { dispatch, env } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: { rules: SAMPLE_RULES },
      },
      fakeCtx,
    );
    await dispatch.execute(
      {
        id: '2',
        name: 'firestore_simulator_execute',
        args: {
          method: 'create',
          path: 'notes/n1',
          auth: { uid: 'alice' },
          data: { body: 'hi', owner: 'alice' },
        },
      },
      fakeCtx,
    );
    expect(env.getDocument('notes/n1')).toBeDefined();

    const undo = await dispatch.execute(
      { id: '3', name: 'firestore_simulator_undo', args: {} },
      fakeCtx,
    );
    expect(undo.ok).toBe(true);
    expect((undo.data as { undone: boolean }).undone).toBe(true);
    expect(env.getDocument('notes/n1')).toBeNull();
  });

  it('firestore_simulator_undo returns undone:false when the log is empty', async () => {
    const { dispatch } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: { rules: SAMPLE_RULES },
      },
      fakeCtx,
    );
    const undo = await dispatch.execute(
      { id: '2', name: 'firestore_simulator_undo', args: {} },
      fakeCtx,
    );
    expect(undo.ok).toBe(true);
    expect((undo.data as { undone: boolean }).undone).toBe(false);
  });

  it('firestore_simulator_events returns the full log', async () => {
    const { dispatch } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: { rules: SAMPLE_RULES },
      },
      fakeCtx,
    );
    await dispatch.execute(
      {
        id: '2',
        name: 'firestore_simulator_execute',
        args: {
          method: 'create',
          path: 'notes/n1',
          auth: { uid: 'alice' },
          data: { body: 'hi', owner: 'alice' },
        },
      },
      fakeCtx,
    );
    const events = await dispatch.execute(
      { id: '3', name: 'firestore_simulator_events', args: {} },
      fakeCtx,
    );
    expect(events.ok).toBe(true);
    const log = (events.data as { events: Array<{ method: string }> }).events;
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log.some((e) => e.method === 'create')).toBe(true);
  });

  it('firestore_simulator_transaction commits with $expr references and includes reads when requested', async () => {
    const { dispatch, env } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: {
          rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{path=**} {
      allow read, write: if request.auth != null;
    }
  }
}`,
          documents: { 'counters/c1': { value: 5, owner: 'alice' } },
        },
      },
      fakeCtx,
    );

    const tx = await dispatch.execute(
      {
        id: '2',
        name: 'firestore_simulator_transaction',
        args: {
          auth: { uid: 'alice' },
          includeReads: true,
          reads: { c: 'counters/c1' },
          writes: [
            {
              method: 'update',
              path: 'counters/c1',
              data: { value: { $expr: '$c.value + 1' } },
            },
          ],
        },
      },
      fakeCtx,
    );
    expect(tx.ok).toBe(true);
    expect(env.getDocument('counters/c1')).toMatchObject({ value: 6 });
    const txData = tx.data as { reads: Array<{ path: string; data: unknown }> };
    expect(txData.reads).toEqual([{ path: 'counters/c1', data: { value: 5, owner: 'alice' } }]);
  });

  it('firestore_simulator_transaction surfaces expression errors as ok:false', async () => {
    const { dispatch } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: { rules: SAMPLE_RULES },
      },
      fakeCtx,
    );
    const bad = await dispatch.execute(
      {
        id: '2',
        name: 'firestore_simulator_transaction',
        args: {
          auth: { uid: 'alice' },
          reads: {},
          writes: [
            {
              method: 'update',
              path: 'notes/n1',
              data: { v: { $expr: '$missing.field' } },
            },
          ],
        },
      },
      fakeCtx,
    );
    expect(bad.ok).toBe(false);
    const data = bad.data as { error?: { code: string } };
    expect(data.error?.code).toBe('invalid-argument');
  });

  it('firestore_simulator_transaction rejects malformed write shapes', async () => {
    const { dispatch } = setup();
    await dispatch.execute(
      {
        id: '1',
        name: 'firestore_simulator_create',
        args: { rules: SAMPLE_RULES },
      },
      fakeCtx,
    );
    const r = await dispatch.execute(
      {
        id: '2',
        name: 'firestore_simulator_transaction',
        args: {
          auth: { uid: 'alice' },
          reads: {},
          writes: [{ method: 'create', path: 'notes/n1' }], // missing `data`
        },
      },
      fakeCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("requires 'data'");
  });
});
