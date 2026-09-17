import { durableUndoRecordSchema, undoAppendSchema } from './history-record.js';
import type { AgentEvent, AgentEventStore } from 'pyric/sandbox/internal';
import { decodeHistory, encodeHistory, historyChecksum } from './history-codec.js';
import { sqlText, type SqlConnection } from './sqlite.js';
import type { createCommitController } from './commits.js';
interface Entry {
  id: number;
  previous: number;
  redo: number;
  payload: string;
  checksum: string;
}
const CACHE_BYTES = 4 * 1024 * 1024;
/** A linked durable stack. Eviction removes cached bytes, never undo records. */
export function createDurableUndo(connection: SqlConnection, commits: ReturnType<typeof createCommitController>, inspection: {
  capture(event: AgentEvent): void;
  events(): AgentEvent[];
}) {
  const saved = connection.prepare('SELECT * FROM history_undo_state WHERE id=1').get();
  let state = { next: Number(saved?.next), undo: Number(saved?.undo), redo: Number(saved?.redo), undoCount: Number(saved?.undo_count), redoCount: Number(saved?.redo_count) };
  const validState = Object.values(state).every(value => Number.isSafeInteger(value) && value >= 0);
  const invalidState = !validState;
  if (invalidState)
    throw new Error('Invalid durable undo index.');
  const pending = new Map<number, Entry>();
  const links = new Map<number, number>();
  const cache = new Map<number, Entry>();
  let cacheBytes = 0;
  let pendingBytes = 0;
  let dirty = false;
  let boundary = false;
  const readRow = connection.prepare('SELECT entry.*, history.payload, history.checksum FROM history_undo entry JOIN history_records history ON history.sequence=entry.record_sequence WHERE entry.id=?');
  function read(id: number): Entry | null {
    const empty = id === 0;
    if (empty)
      return null;
    const retained = pending.get(id) ?? cache.get(id);
    const cached = retained !== undefined;
    if (cached)
      return retained;
    const row = readRow.get(id);
    const missingRow = row === undefined;
    if (missingRow)
      throw new Error(`Missing undo record ${id}; undo cannot cross this boundary.`);
    const saved = undoAppendSchema.parse(decodeHistory(sqlText(row, 'payload'), sqlText(row, 'checksum')));
    const matchingId = saved.id === id;
    const wrongRecord = !matchingId;
    if (wrongRecord) throw new Error(`Undo record ${id} points to another operation.`);
    const entry = { id, previous: Number(row.previous), redo: Number(row.redo_next), payload: saved.payload, checksum: saved.checksum };
    const bytes = Buffer.byteLength(entry.payload);
    const cacheable = bytes <= CACHE_BYTES;
    if (cacheable) {
      cache.set(id, entry);
      cacheBytes += bytes;
      let exceeds = cache.size > 1000 || cacheBytes > CACHE_BYTES;
      while (exceeds) {
        const oldest = cache.entries().next().value;
        const emptyCache = oldest === undefined;
        if (emptyCache)
          break;
        cache.delete(oldest[0]);
        cacheBytes -= Buffer.byteLength(oldest[1].payload);
        exceeds = cache.size > 1000 || cacheBytes > CACHE_BYTES;
      }
    }
    return entry;
  }
  function decode(entry: Entry): AgentEvent {
    try {
      return durableUndoRecordSchema.parse(decodeHistory(entry.payload, entry.checksum)) as AgentEvent;
    }
    catch (cause) {
      throw new Error(`Undo record ${entry.id} is unreadable; undo cannot cross this boundary.`, { cause });
    }
  }
  // Validate reachable heads without materializing older payloads.
  const invalidLinks = connection.prepare(`SELECT entry.id FROM history_undo AS entry
  LEFT JOIN history_undo AS previous ON previous.id=entry.previous
  LEFT JOIN history_undo AS redo ON redo.id=entry.redo_next
  LEFT JOIN history_records AS history ON history.sequence=entry.record_sequence
  WHERE history.sequence IS NULL OR history.kind<>'undo' OR entry.id<=0 OR entry.previous<0 OR entry.previous>=entry.id
   OR (entry.previous<>0 AND previous.id IS NULL)
   OR entry.redo_next<0 OR (entry.redo_next<>0 AND redo.id IS NULL)
  LIMIT 1`).get();
  const hasInvalidLinks = invalidLinks !== undefined;
  if (hasInvalidLinks)
    throw new Error('Invalid durable undo links; preserve the store and run salvage.');
  function validChain(head: number, count: number, link: 'previous' | 'redo_next'): boolean {
    const empty = head === 0;
    if (empty)
      return count === 0;
    const chain = connection.prepare(`WITH RECURSIVE chain(id) AS (
   SELECT id FROM history_undo WHERE id=? UNION
   SELECT entry.${link} FROM history_undo entry JOIN chain ON entry.id=chain.id WHERE entry.${link}<>0
  ) SELECT COUNT(*) AS count, SUM(entry.${link}=0) AS ends FROM chain JOIN history_undo entry ON entry.id=chain.id`).get(head);
    const hasChain = chain !== undefined;
    return hasChain && chain.count === count && chain.ends === 1;
  }
  const latest = Number(connection.prepare('SELECT COALESCE(MAX(id),0) AS id FROM history_undo').get()?.id);
  const validIndex = state.next > latest && validChain(state.undo, state.undoCount, 'previous') && validChain(state.redo, state.redoCount, 'redo_next');
  const invalidIndex = !validIndex;
  if (invalidIndex)
    throw new Error('Invalid durable undo cursor; preserve the store and run salvage.');
  function current(): AgentEvent | null {
    const entry = read(state.undo);
    const hasEntry = entry !== null;
    return hasEntry ? decode(entry) : null;
  }
  const store: AgentEventStore = {
    append(event, preserveRedo) {
      const { priorDocs: _priors, nextDocs: _next, snapshot: _snapshot, ...observation } = event;
      inspection.capture(observation);
      const undoable = event.allowed && !event.aborted && event.priorDocs !== undefined && event.nextDocs !== undefined;
      const notUndoable = !undoable;
      if (notUndoable)
        return event;
      const { data: _data, reads: _reads, operations, ...undo } = event;
      const stored: AgentEvent = { ...undo, id: state.next,
        operations: operations?.map(({ data: _operationData, ...operation }) => operation) };
      const payload = encodeHistory(stored);
      const bytes = Buffer.byteLength(payload);
      const saturated = pendingBytes + bytes > 24 * 1024 * 1024;
      if (saturated) {
        commits.markUnhealthy();
        throw new Error('Uncommitted undo history exceeded its admission budget. Restart and repair persistence before further mutations.');
      }
      pending.set(stored.id, { id: stored.id, previous: state.undo, redo: 0, payload, checksum: historyChecksum(payload) });
      pendingBytes += bytes;
      state = { ...state, next: state.next + 1, undo: stored.id, undoCount: state.undoCount + 1 };
      const invalidatesRedo = !preserveRedo;
      if (invalidatesRedo) {
        state.redo = 0;
        state.redoCount = 0;
      }
      dirty = true;
      return stored;
    },
    // Legacy engine inspection is a bounded recent view. Hosted callers page the journal.
    getEvents: inspection.events,
    getWriteEvents() { return inspection.events().filter(event => event.allowed && event.method !== 'get' && event.method !== 'list'); },
    lastWriteEvent: current,
    popLastWrite() {
      const entry = read(state.undo);
      const missingEntry = entry === null;
      if (missingEntry)
        return null;
      const event = decode(entry);
      const pendingLinkBytes = (links.size + 1) * 128;
      const exceedsBudget = pendingBytes + pendingLinkBytes > 24 * 1024 * 1024;
      if (exceedsBudget)
        throw new Error('Flush pending undo changes before continuing.');
      links.set(entry.id, state.redo);
      state = { ...state, undo: entry.previous, redo: entry.id, undoCount: state.undoCount - 1, redoCount: state.redoCount + 1 };
      dirty = true;
      return event;
    },
    popLastUndo() {
      const entry = read(state.redo);
      const missingEntry = entry === null;
      if (missingEntry)
        return null;
      const event = decode(entry);
      state = { ...state, redo: links.get(entry.id) ?? entry.redo, redoCount: state.redoCount - 1 };
      dirty = true;
      return event;
    },
    size: () => inspection.events().length,
    clear() { boundary = true; state = { ...state, undo: 0, redo: 0, undoCount: 0, redoCount: 0 }; dirty = true; },
  };
  return {
    ...store,
    status: () => ({ undoCount: state.undoCount, redoCount: state.redoCount, cacheBytes, cachedRecords: cache.size, pendingBytes, pendingLinkBytes: links.size * 128 }),
    hasPending: () => dirty,
    commit(record: (value: unknown) => number) {
      const unchanged = !dirty;
      if (unchanged)
        return;
      const save = connection.prepare('INSERT INTO history_undo VALUES (?,?,?,?)');
      for (const entry of pending.values()) {
        const sequence = record({ action: 'append', ...entry });
        save.run(entry.id, entry.previous, entry.redo, sequence);
      }
      for (const [id, next] of links)
        connection.prepare('UPDATE history_undo SET redo_next=? WHERE id=?').run(next, id);
      connection.prepare('UPDATE history_undo_state SET next=?,undo=?,redo=?,undo_count=?,redo_count=? WHERE id=1').run(state.next, state.undo, state.redo, state.undoCount, state.redoCount);
      record({ action: boundary ? 'boundary' : 'position', ...state, links: [...links] });
      boundary = false;
      pending.clear();
      links.clear();
      cache.clear();
      cacheBytes = 0;
      pendingBytes = 0;
      dirty = false;
    },
  };
}
