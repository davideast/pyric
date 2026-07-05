import { useMemo } from 'react';
import type { TrafficEvent } from '../types.js';

export type TrafficGroupKind = 'batch' | 'transaction' | 'listener-run';

export interface TrafficGroup {
  type: 'group';
  kind: TrafficGroupKind;
  /** `groupId` for batch/transaction; a synthetic key for listener
   *  runs. Stable enough for a React key. */
  key: string;
  events: TrafficEvent[];
  count: number;
  denies: number;
}

export interface TrafficSingle {
  type: 'single';
  event: TrafficEvent;
}

export type TrafficLogItem = TrafficGroup | TrafficSingle;

export interface UseTrafficGroupsOptions {
  events: TrafficEvent[];
  /** Collapse consecutive ops sharing a `groupId`. Default true. */
  groupBatches?: boolean;
  /**
   * Collapse a consecutive run of listener re-evals from the same
   * originating op into one group — the probe found a single write
   * can trigger 250+ re-evals. Default true.
   */
  groupListenerRuns?: boolean;
}

export interface UseTrafficGroupsResult {
  /** Events folded into a flat list of singles and groups, in the
   *  input order. */
  items: TrafficLogItem[];
}

function sameTrigger(a: TrafficEvent, b: TrafficEvent): boolean {
  const ta = a.triggeredBy;
  const tb = b.triggeredBy;
  if (!ta && !tb) return true;
  if (!ta || !tb) return false;
  return ta.method === tb.method && ta.path === tb.path;
}

function makeGroup(
  kind: TrafficGroupKind,
  key: string,
  events: TrafficEvent[],
): TrafficGroup {
  let denies = 0;
  for (const e of events) if (e.result === 'deny') denies++;
  return { type: 'group', kind, key, events, count: events.length, denies };
}

/**
 * Folds a traffic buffer into a list of singles and collapsible
 * groups. Two grouping modes, both over *consecutive* events:
 *
 * - `groupId` — batch/transaction sub-ops sharing an id collapse
 *   into one `batch` / `transaction` group.
 * - listener runs — a consecutive run of listener re-evals from the
 *   same originating op collapses into one `listener-run` group.
 *   A run of length 1 stays a single (no point collapsing one row).
 *
 * Pure derivation; the input order is preserved.
 */
export function useTrafficGroups({
  events,
  groupBatches = true,
  groupListenerRuns = true,
}: UseTrafficGroupsOptions): UseTrafficGroupsResult {
  return useMemo(() => {
    const items: TrafficLogItem[] = [];
    let i = 0;

    while (i < events.length) {
      const event = events[i];

      if (groupBatches && event.groupId) {
        let j = i + 1;
        while (j < events.length && events[j].groupId === event.groupId) j++;
        const run = events.slice(i, j);
        const kind: TrafficGroupKind =
          event.origin === 'transaction' ? 'transaction' : 'batch';
        items.push(makeGroup(kind, event.groupId, run));
        i = j;
        continue;
      }

      if (groupListenerRuns && event.origin === 'listener') {
        let j = i + 1;
        while (
          j < events.length &&
          events[j].origin === 'listener' &&
          !events[j].groupId &&
          sameTrigger(events[j], event)
        ) {
          j++;
        }
        const run = events.slice(i, j);
        if (run.length > 1) {
          const trigger = event.triggeredBy
            ? `${event.triggeredBy.method}:${event.triggeredBy.path}`
            : 'unknown';
          items.push(
            makeGroup('listener-run', `listener-run:${trigger}:${i}`, run),
          );
        } else {
          items.push({ type: 'single', event });
        }
        i = j;
        continue;
      }

      items.push({ type: 'single', event });
      i++;
    }

    return { items };
  }, [events, groupBatches, groupListenerRuns]);
}
