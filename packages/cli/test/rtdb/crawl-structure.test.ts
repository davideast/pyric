import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setData } from 'pyric/sandbox/database';

import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';

describe('query_sandbox_data and resources/read (database)', () => {
  test('queries the root tree and reads a subtree resource', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);
    setData(sandbox, {
      '/users/alice': { active: true, name: 'Alice' },
      '/users/bob': { active: false, name: 'Bob' },
      '/version': 3,
    });

    const result = await dispatch('query_sandbox_data', {
      service: 'database',
      path: '/',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        count: 1,
        results: [
          {
            path: '',
            data: {
              users: {
                alice: { active: true, name: 'Alice' },
                bob: { active: false, name: 'Bob' },
              },
              version: 3,
            },
          },
        ],
      },
    });
  });

  test('reads a subtree via pyric://database/tree/{path}', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);
    setData(sandbox, {
      '/groups/beta': { owner: 'bob', users: { bob: true } },
      '/groups/alpha': { owner: 'alice', users: { alice: true } },
    });

    const result = await dispatch('resources/read', {
      uri: 'pyric://database/tree/groups/alpha',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: '/groups/alpha',
        exists: true,
        value: {
          owner: 'alice',
          users: { alice: true },
        },
      },
    });
  });
});
