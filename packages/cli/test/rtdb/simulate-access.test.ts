import { describe, expect, test } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { setData, setRules } from 'pyric/sandbox/database';

import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';

describe('rtdb_simulate_access', () => {
  test('uses the sandbox current rules and data on every call', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);
    setData(sandbox, {
      '/members/alice': true,
      '/notes/n1': { title: 'Before', owner: 'alice' },
    });

    setRules(sandbox, {
      rules: {
        notes: {
          '$noteId': {
            '.write': "root.child('members').child(auth.uid).val() == true",
            '.validate': "newData.hasChildren(['title', 'owner'])",
          },
        },
      },
    });

    const denied = await dispatch('rtdb_simulate_access', {
      operation: 'write',
      path: '/notes/n1',
      auth: { uid: 'alice' },
      newData: { title: 'Missing owner' },
    });
    expect(denied).toMatchObject({
      ok: true,
      data: { decision: 'DENY' },
    });

    setRules(sandbox, {
      rules: {
        notes: {
          '$noteId': {
            '.write': "root.child('members').child(auth.uid).val() == true",
            '.validate': "newData.hasChild('title')",
          },
        },
      },
    });

    const allowed = await dispatch('rtdb_simulate_access', {
      operation: 'write',
      path: '/notes/n1',
      auth: { uid: 'alice' },
      newData: { title: 'Still a simulation' },
    });
    expect(allowed).toMatchObject({
      ok: true,
      data: { decision: 'ALLOW' },
    });
  });

  test('evaluates now at the sandbox clock when the call names no instant', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);
    // Open only before 2025, so the wall clock this suite runs on is shut out
    // and a pin before the deadline is the only thing that opens the gate.
    setRules(sandbox, { rules: { notes: { '.write': 'now < 1735689600000' } } });

    getClock(sandbox).set(Date.UTC(2031, 0, 1));
    const shut = await dispatch('rtdb_simulate_access', {
      operation: 'write',
      path: '/notes',
      auth: { uid: 'alice' },
      newData: { title: 'Too late' },
    });
    expect(shut).toMatchObject({ ok: true, data: { decision: 'DENY' } });

    getClock(sandbox).set(Date.UTC(2020, 0, 1));
    const open = await dispatch('rtdb_simulate_access', {
      operation: 'write',
      path: '/notes',
      auth: { uid: 'alice' },
      newData: { title: 'In time' },
    });
    expect(open).toMatchObject({ ok: true, data: { decision: 'ALLOW' } });
  });

  test('evaluates an explicit now without reading the sandbox clock', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);
    setRules(sandbox, { rules: { notes: { '.write': 'now < 1735689600000' } } });
    getClock(sandbox).set(Date.UTC(2031, 0, 1));

    const open = await dispatch('rtdb_simulate_access', {
      operation: 'write',
      path: '/notes',
      auth: { uid: 'alice' },
      newData: { title: 'In time' },
      now: Date.UTC(2020, 0, 1),
    });

    expect(open).toMatchObject({ ok: true, data: { decision: 'ALLOW' } });
  });
});

describe('rtdb_simulate_access case kinds', () => {
  const rules = {
    rules: {
      '.read': false,
      '.write': false,
      score: { '.write': 'auth != null', '.validate': 'newData.isNumber()' },
      totals: {
        '.write': 'auth != null',
        '.validate': "newData.val() == newData.parent().child('score').val() + 1",
      },
      items: { '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid" },
    },
  };
  const alice = { uid: 'alice' };

  test('a scalar newData is evaluated', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, rules);
    const dispatch = buildSandboxDispatcher(sandbox);
    const ok = await dispatch('rtdb_simulate_access', { operation: 'write', path: '/score', auth: alice, newData: 5 });
    expect(ok).toMatchObject({ ok: true, data: { decision: 'ALLOW' } });
    const bad = await dispatch('rtdb_simulate_access', { operation: 'write', path: '/score', auth: alice, newData: 'x' });
    expect(bad).toMatchObject({ ok: true, data: { decision: 'DENY' } });
  });

  test('an update evaluates every written path together', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, rules);
    const dispatch = buildSandboxDispatcher(sandbox);
    const ok = await dispatch('rtdb_simulate_access', {
      operation: 'update', path: '/', auth: alice, newData: { score: 4, totals: 5 },
    });
    expect(ok).toMatchObject({ ok: true, data: { decision: 'ALLOW' } });
    const bad = await dispatch('rtdb_simulate_access', {
      operation: 'update', path: '/', auth: alice, newData: { score: 4, totals: 9 },
    });
    expect(bad).toMatchObject({ ok: true, data: { decision: 'DENY', matchedPath: '/totals' } });
  });

  test('a read carries its query to query.* rules', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, rules);
    const dispatch = buildSandboxDispatcher(sandbox);
    const ok = await dispatch('rtdb_simulate_access', {
      operation: 'read', path: '/items', auth: alice, query: { orderByChild: 'owner', equalTo: 'alice' },
    });
    expect(ok).toMatchObject({ ok: true, data: { decision: 'ALLOW' } });
    const bare = await dispatch('rtdb_simulate_access', { operation: 'read', path: '/items', auth: alice });
    expect(bare).toMatchObject({ ok: true, data: { decision: 'DENY' } });
  });
});
