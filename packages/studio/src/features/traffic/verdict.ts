/**
 * Traffic verdicts (specs/traffic.md, MVP slice): derive each row's rules
 * verdict from fields the event stream ALREADY carries — no pipeline or
 * simulator work.
 *
 *   allow  rules evaluated and allowed
 *   deny   rules evaluated and denied
 *   bypassed  rules BYPASSED (currently by an admin lens)
 *   null   Rules not evaluated (no rules / unsupported / runtime op) — blank cell
 *
 * PURE: mapping + filtering + identity formatting only; the surface renders.
 */

import type { OperationContext, RulesDisposition } from 'pyric/sandbox';
import type { TrafficEvent } from '@pyric/ui/traffic';
import type { CommandTarget } from '../home/command.js';

/** A traffic event as Studio's adapter emits it: the library shape plus the
 * canonical context and Rules disposition normalized by the sandbox recorder.
 * Studio source is stamped mechanically at the issuing call site, never
 * inferred from the operation shape. */
export type StudioTrafficEvent = TrafficEvent & {
  operationContext: OperationContext;
  rulesDisposition: RulesDisposition;
};

/** Was this op issued by Pyric Studio itself (data viewers/editors, the
 * typeahead index, seed actions)? Source is independent of the auth lens. */
export function isStudioTraffic(event: Pick<StudioTrafficEvent, 'operationContext'>): boolean {
  return event.operationContext.source.kind === 'studio';
}

/** Drop Studio-issued events when `hide` is on (pure; `hide: false` is a
 *  pass-through copy so callers can treat the result uniformly). */
export function filterStudioTraffic<E extends Pick<StudioTrafficEvent, 'operationContext'>>(
  events: readonly E[],
  hide: boolean,
): E[] {
  return hide ? events.filter((e) => !isStudioTraffic(e)) : [...events];
}

export type TrafficVerdict = 'allow' | 'deny' | 'bypassed' | null;

/** The filter positions, `all` plus each real verdict. */
export type VerdictFilter = 'all' | 'allow' | 'deny' | 'bypassed';

export const VERDICT_FILTERS: readonly VerdictFilter[] = ['all', 'allow', 'deny', 'bypassed'];

/**
 * Derive the verdict from the recorder's Rules disposition. Source and auth
 * lens are intentionally irrelevant here.
 */
export function verdictFor(event: {
  rulesDisposition: RulesDisposition;
}): TrafficVerdict {
  if (event.rulesDisposition.kind === 'bypassed') return 'bypassed';
  if (event.rulesDisposition.kind === 'evaluated') {
    return event.rulesDisposition.verdict;
  }
  return null;
}

/** Apply the verdict filter (`all` passes everything, including blanks). */
export function filterByVerdict<E extends { rulesDisposition: RulesDisposition }>(
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
  operationContext: OperationContext;
}): string {
  const lens = event.operationContext.authLens;
  switch (lens.mode) {
    case 'admin':
      return 'admin (rules bypassed)';
    case 'as':
      return `as ${lens.uid}`;
    case 'anon':
      return 'anonymous';
    case 'app-session':
      break;
  }
  return event.auth?.uid ? event.auth.uid : 'anonymous';
}

/** The reasons to show in a deny disclosure: the event's simulator reasoning
 *  lines (the same lines `denialContext.reasons` carries over the wire). */
export function denialReasons(event: { reasons?: readonly string[] }): string[] {
  return (event.reasons ?? []).filter((r) => r.trim() !== '');
}

/**
 * Row-click semantics: does this row open the RULES INSPECTOR in place?
 * True for rules-EVALUATED ops only (verdict allow or deny — there is a rules
 * decision to inspect). Admin-bypass rows (rules never ran) and blank-verdict
 * rows (non-rule ops) keep their subject navigation instead.
 */
export function opensRulesInspector(event: {
  rulesDisposition: RulesDisposition;
}): boolean {
  return event.rulesDisposition.kind === 'evaluated';
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
 *             → /storage/<path>?kind=prefix (listed prefix)
 *   auth      → /auth/<uid>           (`path` carries the uid; `*` = clear-all,
 *                                      not addressable)
 */
export function subjectTarget(event: {
  service?: StudioTrafficEvent['service'];
  method: StudioTrafficEvent['method'];
  path: string;
}): CommandTarget | null {
  const path = event.path;
  if (
    event.service === 'storage' &&
    event.method === 'list' &&
    (path === '' || path === '/')
  ) {
    return { tab: 'storage' };
  }
  if (!path || path === '(service)') return null;
  const rest = path.split('/').filter(Boolean);
  switch (event.service ?? 'firestore') {
    case 'firestore':
      return rest.length ? { tab: 'firestore', rest } : null;
    case 'rtdb':
      return { tab: 'rtdb' };
    case 'storage':
      return rest.length
        ? {
            tab: 'storage',
            rest,
            ...(event.method === 'list' ? { query: { kind: 'prefix' } } : {}),
          }
        : null;
    case 'auth':
      return path !== '*' ? { tab: 'auth', rest: [path] } : null;
    default:
      return null;
  }
}
