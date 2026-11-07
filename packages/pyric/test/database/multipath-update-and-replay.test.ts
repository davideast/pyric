import { describe, expect, it } from 'bun:test';
import {
  initializeSandbox,
  type RtdbDenialContext,
  type SandboxOperationEvent,
} from 'pyric/sandbox';
import { replay as replayRtdb } from 'pyric/sandbox/internal';
import {
  get,
  getDatabase,
  onDisconnect,
  ref,
  remove,
  sandbox as rtdbSandbox,
  set,
  setWithPriority,
  update,
} from 'pyric/database';

function contextOf(error: unknown): RtdbDenialContext {
  const descriptor = Object.getOwnPropertyDescriptor(error as object, 'denialContext');
  expect(descriptor?.enumerable).toBe(true);
  return descriptor!.value as RtdbDenialContext;
}

describe('RTDB multi-path update rule evaluation precedence', () => {
  it('evaluates .write across every update path before enforcing .validate', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(db, {
      rules: {
        users: {
          $uid: {
            '.write': 'auth.uid == $uid',
            score: {
              // Unsupported expression in .validate on sibling path must not mask .write denial
              '.validate': 'newData.isNumber() && unknownHelper()',
            },
          },
        },
      },
    });

    let caught: unknown;
    try {
      await update(ref(db), {
        'users/alice/name': 'Alice',
        'users/bob/score': 'not-a-number',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const denial = contextOf(caught);
    expect(denial.request.path).toBe('/users/bob/score');
    expect(denial.matchedPath).toBe('/users/$uid');
    expect(denial.matchedRule).toBe('auth.uid == $uid');

    const opEvents = sandbox
      .history()
      .filter((e): e is SandboxOperationEvent => e.kind === 'operation' && e.service === 'rtdb' && e.method === 'update');
    expect(opEvents).toHaveLength(1);
    expect(opEvents[0]!.path).toBe('/users/bob/score');
    expect(opEvents[0]!.result).toBe('deny');
  });

  it('checks .write across all paths ahead of .validate during onDisconnect.update registration', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(db, {
      rules: {
        users: {
          $uid: {
            '.write': 'auth.uid == $uid',
            score: {
              '.validate': 'newData.isNumber()',
            },
          },
        },
      },
    });

    let caught: unknown;
    try {
      await onDisconnect(ref(db)).update({
        'users/alice/name': 'Alice',
        'users/bob/score': 'not-a-number',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const denial = contextOf(caught);
    expect(denial.request.path).toBe('/users/bob/score');
    expect(denial.matchedPath).toBe('/users/$uid');
    expect(denial.matchedRule).toBe('auth.uid == $uid');
  });

  it('prefers a confirmed .write DENY on a sibling path over an earlier UNSUPPORTED .write', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(db, {
      rules: {
        orgs: {
          alpha: {
            '.write': 'unknownHelper()',
          },
          beta: {
            '.write': 'auth.uid == "owner"',
          },
        },
      },
    });

    let caught: unknown;
    try {
      await update(ref(db), {
        'orgs/alpha/status': 'active',
        'orgs/beta/status': 'active',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const denial = contextOf(caught);
    expect(denial.request.path).toBe('/orgs/beta/status');
    expect(denial.matchedPath).toBe('/orgs/beta');
    expect(denial.matchedRule).toBe('auth.uid == "owner"');

    const opEvents = sandbox
      .history()
      .filter((e): e is SandboxOperationEvent => e.kind === 'operation' && e.service === 'rtdb' && e.method === 'update');
    expect(opEvents).toHaveLength(1);
    expect(opEvents[0]!.path).toBe('/orgs/beta/status');
    expect(opEvents[0]!.result).toBe('deny');
  });

  it('prefers a confirmed .validate denial on a sibling path over an earlier unsupported .write', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(db, {
      rules: {
        orgs: {
          alpha: {
            '.write': 'unknownHelper()',
          },
          beta: {
            '.write': true,
            score: {
              '.validate': 'newData.isNumber()',
            },
          },
        },
      },
    });

    let caught: unknown;
    try {
      await update(ref(db), {
        'orgs/alpha/status': 'active',
        'orgs/beta/score': 'not-a-number',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const denial = contextOf(caught);
    expect(denial.request.path).toBe('/orgs/beta/score');
    expect(denial.matchedPath).toBe('/orgs/beta/score');
    expect(denial.matchedRule).toBe('newData.isNumber()');

    const opEvents = sandbox
      .history()
      .filter((e): e is SandboxOperationEvent => e.kind === 'operation' && e.service === 'rtdb' && e.method === 'update');
    expect(opEvents).toHaveLength(1);
    expect(opEvents[0]!.path).toBe('/orgs/beta/score');
    expect(opEvents[0]!.result).toBe('deny');
  });
});

describe('RTDB replay rewind ancestor priority preservation', () => {
  it('restores ancestor .priority metadata when rewinding a child removal that auto-trimmed the ancestor', async () => {
    const rules = {
      rules: {
        items: {
          $itemId: {
            '.write': 'auth != null',
          },
        },
        audits: {
          $auditId: {
            '.write': "root.child('items/item-1').getPriority() == 10",
          },
        },
      },
    };

    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox);
    rtdbSandbox.setRules(adminDb, rules);
    rtdbSandbox.setData(adminDb, {
      '/items/item-1': { label: 'alpha', '.priority': 10 },
    });

    const userDb = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    // Succeeds during capture because /items/item-1 has .priority == 10
    await set(ref(userDb, '/audits/a1'), { ok: true });
    // Removing the only child auto-trims /items/item-1 and clears its priority
    await remove(ref(userDb, '/items/item-1/label'));

    const events = sandbox.history();
    const capturedState = rtdbSandbox.snapshotState(adminDb);

    const result = await replayRtdb(events, {
      rules,
      capturedState,
    });

    expect(result.divergences).toEqual([]);
  });
});

describe('RTDB update() trailing /.priority paths', () => {
  it('updates and clears node priority via trailing /.priority keys without clobbering value or matching $wildcard', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(db, {
      rules: {
        items: {
          '.read': true,
          a: {
            '.write': 'auth != null',
            '.validate':
              'newData.isString() && (newData.getPriority() == null || newData.getPriority() >= 0)',
            $other: {
              '.write': false,
              '.validate': false,
            },
          },
        },
      },
    });

    await setWithPriority(ref(db, 'items/a'), 'hello', 5);

    await update(ref(db, 'items'), { 'a/.priority': 20 });
    const afterSetPriority = await get(ref(db, 'items/a'));
    expect(afterSetPriority.val()).toBe('hello');
    expect(afterSetPriority.priority).toBe(20);
    expect(afterSetPriority.exportVal()).toEqual({ '.value': 'hello', '.priority': 20 });
    expect(rtdbSandbox.snapshotState(db)).toEqual({ items: { a: 'hello' } });

    await update(ref(db, 'items/a'), { '.priority': null });
    const afterClearPriority = await get(ref(db, 'items/a'));
    expect(afterClearPriority.val()).toBe('hello');
    expect(afterClearPriority.priority).toBeNull();
    expect(afterClearPriority.exportVal()).toBe('hello');
    expect(rtdbSandbox.snapshotState(db)).toEqual({ items: { a: 'hello' } });
  });

  it('enforces .validate against trailing /.priority and preserved ancestor priority regardless of update key order', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox);
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(db, {
      rules: {
        items: {
          '.read': true,
          $id: {
            '.write': 'auth != null',
            '.validate': 'newData.getPriority() == null || newData.getPriority() >= 0',
          },
        },
      },
    });

    // 1. Trailing /.priority listed before sibling child creation on a new node must not fail open
    let orderOneCaught: unknown;
    try {
      await update(ref(db, 'items'), { 'a/.priority': -999, 'a/title': 'hello' });
    } catch (err) {
      orderOneCaught = err;
    }
    expect(orderOneCaught).toBeInstanceOf(Error);
    expect(await get(ref(db, 'items/a')).then((s) => s.exists())).toBe(false);

    // 2. Sibling child deletion listed before sibling child addition under a negatively prioritized object must not transiently wipe priority and fail open
    rtdbSandbox.setData(adminDb, {
      '/items/existing': { old: 1, '.priority': -999 },
    });
    let siblingOrderCaught: unknown;
    try {
      await update(ref(db, 'items'), { 'existing/old': null, 'existing/title': 'hello' });
    } catch (err) {
      siblingOrderCaught = err;
    }
    expect(siblingOrderCaught).toBeInstanceOf(Error);
    expect((await get(ref(db, 'items/existing'))).exportVal()).toEqual({ old: 1, '.priority': -999 });

    // 3. Valid positive /.priority listed before sibling child creation succeeds and persists priority
    await update(ref(db, 'items'), { 'valid/.priority': 20, 'valid/title': 'hello' });
    expect((await get(ref(db, 'items/valid'))).exportVal()).toEqual({ title: 'hello', '.priority': 20 });

    // 4. Clearing /.priority with null alongside sibling child updates clears priority in either key order
    await update(ref(db, 'items'), { 'existing/.priority': null, 'existing/old': null, 'existing/title': 'hello' });
    expect((await get(ref(db, 'items/existing'))).exportVal()).toEqual({ title: 'hello' });
  });
});
