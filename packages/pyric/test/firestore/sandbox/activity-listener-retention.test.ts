import { describe, expect, it } from 'bun:test';
import {
  releaseActivityListenerBucket,
  releaseOldestActivityListener,
} from '../../../src/firestore/sandbox/activity-listener-retention.js';

describe('activity listener retention', () => {
  it('releases correlations by physical id when page-local logical ids collide', () => {
    const correlations = new Map<string, unknown>([
      ['physical-evicted', { listenerId: 'page-local-id' }],
      ['physical-survivor', { listenerId: 'page-local-id' }],
    ]);

    releaseActivityListenerBucket(
      new Map([['physical-evicted', { id: 'attach-1', at: 1 }]]),
      correlations,
    );

    expect(correlations.has('physical-evicted')).toBe(false);
    expect(correlations.has('physical-survivor')).toBe(true);
  });

  it('evicts the oldest active physical listener and its correlation together', () => {
    const active = new Map<string, unknown>([
      ['physical-oldest', { id: 'attach-1', at: 1 }],
      ['physical-newest', { id: 'attach-2', at: 2 }],
    ]);
    const correlations = new Map<string, unknown>([
      ['physical-oldest', {}],
      ['physical-newest', {}],
    ]);

    expect(releaseOldestActivityListener(active, correlations)).toBe(true);
    expect([...active.keys()]).toEqual(['physical-newest']);
    expect([...correlations.keys()]).toEqual(['physical-newest']);
  });
});
