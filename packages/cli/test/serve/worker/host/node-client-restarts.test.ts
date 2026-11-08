import { describe, expect, it } from 'bun:test';
import {
  claimNodeClient,
  closeNodeClient,
  forgetNodeClient,
  resumeNodeClient,
} from '../../../../src/serve/worker/host/node-client-restarts.js';
import type { HostCtx, PortLike } from '../../../../src/serve/worker/host-context.js';

function fakePort(): PortLike {
  return { postMessage() {} };
}

describe('node-client-restarts', () => {
  it('returns closed earlier runs of a restarted Node client label and honours resume/forget', () => {
    const ctx = {} as HostCtx;
    const run1 = fakePort();
    const run2 = fakePort();

    expect(claimNodeClient(ctx, run1, 'proj:server.ts')).toEqual([]);
    expect(closeNodeClient(ctx, run1)).toEqual([]);
    resumeNodeClient(ctx, run1);
    expect(claimNodeClient(ctx, run2, 'proj:server.ts')).toEqual([]);

    expect(closeNodeClient(ctx, run1)).toEqual([run1]);
    forgetNodeClient(ctx, run2);
  });
});
