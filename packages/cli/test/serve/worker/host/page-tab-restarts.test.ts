import { describe, expect, it } from 'bun:test';
import { SERVICE_WORKER_TAB_ID } from '../../../../src/serve/worker/host/caller.js';
import {
  MAX_TAB_ID_LENGTH,
  claimPageTab,
  closePageTab,
  forgetPageTab,
  isTrackablePageTabId,
  resumePageTab,
} from '../../../../src/serve/worker/host/page-tab-restarts.js';
import type { HostCtx, PortLike } from '../../../../src/serve/worker/host-context.js';

function fakePort(): PortLike {
  return { postMessage() {} };
}

describe('page-tab-restarts', () => {
  it('ignores empty, oversized, and service-worker tabIds', () => {
    const ctx = {} as HostCtx;
    const port = fakePort();

    expect(isTrackablePageTabId('')).toBe(false);
    expect(isTrackablePageTabId('x'.repeat(MAX_TAB_ID_LENGTH + 1))).toBe(false);
    expect(isTrackablePageTabId(SERVICE_WORKER_TAB_ID)).toBe(false);
    expect(isTrackablePageTabId('tab-1234')).toBe(true);

    expect(claimPageTab(ctx, port, '')).toEqual([]);
    expect(claimPageTab(ctx, port, SERVICE_WORKER_TAB_ID)).toEqual([]);
  });

  it('sweeps an interrupted tab port when the reloaded tab claims the same tabId', () => {
    const ctx = {} as HostCtx;
    const oldTab = fakePort();
    const reloadedTab = fakePort();

    expect(claimPageTab(ctx, oldTab, 'tab-reload-1')).toEqual([]);
    expect(closePageTab(ctx, oldTab)).toEqual([]);
    expect(claimPageTab(ctx, reloadedTab, 'tab-reload-1')).toEqual([oldTab]);

    expect(closePageTab(ctx, reloadedTab)).toEqual([]);
    resumePageTab(ctx, reloadedTab);
    forgetPageTab(ctx, reloadedTab);
  });
});
