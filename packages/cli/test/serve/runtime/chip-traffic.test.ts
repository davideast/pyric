import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  chipRequestFromEvent,
  createTrafficFeed,
  isPermissionDeniedCode,
  orderChipRequests,
  RECENT_FAILURE_MS,
  type ChipRequest,
} from '../../../src/serve/runtime/chip-traffic.js';

function request(id: string, at: number, result: 'allow' | 'deny'): SandboxEvent {
  return {
    kind: 'request',
    id,
    at,
    evalMs: 1,
    method: 'set',
    path: 'conversations/c1',
    auth: null,
    result,
    reasons: [],
  } as unknown as SandboxEvent;
}

function operation(id: string, at: number, result: 'allow' | 'deny'): SandboxEvent {
  return {
    kind: 'operation',
    id,
    at,
    service: 'database',
    method: 'set',
    path: '/presence/u_8f2a',
    auth: null,
    result,
    origin: 'user',
    rules: { engine: 'rtdb' },
  } as unknown as SandboxEvent;
}

function row(at: number, verdict: ChipRequest['verdict']): ChipRequest {
  return { id: `r${at}`, at, service: 'firestore', method: 'set', path: 'c/1', verdict };
}

describe('the request a sandbox event stands for', () => {
  it('reads a Firestore request as its service, method, path, and verdict', () => {
    expect(chipRequestFromEvent(request('r1', 1000, 'allow'))).toEqual({
      id: 'r1',
      at: 1000,
      service: 'firestore',
      method: 'set',
      path: 'conversations/c1',
      verdict: 'ok',
      reason: null,
    });
  });

  it('reads a denied request as denied', () => {
    expect(chipRequestFromEvent(request('r1', 1000, 'deny'))?.verdict).toBe('denied');
  });

  it('reads a canonical service operation with its own service discriminator', () => {
    const projected = chipRequestFromEvent(operation('o1', 2000, 'allow'));
    expect(projected?.service).toBe('database');
    expect(projected?.path).toBe('/presence/u_8f2a');
    expect(projected?.verdict).toBe('ok');
    expect(chipRequestFromEvent(operation('o2', 2000, 'deny'))?.verdict).toBe('denied');
  });

  it('reads a listener attach as a listen on its target, in both event shapes', () => {
    const legacy = chipRequestFromEvent({
      kind: 'listener_attach',
      id: 'a1',
      at: 3000,
      listenerId: 'l1',
      target: { kind: 'query', collection: 'conversations' },
      auth: null,
    } as unknown as SandboxEvent);
    expect(legacy).toEqual({
      id: 'a1',
      at: 3000,
      service: 'firestore',
      method: 'listen',
      path: 'conversations',
      verdict: 'ok',
      reason: null,
    });

    const canonical = chipRequestFromEvent({
      kind: 'listener',
      id: 'a2',
      at: 3100,
      service: 'database',
      phase: 'attach',
      listenerId: 'l2',
      target: { kind: 'doc', path: '/presence' },
      auth: null,
    } as unknown as SandboxEvent);
    expect(canonical?.service).toBe('database');
    expect(canonical?.method).toBe('listen');
    expect(canonical?.path).toBe('/presence');
  });

  it('reads a listener that was refused by rules as denied, and one that broke as an error', () => {
    const denied = chipRequestFromEvent({
      kind: 'listener_errored',
      id: 'e1',
      at: 4000,
      listenerId: 'l1',
      target: { kind: 'doc', path: 'users/u1' },
      auth: null,
      error: { code: 'permission-denied', message: 'denied by rules' },
    } as unknown as SandboxEvent);
    expect(denied?.verdict).toBe('denied');

    const broke = chipRequestFromEvent({
      kind: 'listener_errored',
      id: 'e2',
      at: 4100,
      listenerId: 'l2',
      target: { kind: 'doc', path: 'users/u2' },
      auth: null,
      error: { code: 'unavailable', message: 'transport closed' },
    } as unknown as SandboxEvent);
    expect(broke?.verdict).toBe('error');
  });

  it('is not a request at all for the events that are not one', () => {
    expect(chipRequestFromEvent({ kind: 'session_boundary', id: 's1', at: 1, phase: 'reset', priorOpCount: 0 } as unknown as SandboxEvent)).toBeNull();
    expect(chipRequestFromEvent({
      kind: 'snapshot_delivery',
      id: 'd1',
      at: 1,
      listenerId: 'l1',
      target: { kind: 'doc', path: 'users/u1' },
      auth: null,
    } as unknown as SandboxEvent)).toBeNull();
  });

  it('knows every spelling a denied code arrives under, and nothing else', () => {
    expect(isPermissionDeniedCode('PERMISSION_DENIED')).toBe(true);
    expect(isPermissionDeniedCode('permission-denied')).toBe(true);
    expect(isPermissionDeniedCode('auth/permission-denied')).toBe(true);
    expect(isPermissionDeniedCode('unavailable')).toBe(false);
    expect(isPermissionDeniedCode(undefined)).toBe(false);
  });
});

