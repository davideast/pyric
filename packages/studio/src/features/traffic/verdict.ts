/**
 * Traffic verdicts (specs/traffic.md, MVP slice): derive each row's rules
 * verdict from fields the event stream ALREADY carries — no pipeline or
 * simulator work.
 *
 *   allow  rules evaluated and allowed
 *   deny   rules evaluated and denied
 *   admin  rules BYPASSED (admin lens / admin origin)
 *   null   non-rule op (not-applicable / unsupported / error) — blank cell
 *
 * PURE: mapping + filtering + identity formatting only; the surface renders.
 */

import type { AuthLens } from 'pyric/sandbox';
import type { TrafficEvent } from '@pyric/ui/traffic';
import type { CommandTarget } from '../home/command.js';

/** A traffic event as Studio's adapter emits it: the library shape plus the
 *  provenance every `SandboxEvent` may carry (additive, optional). `actor`
 *  is stamped MECHANICALLY at the issuing call site (Studio's worker client
 *  declares `issuer: 'studio'`; the worker host maps it onto the event via
 *  the sandbox's ambient-provenance window) — never inferred from the op's
 *  shape, so a user's own admin-SDK traffic through the remote bridge is
 *  never classified as Studio's. */
export type StudioTrafficEvent = TrafficEvent & {
  authLens?: AuthLens;
  actor?: { kind?: string; name?: string };
};

/** Was this op issued by Pyric Studio itself (data viewers/editors, the
 *  typeahead index, seed actions)? Provenance-stamped events only — an
 *  absent `actor` means the served app (or a pre-provenance emitter) and is
 *  never hidden. */
export function isStudioTraffic(event: { actor?: { kind?: string } }): boolean {
  return event.actor?.kind === 'studio';
}

/** Drop Studio-issued events when `hide` is on (pure; `hide: false` is a
 *  pass-through copy so callers can treat the result uniformly). */
export function filterStudioTraffic<E extends { actor?: { kind?: string } }>(
  events: readonly E[],
  hide: boolean,
): E[] {
  return hide ? events.filter((e) => !isStudioTraffic(e)) : [...events];
}

export type TrafficVerdict = 'allow' | 'deny' | 'admin' | null;

/** The filter positions, `all` plus each real verdict. */
export type VerdictFilter = 'all' | 'allow' | 'deny' | 'admin';

export const VERDICT_FILTERS: readonly VerdictFilter[] = ['all', 'allow', 'deny', 'admin'];

/**
 * Derive the verdict. Admin wins first: an op under the admin lens (or with
 * `origin: 'admin'`) never evaluated rules, so its `allow` result is a bypass,
 * not a rules verdict.
 */
export function verdictFor(event: {
  result: StudioTrafficEvent['result'];
  origin?: StudioTrafficEvent['origin'];
  authLens?: AuthLens;
}): TrafficVerdict {
  if (event.authLens?.mode === 'admin' || event.origin === 'admin') return 'admin';
  if (event.result === 'deny') return 'deny';
  if (event.result === 'allow') return 'allow';
  return null; // not-applicable / unsupported / error → not a rules op
}

/** Apply the verdict filter (`all` passes everything, including blanks). */
export function filterByVerdict<E extends { result: StudioTrafficEvent['result']; origin?: StudioTrafficEvent['origin']; authLens?: AuthLens }>(
  events: readonly E[],
  filter: VerdictFilter,
): E[] {
  if (filter === 'all') return [...events];
  return events.filter((e) => verdictFor(e) === filter);
}

/**
 * The acting identity for a row's disclosure: the lens when one was pinned
 * (impersonation / admin / anon), else the op's auth state.
 */
export function actingIdentity(event: {
  auth: StudioTrafficEvent['auth'];
  authLens?: AuthLens;
}): string {
  const lens = event.authLens;
  if (lens) {
    switch (lens.mode) {
      case 'admin':
        return 'admin (rules bypassed)';
      case 'as':
        return `as ${lens.uid}`;
      case 'anon':
        return 'anonymous';
      case 'app-session':
        break; // fall through to the op's auth state
    }
  }
  return event.auth?.uid ? event.auth.uid : 'anonymous';
}

/** The reasons to show in a deny disclosure: the event's simulator reasoning
 *  lines (the same lines `denialContext.reasons` carries over the wire). */
export function denialReasons(event: { reasons?: readonly string[] }): string[] {
  return (event.reasons ?? []).filter((r) => r.trim() !== '');
}

/**
 * The route of the record a traffic row touched — the row's navigation
 * semantic (C3 drill-in: detail belongs to the owning surface). Null when
 * nothing addressable exists (service-level ops, the `(service)` path
 * placeholder the operation adapter writes when an op has no path).
 *
 *   firestore → /firestore/<path>     (doc or collection)
 *   rtdb      → /rtdb                 (the viewer's path is component state —
 *                                      N4 gap: no path deep-link yet)
 *   storage   → /storage/<path>       (object path)
 *   auth      → /auth/<uid>           (`path` carries the uid; `*` = clear-all,
 *                                      not addressable)
 */
export function subjectTarget(event: {
  service?: StudioTrafficEvent['service'];
  path: string;
}): CommandTarget | null {
  const path = event.path;
  if (!path || path === '(service)') return null;
  const rest = path.split('/').filter(Boolean);
  switch (event.service ?? 'firestore') {
    case 'firestore':
      return rest.length ? { tab: 'firestore', rest } : null;
    case 'rtdb':
      return { tab: 'rtdb' };
    case 'storage':
      return rest.length ? { tab: 'storage', rest } : null;
    case 'auth':
      return path !== '*' ? { tab: 'auth', rest: [path] } : null;
    default:
      return null;
  }
}
