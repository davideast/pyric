import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setData, setRules } from 'pyric/sandbox/database';

import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';

describe('diagnose_rule_denial (database)', () => {
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

    const denied = await dispatch('diagnose_rule_denial', {
      service: 'database',
      operation: 'write',
      path: '/notes/n1',
      auth: { uid: 'alice' },
      resourceDataJson: JSON.stringify({ title: 'Missing owner' }),
    });
    expect(denied).toMatchObject({
      ok: true,
      data: { allowed: false },
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

    const allowed = await dispatch('diagnose_rule_denial', {
      service: 'database',
      operation: 'write',
      path: '/notes/n1',
      auth: { uid: 'alice' },
      resourceDataJson: JSON.stringify({ title: 'Still a simulation' }),
    });
    expect(allowed).toMatchObject({
      ok: true,
      data: { allowed: true },
    });
  });
});
