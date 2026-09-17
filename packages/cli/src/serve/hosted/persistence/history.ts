import { durableUndoEventSchema, observationSchema, historyKindSchema, decodeHistoryRecord, type HistoryRecord } from './history-record.js';
import type { AgentEvent } from 'pyric/sandbox/internal';
import { createDurableUndo } from './undo.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { encodeHistory, decodeHistory, historyChecksum } from './history-codec.js';
import type { createCommitController } from './commits.js';
import { sqlText, type SqlConnection, type SqlRow } from './sqlite.js';
export const HISTORY_LIMITS = { events: 256, bytes: 4 * 1024 * 1024, intervalMs: 250, page: 1000 } as const;
type HistoryKind = HistoryRecord['kind'];
export type { HistoryRecord } from './history-record.js';
export interface HistoryQuery {
  after?: number;
  through?: number;
  limit?: number;
  service?: string;
}
interface PendingRecord {
  kind: HistoryKind;
  service: string;
  payload: string;
  checksum: string;
}
type Commits = ReturnType<typeof createCommitController>;
/** Immutable journal pages; only uncommitted observations live in this owner. */
export function createHostedHistory(connection: SqlConnection, commits: Commits, readOnly: boolean) {
  const session: string = randomUUID();
  const metadata = z.object({ store_id: z.string().uuid(), clean: z.union([z.literal(0), z.literal(1)]) }).parse(connection.prepare('SELECT store_id, clean FROM history_meta WHERE id=1').get());
  const engine = createDurableUndo(connection, commits, {
    capture(event) {
      if (failed) {
        unrecorded++;
        return;
      }
      try {
        enqueue(prepare('engine', 'firestore', event));
      }
      catch (error) {
        commits.markUnhealthy();
        throw error;
      }
    },
    events: recentEngineEvents,
  });
  const insert = connection.prepare('INSERT INTO history_records(session,kind,service,payload,checksum) VALUES (?,?,?,?,?)');
  let pending: PendingRecord[] = [];
  let pendingBytes = 0;
  let unrecorded = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  let lastFlushAt: number | null = null;
  let started = false;
  let committingEvents = 0;
  const previousShutdownClean = metadata.clean === 1;
  commits.onFailure(() => {
    failed = true;
    unrecorded += pending.length + committingEvents;
    pending = [];
    pendingBytes = 0;
    committingEvents = 0;
    clearTimeout(timer);
  });
  function prepare(kind: HistoryKind, service: string, value: unknown): PendingRecord {
    const payload = encodeHistory(value);
    return { kind, service, payload, checksum: historyChecksum(payload) };
  }
  function write(record: PendingRecord): number {
    insert.run(session, record.kind, record.service, record.payload, record.checksum);
    return Number(connection.prepare('SELECT last_insert_rowid() AS id').get()?.id);
  }
  function commit<T>(work: () => T): T {
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    committingEvents += batch.length;
    try {
      return commits.commit(() => {
        for (const record of batch)
          write(record);
        const result = work();
        commits.afterCommit(() => {
          committingEvents -= batch.length;
          lastFlushAt = Date.now();
        });
        return result;
      });
    }
    catch (error) {
      failed = true;
      unrecorded += pending.length + committingEvents;
      committingEvents = 0;
      pending = [];
      pendingBytes = 0;
      throw error;
    }
  }
  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    const hasPending = pending.length > 0;
    if (hasPending)
      commit(() => { });
  }
  function observe(value: unknown): void {
    const unavailable = failed || commits.status().state === 'unhealthy';
    if (unavailable) {
      unrecorded++;
      return;
    }
    const event = observationSchema.parse(value);
    const firestoreEvent = ['request', 'write', 'snapshot_delivery', 'snapshot_suppressed', 'listener_attach', 'listener_detach', 'listener_errored'].includes(event.kind);
    const fallbackService = firestoreEvent ? 'firestore' : 'runtime';
    const configuredService = event.service;
    const hasService = typeof configuredService === 'string';
    const service = hasService ? configuredService : fallbackService;
    const record = prepare('observation', service, event);
    enqueue(record);
  }
  function enqueue(record: PendingRecord): void {
    const bytes = Buffer.byteLength(record.payload);
    const exceedsQueue = pendingBytes + bytes > HISTORY_LIMITS.bytes;
    if (exceedsQueue)
      flush();
    const oversized = bytes > HISTORY_LIMITS.bytes;
    if (oversized) {
      committingEvents++;
      commit(() => {
        write(record);
        commits.afterCommit(() => { committingEvents--; });
      });
      return;
    }
    pending.push(record);
    pendingBytes += bytes;
    const full = pending.length >= HISTORY_LIMITS.events || pendingBytes >= HISTORY_LIMITS.bytes;
    if (full) {
      flush();
      return;
    }
    const needsTimer = timer === undefined;
    if (needsTimer) {
      timer = setTimeout(() => {
        try {
          flush();
        }
        catch { /* The shared persistence latch reports failure; no background rejection. */ }
      }, HISTORY_LIMITS.intervalMs);
      timer.unref();
    }
  }
  function recentEngineEvents(): AgentEvent[] {
    const events: AgentEvent[] = [];
    let bytes = 0;
    function include(payload: string, checksum: string): boolean {
      const size = Buffer.byteLength(payload);
      const full = events.length >= HISTORY_LIMITS.page || bytes + size > HISTORY_LIMITS.bytes;
      if (full)
        return false;
      events.push(durableUndoEventSchema.parse(decodeHistory(payload, checksum)));
      bytes += size;
      return true;
    }
    for (const record of [...pending].reverse()) {
      const isEngine = record.kind === 'engine';
      const filledPage = isEngine && !include(record.payload, record.checksum);
      if (filledPage)
        return events.reverse();
    }
    const read = connection.prepare("SELECT sequence,payload,checksum FROM history_records WHERE kind='engine' AND sequence<? ORDER BY sequence DESC LIMIT 1");
    let before = Number.MAX_SAFE_INTEGER;
    let pageHasRoom = true;
    while (pageHasRoom) {
      const row = read.get(before);
      const missingRow = row === undefined;
      if (missingRow)
        break;
      const included = include(sqlText(row, 'payload'), sqlText(row, 'checksum'));
      const full = !included;
      if (full)
        break;
      before = Number(row.sequence);
      pageHasRoom = events.length < HISTORY_LIMITS.page;
    }
    return events.reverse();
  }
  function record(kind: HistoryKind, service: string, value: unknown): number {
    return write(prepare(kind, service, value));
  }
  function decode(row: SqlRow): HistoryRecord {
    const sequence = Number(row.sequence);
    try {
      const kind = historyKindSchema.parse(row.kind);
      const checksum = sqlText(row, 'checksum');
      const payload = decodeHistoryRecord({ kind, checksum, encodedPayload: sqlText(row, 'payload') });
      return { sequence, session: sqlText(row, 'session'), kind, service: sqlText(row, 'service'), payload, encodedPayload: sqlText(row, 'payload'), checksum };
    }
    catch (cause) {
      throw new Error(`History record ${sequence} is unreadable. Preserve the database and run salvage.`, { cause });
    }
  }
  function status() {
    const latest = connection.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM history_records').get();
    return { storeId: metadata.store_id, session, durableSequence: Number(latest?.sequence),
      pendingEvents: pending.length, pendingBytes, unrecorded, lastFlushAt, undo: engine.status(),
      healthy: !failed && commits.status().state === 'healthy', previousShutdownClean };
  }
  return {
    observe(value: unknown) {
      try {
        observe(value);
      }
      catch (error) {
        failed = true;
        commits.markUnhealthy();
        throw error;
      }
    },
    flush, commit, record, decode, status, engine,
    boundary(reason: string) {
      engine.clear();
      record('boundary', 'firestore', { reason, undoUnavailableBeforeBoundary: true });
    },
    commitState<T>(work: () => T): T {
      return commit(() => { const result = work(); engine.commit(value => record('undo', 'firestore', value)); return result; });
    },
    list(query: HistoryQuery = {}) {
      const after = query.after ?? 0;
      const durableSequence = status().durableSequence;
      const through = query.through ?? durableSequence;
      const limit = query.limit ?? 100;
      const valid = Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(through) && through >= after && through <= durableSequence
        && Number.isSafeInteger(limit) && limit > 0 && limit <= HISTORY_LIMITS.page;
      const invalid = !valid;
      if (invalid)
        throw new Error('Invalid history cursor or page size (1–1000).');
      const service = query.service ?? null;
      const filtersService = service !== null;
      const read = connection.prepare(filtersService
        ? 'SELECT * FROM history_records WHERE service=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 1'
        : 'SELECT * FROM history_records WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT 1');
      const records: HistoryRecord[] = [];
      let cursor = after;
      let bytes = 0;
      let pageHasRoom = true;
      while (pageHasRoom) {
        const row = filtersService ? read.get(service, cursor, through) : read.get(cursor, through);
        const missingRow = row === undefined;
        if (missingRow)
          break;
        const size = Buffer.byteLength(sqlText(row, 'payload'));
        const pageFull = records.length > 0 && bytes + size > HISTORY_LIMITS.bytes;
        if (pageFull)
          break;
        records.push(decode(row));
        cursor = Number(row.sequence);
        bytes += size;
        pageHasRoom = records.length < limit;
      }
      return { storeId: status().storeId, through, records, next: records.at(-1)?.sequence ?? through };
    },
    startSession() {
      const cannotStart = readOnly || started;
      if (cannotStart)
        return;
      const clean = status().previousShutdownClean;
      commit(() => {
        record('boundary', 'runtime', { reason: clean ? 'session-start' : 'unclean-restart', observationTailMayBeMissing: !clean });
        connection.exec('UPDATE history_meta SET clean=0 WHERE id=1');
      });
      started = true;
    },
    close() {
      clearTimeout(timer);
      const healthy = !readOnly && commits.status().state === 'healthy';
      if (healthy) {
        commit(() => {
          if (started) {
            record('boundary', 'runtime', { reason: 'session-end' });
            connection.exec('UPDATE history_meta SET clean=1 WHERE id=1');
          }
        });
      }
    },
  };
}
export type HostedHistory = ReturnType<typeof createHostedHistory>;
