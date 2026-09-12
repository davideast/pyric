/**
 * Where a listener was attached, per attach (feature: Listeners).
 *
 * PURE. The fold in `active-listeners.ts` answers what is attached now, one
 * entry per listener id; an incident is about the attaches themselves, so the
 * lines under it are read off the attach events instead. Each attach states
 * two things worth listing: the application line that opened it, and the
 * element its owners identified.
 *
 * A duplicate's members share a target and an owner, which is exactly the
 * match this module filters on.
 */

import type { ActiveListenerTarget, ListenerOwner, SandboxEvent } from 'pyric/sandbox';
import { elementLabel } from './listener-element.js';
import {
  formatListenerTarget,
  frameOwnerOf,
  ownerLabelFor,
} from './listener-groups.js';

/** One attach of one listener. */
export interface AttachSite {
  readonly at: number;
  /** `src/ui/chat/chat-page.tsx:318`, when the attach recorded a frame. */
  readonly frame?: string;
  /** `nav#conversations`, when the owners identified an element. */
  readonly element?: string;
}

/** The target and owners one attach event carries, or nothing when the event
 *  is not a listener attach. */
function attachOf(
  event: SandboxEvent,
): { target: ActiveListenerTarget; owners?: readonly ListenerOwner[] } | null {
  const owners = 'owners' in event && Array.isArray(event.owners) ? event.owners : undefined;
  if (event.kind === 'listener_attach') {
    const target = event.target as { kind: string; path?: string; collection?: string; query?: unknown };
    if (target.kind === 'doc' && target.path !== undefined) {
      return owners === undefined ? { target: target.path } : { target: target.path, owners };
    }
    const query = { collection: target.collection ?? '', query: target.query };
    return owners === undefined ? { target: query } : { target: query, owners };
  }
  if (event.kind === 'listener' && (event as { phase?: string }).phase === 'attach') {
    const path = (event as { target?: { path?: string } }).target?.path ?? '';
    return owners === undefined ? { target: path } : { target: path, owners };
  }
  return null;
}

/**
 * Every attach that shares one target and one owner, in attach order. The
 * incident block lists one line per entry.
 */
export function attachSites(
  events: readonly SandboxEvent[],
  target: ActiveListenerTarget,
  owner: string,
): readonly AttachSite[] {
  const wanted = formatListenerTarget(target);
  const sites: AttachSite[] = [];
  for (const event of events) {
    const attach = attachOf(event);
    if (attach === null) continue;
    if (formatListenerTarget(attach.target) !== wanted) continue;
    if (ownerLabelFor(attach.owners, attach.target) !== owner) continue;
    const frame = frameOwnerOf(attach.owners);
    const element = elementLabel(attach.owners);
    const site: { at: number; frame?: string; element?: string } = { at: event.at };
    if (frame !== null) site.frame = `${frame.file}:${frame.line}`;
    if (element !== undefined) site.element = element;
    sites.push(Object.freeze(site));
  }
  return Object.freeze(sites);
}
