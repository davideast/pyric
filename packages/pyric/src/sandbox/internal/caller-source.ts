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
  admin: 'Node process, Admin SDK',
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

/**
 * One client: a browser profile (`page`), a service worker realm, or one Node
 * process. Keyed by kind and id together, since a page may declare an id that
 * reads like a Node journey id, and a service worker never shares its pages'
 * id. This is the profile id a host stamps on `caller.clientId`, not the
 * per-page id the worker's presence list keys by.
 */
export interface ScopeClient {
  kind: EventCaller['kind'];
  clientId: string;
}

/**
 * Which events a view counts: every event, one client's, one user's (a uid,
 * or `null` for signed-out calls), or one user's on one client.
 */
export type EventScope =
  | 'all'
  | { client: ScopeClient; user?: undefined }
  | { client?: undefined; user: string | null }
  | { client: ScopeClient; user: string | null };

/** The fields of an event a scope reads. */
export interface ScopedEventFields {
  caller?: EventCaller;
  auth?: { uid: string } | null;
}

function isFromClient(event: ScopedEventFields, client: ScopeClient): boolean {
  const caller = event.caller;
  if (caller?.clientId === undefined) return false;
  return caller.kind === client.kind && caller.clientId === client.clientId;
}

/** `null` names a signed-out call; an event with no auth field is neither. */
function isFromUser(event: ScopedEventFields, user: string | null): boolean {
  if (event.auth === undefined) return false;
  const uid = event.auth === null ? null : event.auth.uid;
  return uid === user;
}

/** Whether `event` belongs to `scope`. The chip and Studio share this rule. */
export function eventScope(event: ScopedEventFields, scope: EventScope): boolean {
  if (scope === 'all') return true;
  const clientMatches = scope.client === undefined || isFromClient(event, scope.client);
  const userMatches = scope.user === undefined || isFromUser(event, scope.user);
  return clientMatches && userMatches;
}
