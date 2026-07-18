/**
 * Unit tests for the engine's HistoryControls internal seam (ADR-0009,
 * PR B1) — undo/redo driven against a fake HistoryHost, no engine needed.
 * Engine-level undo/redo behavior stays covered by the simulator suites.
 */
import { describe, test, expect } from 'bun:test';
import { EventLog } from '../../../src/firestore/sandbox/event-log.js';
import { HistoryControls, type HistoryHost } from '../../../src/firestore/sandbox/history-controls.js';
import type { DocumentData } from '../../../src/firestore/sandbox/local-state.js';

function makeHost(initial: Record<string, DocumentData> = {}) {
  let docs: Record<string, DocumentData> = { ...initial };
  const calls: string[] = [];
  const host: HistoryHost = {
    get state() {
      return {
        snapshot: () => ({ ...docs }),
        restore: (snapshot: Record<string, DocumentData>) => {
          calls.push('restore');
          docs = { ...snapshot };
        },
        restorePaths: (priorDocs: Record<string, DocumentData | null>) => {
          calls.push(`restorePaths:${Object.keys(priorDocs).join(',')}`);
          for (const [path, prior] of Object.entries(priorDocs)) {
            if (prior === null) delete docs[path];
            else docs[path] = prior;
          }
        },
      };
    },
    capturePriors: (paths) => {
      calls.push(`capturePriors:${paths.join(',')}`);
      return Object.fromEntries(paths.map((p) => [p, docs[p] ?? null]));
    },
    applyWrite: (method, path, data) => {
      calls.push(`applyWrite:${method}:${path}`);
      if (method === 'delete') delete docs[path];
      else docs[path] = data ?? {};
      return null;
    },
  };
  return { host, calls, docs: () => docs };
}

describe('HistoryControls', () => {
  test('undo with no history returns null', () => {
    const { host } = makeHost();
    const history = new HistoryControls(new EventLog(), host);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  test('undo restores affected paths for a single write', () => {
    const { host, calls, docs } = makeHost({ 'rooms/r1': { v: 1 } });
    const log = new EventLog();
    log.append({
      type: 'write', method: 'update', path: 'rooms/r1',
      allowed: true, data: { v: 2 }, priorDocs: { 'rooms/r1': { v: 0 } },
    } as Parameters<EventLog['append']>[0]);
    const history = new HistoryControls(log, host);

    const undone = history.undo();
    expect(undone?.path).toBe('rooms/r1');
    expect(calls).toContain('restorePaths:rooms/r1');
    expect(docs()['rooms/r1']).toEqual({ v: 0 });
  });

  test('undo restores the whole keyspace when the event carries a snapshot', () => {
    const { host, calls, docs } = makeHost({ 'a/1': { n: 9 }, 'b/2': { n: 9 } });
    const log = new EventLog();
    log.append({
      type: 'transaction', allowed: true,
      snapshot: { 'a/1': { n: 1 } },
    } as Parameters<EventLog['append']>[0]);
    const history = new HistoryControls(log, host);

    expect(history.undo()).not.toBeNull();
    expect(calls).toContain('restore');
    expect(docs()).toEqual({ 'a/1': { n: 1 } });
  });

  test('redo re-applies an undone allowed write and recaptures priors', () => {
    const { host, calls, docs } = makeHost({ 'rooms/r1': { v: 1 } });
    const log = new EventLog();
    log.append({
      type: 'write', method: 'update', path: 'rooms/r1',
      allowed: true, data: { v: 2 }, priorDocs: { 'rooms/r1': { v: 0 } },
    } as Parameters<EventLog['append']>[0]);
    const history = new HistoryControls(log, host);

    history.undo();
    const result = history.redo();
    expect(result?.allowed).toBe(true);
    expect(result?.debugMessages).toEqual(['Redo: applied']);
    expect(calls).toContain('capturePriors:rooms/r1');
    expect(calls).toContain('applyWrite:update:rooms/r1');
    expect(docs()['rooms/r1']).toEqual({ v: 2 });
    expect(history.getEventCount()).toBe(1);
  });

  test('a denied write is not undoable (popLastWrite skips it), so redo stays empty', () => {
    const { host, calls } = makeHost();
    const log = new EventLog();
    log.append({
      type: 'write', method: 'set', path: 'rooms/r1',
      allowed: false, data: { v: 2 }, priorDocs: { 'rooms/r1': null },
    } as Parameters<EventLog['append']>[0]);
    const history = new HistoryControls(log, host);

    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    expect(calls.filter((c) => c.startsWith('applyWrite'))).toEqual([]);
    // The denied event stays in the log for forensics.
    expect(history.getEventCount()).toBe(1);
  });

  test('redo re-applies only the allowed operations of a batch', () => {
    const { host, calls } = makeHost();
    const log = new EventLog();
    log.append({
      type: 'batch', allowed: true,
      operations: [
        { method: 'set', path: 'a/1', data: { n: 1 }, allowed: true },
        { method: 'set', path: 'b/2', data: { n: 2 }, allowed: false },
      ],
      priorDocs: { 'a/1': null, 'b/2': null },
    } as Parameters<EventLog['append']>[0]);
    const history = new HistoryControls(log, host);

    history.undo();
    history.redo();
    expect(calls).toContain('capturePriors:a/1,b/2');
    expect(calls).toContain('applyWrite:set:a/1');
    expect(calls.filter((c) => c === 'applyWrite:set:b/2')).toEqual([]);
  });

  test('getEvents and getEventCount reflect the log', () => {
    const { host } = makeHost();
    const log = new EventLog();
    const history = new HistoryControls(log, host);
    expect(history.getEvents()).toEqual([]);
    expect(history.getEventCount()).toBe(0);
    log.append({ type: 'write', method: 'set', path: 'x/1', allowed: true } as Parameters<EventLog['append']>[0]);
    expect(history.getEventCount()).toBe(1);
    expect(history.getEvents()[0]?.path).toBe('x/1');
  });
});
