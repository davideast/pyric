/**
 * Which browser page connections are reloads of one tab, so the host sweeps an
 * interrupted prior document's reported listeners as soon as the reloaded tab
 * reconnects with the same `tabId`.
 */
import type { HostCtx, PortLike } from '../host-context.js';
import { SERVICE_WORKER_TAB_ID } from './caller.js';
import { createClientRunTracker } from './client-run-tracker.js';

/** Maximum accepted `tabId` length when tracking browser tab restarts. */
export const MAX_TAB_ID_LENGTH = 64;

const PAGE_TABS = createClientRunTracker();

/** Whether `tabId` names an ordinary browser tab rather than an empty, oversized, or service-worker id. */
export function isTrackablePageTabId(tabId: string): boolean {
  return tabId !== '' && tabId.length <= MAX_TAB_ID_LENGTH && tabId !== SERVICE_WORKER_TAB_ID;
}

/** Record that `port` belongs to browser `tabId`; returns interrupted earlier ports of that tab to sweep. */
export function claimPageTab(ctx: HostCtx, port: PortLike, tabId: string): PortLike[] {
  if (!isTrackablePageTabId(tabId)) return [];
  return PAGE_TABS.claim(ctx, port, tabId);
}

/** Record that page `port` closed; returns interrupted earlier ports of its tab when a reloaded port is open. */
export function closePageTab(ctx: HostCtx, port: PortLike): PortLike[] {
  return PAGE_TABS.close(ctx, port);
}

/** Record that page `port` resumed its retained session. */
export function resumePageTab(ctx: HostCtx, port: PortLike): void {
  PAGE_TABS.resume(ctx, port);
}

/** Forget page `port` once the host ends it. */
export function forgetPageTab(ctx: HostCtx, port: PortLike): void {
  PAGE_TABS.forget(ctx, port);
}
