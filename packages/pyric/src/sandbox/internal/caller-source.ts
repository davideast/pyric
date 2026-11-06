/**
 * The one reading of an event's `caller` that every traffic view shares: the
 * runtime chip's Traffic panel and Studio label a row with the same words.
 */
import type { EventCaller } from '../types/operation.js';

/**
 * Who sent a row's request, as a view reads it. `page` and `tab` split a
 * page caller by whether it is the viewing page; a view that is not a page
 * (Studio) reads every page as `page`. `unknown` is an event no host stamped.
 */
export type CallerSource = 'page' | 'tab' | 'node' | 'admin' | 'mcp' | 'studio' | 'service-worker' | 'unknown';

/** A row label for each source. */
export const CALLER_SOURCE_LABELS: Readonly<Record<CallerSource, string>> = Object.freeze({
  page: 'This page',
  tab: 'Other tab',
  node: 'Node process',
  admin: 'Server (admin)',
  mcp: 'MCP',
  studio: 'Studio',
  'service-worker': 'Service worker',
  unknown: 'Unknown source',
});

/**
 * A row label for a view that is not a page, such as Studio. Studio is not
 * the page, so a page's row reads `App page` there.
 */
export function callerSourceLabelOutsidePage(source: CallerSource): string {
  return source === 'page' ? 'App page' : CALLER_SOURCE_LABELS[source];
}

/**
 * The source of an event sent by `caller`, as the page whose id is
 * `viewerPageId` reads it. Without a viewer id, every page reads as `page`.
 */
export function callerSource(caller: EventCaller | undefined, viewerPageId?: string): CallerSource {
  if (caller === undefined) return 'unknown';
  if (caller.kind !== 'page') return caller.kind;
  const isOtherPage = viewerPageId !== undefined && caller.pageId !== viewerPageId;
  return isOtherPage ? 'tab' : 'page';
}
