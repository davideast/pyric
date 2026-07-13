import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setData } from 'pyric/sandbox/database';

import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';

describe('rtdb_crawl_structure', () => {
  test('describes the current local tree without returning leaf values', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);
    setData(sandbox, {
      '/users/alice': { active: true, name: 'Alice' },
      '/users/bob': { active: false, name: 'Bob' },
      '/version': 3,
    });

    const result = await dispatch('rtdb_crawl_structure', {});

    expect(result).toEqual({
      ok: true,
      summary: 'Crawled 3 object paths from /',
      data: {
        path: '/',
        childCount: 2,
        truncated: false,
        schema: { version: 'number' },
        children: [
          {
            path: '/users',
            childCount: 2,
            truncated: false,
            schema: {},
            children: [
              {
                path: '/users/alice',
                childCount: 2,
                truncated: false,
                schema: { active: 'boolean', name: 'string' },
                children: [],
              },
              {
                path: '/users/bob',
                childCount: 2,
                truncated: false,
                schema: { active: 'boolean', name: 'string' },
                children: [],
              },
            ],
          },
        ],
      },
    });
  });

  test('selects a subtree and reports depth and child truncation', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);
    setData(sandbox, {
      '/groups/beta': { owner: 'bob', users: { bob: true } },
      '/groups/alpha': { owner: 'alice', users: { alice: true } },
    });

    const result = await dispatch('rtdb_crawl_structure', {
      path: '/groups',
      maxDepth: 1,
      maxChildren: 1,
    });

    expect(result).toEqual({
      ok: true,
      summary: 'Crawled 1 object paths from /groups',
      data: {
        path: '/groups',
        childCount: 2,
        truncated: true,
        schema: {},
        children: [
          {
            path: '/groups/alpha',
            childCount: 2,
            truncated: true,
            schema: { owner: 'string' },
            children: [],
          },
        ],
      },
    });
  });
});
