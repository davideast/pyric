/**
 * Home live-activity projection (specs/home.md).
 *
 * PURE. Projects the unified `SandboxEvent` stream onto the capped,
 * provenance-stamped rows Home's feed renders: committed writes, denials,
 * service mutations (auth/storage/rtdb), admin-plane RTDB commits (which
 * emit no service_mutation), and session boundaries. Reads,
 * listener lifecycle, and snapshot deliveries are Traffic's domain and are
 * skipped here. Each row carries the route of its SUBJECT (the doc, user,
 * object, or denial it references) — detail belongs to the owning surface,
 * not the feed (C3: drill-in).
 */

import { DEFAULT_FIRESTORE_DATABASE } from 'pyric/firestore/internal';
import type { SandboxEvent } from 'pyric/sandbox';
import type { CommandTarget } from './command.js';

export type ActivityProvenance =
  | 'app'
  | 'studio'
  | 'agent'
  | 'app-builder'
  | 'unattributed'
  | 'system';

export interface ActivityRow {
  id: string;
  at: number;
  provenance: ActivityProvenance;
  /** Short identity/actor text for the row's left cell ("agent:claude",
   *  "alice", "app"). */
  identity: string;
  summary: string;
  /** Non-default Firestore database id when the event targeted a named database. */
  database?: string;
  /** True for a rules denial (rendered distinctly). */
  denied: boolean;
  /** Route of the row's subject; null when nothing addressable exists. */
  target: CommandTarget | null;
}

function provenanceOf(event: SandboxEvent): {
  provenance: ActivityProvenance;
  identity: string;
} {
  const actor = event.operationContext?.source ?? event.actor;
  if (actor?.kind === 'agent') return { provenance: 'agent', identity: `agent:${actor.name}` };
  if (actor?.kind === 'studio') return { provenance: 'studio', identity: 'studio' };
  if (actor?.kind === 'app-builder') return { provenance: 'app-builder', identity: 'builder' };
  const uid =
    'auth' in event && event.auth && typeof event.auth === 'object'
      ? (event.auth as { uid?: string }).uid
      : undefined;
  if (!actor || actor.kind === 'unattributed') {
    return { provenance: 'unattributed', identity: uid ?? 'unattributed' };
  }
  return { provenance: 'app', identity: uid ?? 'app' };
}

function eventNamedDatabase(event: SandboxEvent): string | undefined {
  const raw = (event as { database?: unknown }).database;
  if (typeof raw === 'string' && raw.length > 0 && raw !== DEFAULT_FIRESTORE_DATABASE) {
    return raw;
  }
  const detailDb = (event as { detail?: { database?: unknown } }).detail?.database;
  if (
    typeof detailDb === 'string' &&
    detailDb.length > 0 &&
    detailDb !== DEFAULT_FIRESTORE_DATABASE
  ) {
    return detailDb;
  }
  return undefined;
}

function firestoreTarget(path: string | undefined, database?: string): CommandTarget | null {
  if (!path) return null;
  const target: CommandTarget = { tab: 'firestore', rest: path.split('/').filter(Boolean) };
  if (database !== undefined) {
    target.query = { database };
  }
  return target;
}

/** Project one event onto a feed row, or null to skip it. */
export function toActivityRow(event: SandboxEvent): ActivityRow | null {
  const { provenance, identity } = provenanceOf(event);
  const base = { id: event.id, at: event.at, provenance, identity };

  switch (event.kind) {
    case 'write': {
      const database = eventNamedDatabase(event);
      const prefix = database !== undefined ? ` [${database}]` : '';
      const row: ActivityRow = {
        ...base,
        denied: false,
        summary: `${event.method}${prefix} /${event.path}`,
        target: firestoreTarget(event.path, database),
      };
      if (database !== undefined) row.database = database;
      return row;
    }
    case 'request': {
      if (event.result !== 'deny') return null;
      const database = eventNamedDatabase(event);
      const prefix = database !== undefined ? ` [${database}]` : '';
      const row: ActivityRow = {
        ...base,
        denied: true,
        summary: `denied${prefix} ${event.method} /${event.path}`,
        target: { tab: 'traffic', query: { inspect: event.id } },
      };
      if (database !== undefined) row.database = database;
      return row;
    }
    case 'operation': {
      if (event.result === 'deny') {
        const database = event.service === 'firestore' ? eventNamedDatabase(event) : undefined;
        const dbTag = database !== undefined ? `:${database}` : '';
        const row: ActivityRow = {
          ...base,
          denied: true,
          summary: `denied ${event.service}${dbTag} ${event.method}${event.path ? ` ${event.path}` : ''}`,
          target: { tab: 'traffic', query: { inspect: event.id } },
        };
        if (database !== undefined) row.database = database;
        return row;
      }
      return null;
    }
    case 'service_mutation': {
      const path = event.path ? ` ${event.path}` : '';
      const target: CommandTarget | null =
        event.service === 'auth' && event.path && event.path !== '*'
          ? { tab: 'auth', rest: [event.path] }
          : event.service === 'storage' && event.path
            ? { tab: 'storage', rest: event.path.split('/').filter(Boolean) }
            : event.service === 'rtdb'
              ? { tab: 'rtdb' }
              : null;
      return {
        ...base,
        denied: false,
        summary: `${event.service} ${event.op}${path}`,
        target,
      };
    }
    case 'commit': {
      // RTDB admin-plane writes (Studio's viewer edits, agent admin ops)
      // emit NO service_mutation — this commit is their only committed-write
      // signal (verified empirically in activity.rtdb.test.ts). Rule-gated
      // RTDB writes DO emit a service_mutation and are covered above, so
      // only the admin-flagged commits project here (no double rows).
      if (event.service !== 'rtdb' || event.detail?.admin !== true) return null;
      return {
        ...base,
        denied: false,
        summary: `rtdb ${event.method}${event.path ? ` ${event.path}` : ''}`,
        target: { tab: 'rtdb' },
      };
    }
    case 'session_boundary':
      return {
        ...base,
        provenance: 'system',
        identity: 'sandbox',
        denied: false,
        summary: `session ${event.phase}`,
        target: null,
      };
    default:
      return null; // reads, listeners, snapshots → Traffic's domain
  }
}

/** The newest `cap` rows, newest first (the feed is capped on Home; full
 *  history lives in Traffic — specs/home.md scroll-owner contract). */
export function selectActivity(
  events: readonly SandboxEvent[],
  cap = 20,
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (let i = events.length - 1; i >= 0 && rows.length < cap; i--) {
    const row = toActivityRow(events[i]);
    if (row) rows.push(row);
  }
  return rows;
}
