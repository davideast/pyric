import { describe, expect, test } from 'bun:test';
import {
  EventHistoryLanes,
  isDenialOrErrorEvent,
  resolveDenialLaneLimits,
} from '../../../src/sandbox/internal/history-lanes.js';
import type { SandboxEvent } from '../../../src/sandbox/types/events.js';

describe('isDenialOrErrorEvent', () => {
  test('classifies denials, unsupported ops, failed observations, production errors, and rejected mutations', () => {
    const denialEvents: SandboxEvent[] = [
      {
        kind: 'request',
        id: 'req-unsupported',
        at: 1,
        evalMs: 0,
        method: 'list',
        path: 'items',
        auth: null,
        result: 'unsupported',
        reasons: [],
        origin: 'user',
      },
      {
        kind: 'request',
        id: 'req-disposition',
        at: 2,
        evalMs: 0,
        method: 'get',
        path: 'items/1',
        auth: null,
        result: 'allow',
        reasons: [],
        origin: 'user',
        rulesDisposition: { kind: 'evaluated', verdict: 'deny' },
      },
      {
        kind: 'operation',
        id: 'op-failed-obs',
        at: 3,
        service: 'ai',
        method: 'generateContent',
        path: 'models/default',
        auth: null,
        origin: 'user',
        result: 'not-applicable',
        observation: { id: 'obs-1', startedAt: 1, status: 'failed' },
      },
      {
        kind: 'operation',
        id: 'op-prod-error',
        at: 4,
        service: 'firestore',
        method: 'getDoc',
        path: 'items/1',
        auth: null,
        origin: 'user',
        result: 'not-applicable',
        production: { outcome: { status: 'error', code: 'permission-denied' } },
      },
      {
        kind: 'listener',
        id: 'lis-unsupported',
        at: 5,
        service: 'rtdb',
        phase: 'attach',
        listenerId: 'l-1',
        target: { kind: 'value', path: '/items' },
        auth: null,
        result: 'unsupported',
      },
      {
        kind: 'service_mutation',
        id: 'ai-rejected',
        at: 6,
        service: 'ai',
        op: 'request_rejected',
        path: 'models/default',
        auth: null,
      },
      {
        kind: 'service_mutation',
        id: 'msg-rejected',
        at: 7,
        service: 'messaging',
        op: 'message_rejected',
        path: 'tokens/t1',
        auth: null,
      },
      {
        kind: 'runtime_error',
        id: 'rt-err',
        at: 8,
        service: 'storage',
        method: 'uploadBytes',
        auth: null,
        error: { code: 'internal', message: 'failed' },
      },
    ];

    for (const event of denialEvents) {
      expect(isDenialOrErrorEvent(event)).toBe(true);
    }
  });

  test('keeps routine allowed operations, commits, and non-rejected mutations in the general lane', () => {
    const generalEvents: SandboxEvent[] = [
      {
        kind: 'request',
        id: 'req-allow',
        at: 1,
        evalMs: 0,
        method: 'get',
        path: 'items/1',
        auth: null,
        result: 'allow',
        reasons: [],
        origin: 'user',
      },
      {
        kind: 'operation',
        id: 'op-completed',
        at: 2,
        service: 'ai',
        method: 'generateContent',
        path: 'models/default',
        auth: null,
        origin: 'user',
        result: 'not-applicable',
        observation: { id: 'obs-2', startedAt: 1, status: 'completed' },
      },
      {
        kind: 'service_mutation',
        id: 'rtdb-set',
        at: 3,
        service: 'rtdb',
        op: 'set',
        path: '/items/1',
        auth: null,
      },
      {
        kind: 'commit',
        id: 'cm-1',
        at: 4,
        service: 'rtdb',
        method: 'set',
        path: '/items/1',
        auth: null,
      },
    ];

    for (const event of generalEvents) {
      expect(isDenialOrErrorEvent(event)).toBe(false);
    }
  });
});

describe('resolveDenialLaneLimits', () => {
  test('clamps default, custom, oversized, and negative bounds inside total limits', () => {
    expect(resolveDenialLaneLimits(undefined)).toBeUndefined();
    expect(resolveDenialLaneLimits({ maxEvents: 10_000, maxBytes: 8 * 1024 * 1024 })).toEqual({
      maxEvents: 1_000,
      maxBytes: 2 * 1024 * 1024,
    });
    expect(resolveDenialLaneLimits({ maxEvents: 50, maxBytes: 5_000 })).toEqual({
      maxEvents: 50,
      maxBytes: 5_000,
    });
    expect(resolveDenialLaneLimits({
      maxEvents: 100,
      maxBytes: 10_000,
      maxDenialEvents: 25,
      maxDenialBytes: 2_500,
    })).toEqual({
      maxEvents: 25,
      maxBytes: 2_500,
    });
    expect(resolveDenialLaneLimits({
      maxEvents: 100,
      maxBytes: 10_000,
      maxDenialEvents: -5,
      maxDenialBytes: -10,
    })).toEqual({
      maxEvents: 0,
      maxBytes: 0,
    });
  });
});

describe('EventHistoryLanes byte tracking and merge order', () => {
  test('tracks byte updates per lane and merges general and denial lanes chronologically', () => {
    const lanes = new EventHistoryLanes();
    const deny: SandboxEvent = {
      kind: 'operation',
      id: 'd-1',
      at: 1,
      service: 'rtdb',
      method: 'set',
      path: '/items/1',
      auth: null,
      origin: 'user',
      result: 'deny',
    };
    const allow: SandboxEvent = {
      kind: 'operation',
      id: 'a-1',
      at: 2,
      service: 'rtdb',
      method: 'set',
      path: '/items/2',
      auth: null,
      origin: 'user',
      result: 'allow',
    };

    const denyEntry = lanes.push(deny, 200);
    lanes.push(allow, 120);
    lanes.updateBytes(denyEntry, 150);

    expect(lanes.denialBytes).toBe(150);
    expect(lanes.totalBytes).toBe(270);
    expect(lanes.snapshotEvents().map((event) => event.id)).toEqual(['d-1', 'a-1']);

    expect(lanes.shiftForTotalBudget()?.event.id).toBe('a-1');
    expect(lanes.totalBytes).toBe(150);
    expect(lanes.shiftForTotalBudget()?.event.id).toBe('d-1');
    expect(lanes.totalBytes).toBe(0);
  });
});
