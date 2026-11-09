import { describe, expect, it } from 'bun:test';
import type { ObservedCall } from 'pyric/sandbox';
import { unionPaths, verdictOf } from '../../../../src/serve/worker/host/observe-local-evaluation.js';

const BASE_CALL: ObservedCall = {
  service: 'rtdb',
  method: 'get',
  path: '/items/item-1',
  at: 1_700_000_000_000,
  outcome: { status: 'ok' },
  account: { uid: 'u-1' },
};

describe('observe-local-evaluation (#2540)', () => {
  it('sorts and deduplicates missingPaths while ignoring blanks (#2540 F7)', () => {
    expect(unionPaths(['/items/c', '', '/items/a'], ['/items/b', '/items/a'])).toEqual([
      '/items/a',
      '/items/b',
      '/items/c',
    ]);
  });

  it('attaches bounded missingPaths to unevaluated verdicts and omits empty lists', () => {
    const withPaths = verdictOf(BASE_CALL, {
      allowed: false,
      rule: { path: '/items/$id', expression: "root.child('flags/open').val() === true" },
      needs: ['stored-document'],
      missingPaths: ['/flags/open', '/flags/open'],
    });
    expect(withPaths).toEqual({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/flags/open'],
      rule: { path: '/items/$id', expression: "root.child('flags/open').val() === true" },
    });

    const withoutPaths = verdictOf(BASE_CALL, {
      allowed: false,
      rule: undefined,
      needs: ['query'],
      missingPaths: [],
    });
    expect(withoutPaths).toEqual({
      result: 'unevaluated',
      needs: ['query'],
    });
  });
});
