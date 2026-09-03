import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setData, setRules } from 'pyric/sandbox/database';

import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';

describe('database_rules.simulate', () => {
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

    const denied = await dispatch('database_rules', 'simulate', {
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

    const allowed = await dispatch('database_rules', 'simulate', {
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
});