describe('the order Traffic reads in', () => {
  it('puts a fresh failure first, then everything newest first', () => {
    const now = 10_000_000;
    const ordered = orderChipRequests([
      row(now - 1000, 'ok'),
      row(now - 30_000, 'denied'),
      row(now - 2000, 'ok'),
      row(now - 40_000, 'error'),
    ], now);
    expect(ordered.map((entry) => entry.at)).toEqual([
      now - 30_000,
      now - 40_000,
      now - 1000,
      now - 2000,
    ]);
  });

  it('puts a fresh denial ahead of a newer failure that is not a Rules verdict', () => {
    const now = 10_000_000;
    const ordered = orderChipRequests([row(now - 500, 'error'), row(now - 20_000, 'denied')], now);
    expect(ordered.map((entry) => entry.verdict)).toEqual(['denied', 'error']);
  });

  it('lets a stale failure fall back into the newest-first run', () => {
    const now = 10_000_000;
    const stale = now - (RECENT_FAILURE_MS + 1000);
    const ordered = orderChipRequests([row(stale, 'denied'), row(now - 1000, 'ok')], now);
    expect(ordered.map((entry) => entry.at)).toEqual([now - 1000, stale]);
  });
});

describe('the bounded tail the view reads', () => {
  it('folds the page stream, reports each change, and keeps only the last rows', () => {
    let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
    let changes = 0;
    const feed = createTrafficFeed({
      subscribeEvents: (callback) => {
        deliver = callback;
        return () => {
          deliver = null;
        };
      },
      onChange: () => {
        changes += 1;
      },
      limit: 3,
    });

    deliver!([request('r1', 1000, 'allow'), request('r2', 2000, 'allow')]);
    expect(feed.requests().map((entry) => entry.id)).toEqual(['r1', 'r2']);
    expect(changes).toBe(1);

    // A batch with nothing Traffic can draw is not a change.
    deliver!([{ kind: 'session_boundary', id: 's1', at: 1, phase: 'reset', priorOpCount: 0 } as unknown as SandboxEvent]);
    expect(changes).toBe(1);

    deliver!([request('r3', 3000, 'allow'), request('r4', 4000, 'allow')]);
    expect(feed.requests().map((entry) => entry.id)).toEqual(['r2', 'r3', 'r4']);
  });

  it('says whether anything failed inside the window, and stops after disposal', () => {
    let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
    let unsubscribed = false;
    const feed = createTrafficFeed({
      subscribeEvents: (callback) => {
        deliver = callback;
        return () => {
          unsubscribed = true;
        };
      },
    });
    const now = 10_000_000;
    deliver!([request('old', now - (RECENT_FAILURE_MS + 1000), 'deny')]);
    expect(feed.failedRecently(now)).toBe(false);

    deliver!([request('fresh', now - 1000, 'deny')]);
    expect(feed.failedRecently(now)).toBe(true);

    feed.dispose();
    expect(unsubscribed).toBe(true);
    expect(feed.requests()).toEqual([]);
  });
});
