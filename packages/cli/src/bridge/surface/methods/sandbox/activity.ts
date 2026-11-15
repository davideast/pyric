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
 * never raises an incident here. Coverage metadata (`examined`, `notExamined`)
 * and the summary state that scope explicitly and report any unexamined
 * service events present in the inspected window.
 */
import { z } from 'zod';
import { monitorFirebaseActivity, type ActivityFeed, type ActivityIncident } from 'pyric/firestore/internal';
import type { SandboxEvent, SandboxOperationEvent } from 'pyric/sandbox';
import {
  formatActivitySummary,
  summarizeActivityCoverage,
} from '../../activity-coverage.js';
import { operationFailure } from '../../sandbox-context.js';
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

function normalizeEventPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (path.startsWith('/')) return path.slice(1);
  return path;
}

function matchesOperationTarget(
  cursor: SandboxOperationEvent,
  candidatePath: string | undefined,
): boolean {
  const normalizedCandidate = normalizeEventPath(candidatePath);
  if (normalizedCandidate === undefined) return false;
  if (normalizedCandidate === normalizeEventPath(cursor.path)) return true;
  const rootPath = cursor.detail?.rootPath;
  if (typeof rootPath === 'string' && normalizedCandidate === normalizeEventPath(rootPath)) {
    return true;
  }
  return false;
}

function isCompanionCommit(
  cursor: SandboxOperationEvent,
  candidate: SandboxEvent,
): boolean {
  if (candidate.kind !== 'commit') return false;
  if (candidate.service !== cursor.service) return false;
  if (candidate.instance !== cursor.instance) return false;
  if (cursor.groupId !== undefined && candidate.groupId === cursor.groupId) {
    return true;
  }
  return matchesOperationTarget(cursor, candidate.path);
}

function isCompanionMutation(
  cursor: SandboxOperationEvent,
  candidate: SandboxEvent,
): boolean {
  if (candidate.kind !== 'service_mutation') return false;
  if (candidate.service === 'auth') return false;
  if (candidate.service !== cursor.service) return false;
  if (candidate.instance !== cursor.instance) return false;
  return matchesOperationTarget(cursor, candidate.path);
}

/** The events and ids strictly after a `since` cursor in the sandbox's own
 * event order, skipping immediately trailing companion `commit` and
 * `service_mutation` records emitted for the same operation cursor. */
function windowAfter(
  events: readonly SandboxEvent[],
  since: string,
): { events: readonly SandboxEvent[]; ids: Set<string> } | null {
  const at = events.findIndex((event) => event.id === since);
  if (at === -1) return null;
  let start = at + 1;
  const cursor = events[at];
  if (cursor !== undefined && cursor.kind === 'operation') {
    const firstTrailing = events[start];
    if (firstTrailing !== undefined && isCompanionCommit(cursor, firstTrailing)) {
      start += 1;
    }
    const nextTrailing = events[start];
    if (nextTrailing !== undefined && isCompanionMutation(cursor, nextTrailing)) {
      start += 1;
    }
  }
  const slice = events.slice(start);
  return {
    events: slice,
    ids: new Set(slice.map((event) => event.id)),
  };
}

export default {
  tool: 'sandbox',
  method: 'activity',
  runsIn: 'sandbox',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: `activity(since?, pattern?: ${PATTERNS.join('|')})`,
  description: 'Report Firestore read and listener churn.',
  args: z.object({
    since: z.string().optional().describe('A prior event id; keep only incidents with newer evidence.'),
    pattern: z.enum(PATTERNS).optional(),
  }),
  operation: 'list_sandbox_activity',
  example: {},
  async handler(args, ctx) {
    let since: string | undefined;
    if (typeof args.since === 'string') {
      since = args.since;
    }
    let pattern: string | undefined;
    if (typeof args.pattern === 'string') {
      pattern = args.pattern;
    }

    const history = ctx.sandbox.history();
    let inspectedEvents: readonly SandboxEvent[] = history;
    let currentIds: Set<string> | null = null;
    if (since !== undefined) {
      const current = windowAfter(history, since);
      if (current === null) {
        return operationFailure(
          `The sandbox carries no event '${since}'. Either the log was replaced, by a restore or a reset, or the cursor is not one this sandbox handed out. Call activity without 'since' to read every incident the sandbox holds now.`,
        );
      }
      inspectedEvents = current.events;
      currentIds = current.ids;
    }

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
    if (currentIds !== null) {
      const activeIds = currentIds;
      incidents = incidents.filter((incident) =>
        incident.evidenceEventIds.some((id) => activeIds.has(id)),
      );
    }

    const coverage = summarizeActivityCoverage(inspectedEvents);

    return {
      ok: true,
      summary: formatActivitySummary(incidents.length, coverage),
      data: {
        incidents,
        examined: coverage.examined,
        notExamined: coverage.notExamined,
      },
    };
  },
} satisfies MethodRecord;
