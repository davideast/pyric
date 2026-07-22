import { describe, expect, it } from 'bun:test';
import { walkForSentinels } from '../../../src/firestore/sandbox/sentinel-capture.js';
import { registerReferenceQueryValue } from '../../../src/firestore/sandbox/query-value-registry.js';

describe('sentinel capture', () => {
  it('treats registered Firestore references as leaves', () => {
    const reference: Record<string, unknown> = { path: 'items/a' };
    reference.runtime = { reference };
    registerReferenceQueryValue(reference, 'items/a', {});

    expect(walkForSentinels({ reference })).toEqual([]);
  });

  it('terminates on cyclic maps while retaining reachable sentinels', () => {
    const value: Record<string, unknown> = {
      updatedAt: { __type: 'serverTimestamp' },
    };
    value.self = value;

    expect(walkForSentinels(value)).toEqual([
      { field: 'updatedAt', kind: 'serverTimestamp' },
    ]);
  });
});
