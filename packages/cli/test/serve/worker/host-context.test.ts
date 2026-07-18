import { describe, expect, it } from 'bun:test';
import {
  activityJourneyId,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host-context.js';

describe('activityJourneyId', () => {
  it('is stable for one port and distinct across ports', () => {
    const ctx = {} as HostCtx;
    const firstPort = { postMessage() {} } satisfies PortLike;
    const secondPort = { postMessage() {} } satisfies PortLike;

    expect(activityJourneyId(ctx, firstPort)).toBe('page-1');
    expect(activityJourneyId(ctx, firstPort)).toBe('page-1');
    expect(activityJourneyId(ctx, secondPort)).toBe('page-2');
  });
});
