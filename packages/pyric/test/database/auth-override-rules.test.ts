import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { switchAuthLens } from '../../src/sandbox/internal/auth-lens.js';
import { get, getDatabase, ref, sandbox as databaseSandbox, set, update } from 'pyric/database';

afterEach(() => {
  switchAuthLens(undefined);
});

describe('RTDB sandbox auth overrides and validation refusal reasons (#3001, #3002)', () => {
  it('reaches top-level override fields via sandbox.withAuth and keeps auth.token limited to override claims', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox);
    databaseSandbox.setRules(adminDb, {
      rules: {
        items: {
          $id: {
            '.read': "auth != null && auth.role == 'writer'",
            '.write':
              "auth != null && auth.uid == 'u1' && auth.role == 'writer' && auth.token == null && auth.token.sub == null && auth.token.iat == null && auth.token.firebase == null",
          },
        },
        scoped: {
          $id: {
            '.write':
              "auth != null && auth.role == 'writer' && auth.token.gateway == true && auth.token.sub == null && auth.token.iat == null && auth.token.firebase == null",
          },
        },
      },
    });

    const writerDb = getDatabase(sandbox.withAuth({ uid: 'u1', role: 'writer' }));
    await set(ref(writerDb, 'items/i1'), { title: 'first' });
    expect((await get(ref(writerDb, 'items/i1'))).val()).toEqual({ title: 'first' });

    const readerDb = getDatabase(sandbox.withAuth({ uid: 'u1', role: 'reader' }));
    await expect(get(ref(readerDb, 'items/i1'))).rejects.toThrow(/PERMISSION_DENIED/);

    const scopedWriterDb = getDatabase(
      sandbox.withAuth({ uid: 'u1', role: 'writer', token: { gateway: true } }),
    );
    await set(ref(scopedWriterDb, 'scoped/i1'), 'ok');
    await expect(set(ref(scopedWriterDb, 'items/i2'), { title: 'has-token' })).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
  });

  it('reaches top-level override fields via an actAs lens on a live database handle', async () => {
    const sandbox = initializeSandbox();
    const liveDb = getDatabase(sandbox);
    databaseSandbox.setRules(liveDb, {
      rules: {
        items: {
          $id: {
            '.read': "auth != null && auth.role == 'writer' && auth.provider == 'service-worker'",
            '.write':
              "auth != null && auth.role == 'writer' && auth.provider == 'service-worker' && auth.token == null",
          },
        },
      },
    });

    switchAuthLens({ mode: 'as', uid: 'svc-1', role: 'writer', provider: 'service-worker' });
    await set(ref(liveDb, 'items/a'), 42);
    expect((await get(ref(liveDb, 'items/a'))).val()).toBe(42);

    switchAuthLens({ mode: 'as', uid: 'svc-1', role: 'viewer', provider: 'service-worker' });
    await expect(get(ref(liveDb, 'items/a'))).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('records the refusing .validate rule path in sandbox denial reasons on multi-path updates (#3002)', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'u1' }));
    databaseSandbox.setRules(getDatabase(sandbox), {
      rules: {
        items: {
          $id: {
            '.write': 'auth != null',
            size: { '.validate': 'newData.val() < 10' },
            name: { '.validate': 'newData.isString()' },
          },
        },
      },
    });

    const reasons: string[] = [];
    sandbox.onEvent((event) => {
      if (event.kind === 'operation' && event.service === 'rtdb' && event.result === 'deny') {
        if (event.rules?.reason !== undefined) reasons.push(event.rules.reason);
      }
    });

    await expect(update(ref(db), { 'items/a/size': 20, 'items/a/name': 'x' })).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    expect(reasons).toEqual(["Validation rule at '/items/$id/size' evaluated to false"]);
  });
});
