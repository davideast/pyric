/**
 * Report the diagnostic incidents the Firebase activity monitor has raised:
 * a document read repeated past its window, more than one listener attached
 * to the same target from one identity, and a listener attaching and
 * detaching in a burst.
 *
 * Firestore only. The monitor's listener accounting is keyed off Firestore's
 * own lifecycle events (`listener_attach` / `listener_detach` /
 * `listener_errored`), and its actor and target fingerprinting are built
 * around Firestore's document and query shapes; folding the Realtime
 * Database's canonical `listener` events into the same buckets safely is
 * more than this method's bounded scope, so a Realtime Database listener
 * never appears here.
 */
import { z } from 'zod';
import { monitorFirebaseActivity, type ActivityFeed, type ActivityIncident } from 'pyric/firestore/internal';
import type { SandboxEvent } from 'pyric/sandbox';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

const PATTERNS = ['repeated-read', 'duplicate-listener', 'listener-churn'] as const;

/** A feed over one sandbox's already-recorded history. The monitor also asks
 * to subscribe to live events; a read against a fixed snapshot has none to
 * offer, so subscribing here returns immediately and delivers nothing. */
function historyFeed(history: readonly SandboxEvent[]): ActivityFeed {
  return {
    history: () => history,
    subscribe: () => () => {},
  };
}

/** The event ids a `since` cursor makes current: every id at or after it in
 * the sandbox's own event order. */
function idsAtOrAfter(events: readonly SandboxEvent[], since: string): { ids: Set<string> } | null {
  const at = events.findIndex((event) => event.id === since);
  if (at === -1) return null;
  return { ids: new Set(events.slice(at).map((event) => event.id)) };
}

export default {
  tool: 'sandbox',
  method: 'activity',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: `activity(since?, pattern?: ${PATTERNS.join('|')})`,
  description: 'Report Firestore activity incidents: repeated reads, duplicate listeners, listener churn.',
  args: z.object({
    since: z.string().optional().describe('A prior event id; keep only incidents with newer evidence.'),
    pattern: z.enum(PATTERNS).optional(),
  }),
  operation: 'list_sandbox_activity',
  example: {},
  async handler(args, ctx) {
    const since = typeof args.since === 'string' ? args.since : undefined;
    const pattern = typeof args.pattern === 'string' ? args.pattern : undefined;

    const history = ctx.sandbox.history();
    const feed = historyFeed(history);
    const monitor = monitorFirebaseActivity(feed, () => {});
    let incidents: readonly ActivityIncident[];
    try {
      incidents = monitor.report().incidents;
    } finally {
      monitor.dispose();
    }

    if (pattern !== undefined) {
      incidents = incidents.filter((incident) => incident.pattern === pattern);
    }
    if (since !== undefined) {
      const current = idsAtOrAfter(history, since);
      if (current === null) {
        return operationFailure(
          `The sandbox carries no event '${since}'. Either the log was replaced, by a restore or a reset, or the cursor is not one this sandbox handed out. Call activity without 'since' to read every incident the sandbox holds now.`,
        );
      }
      incidents = incidents.filter((incident) =>
        incident.evidenceEventIds.some((id) => current.ids.has(id)),
      );
    }

    return {
      ok: true,
      summary: `${incidents.length} incident(s).`,
      data: { incidents },
    };
  },
} satisfies MethodRecord;
