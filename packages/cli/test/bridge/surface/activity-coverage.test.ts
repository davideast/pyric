/**
 * Coverage accounting for `sandbox.activity`: every `SandboxEvent` kind maps
 * cleanly to its service, excludes stream control markers, and formats exact
 * unexamined service counts for the summary.
 */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';

import {
  formatActivitySummary,
  summarizeActivityCoverage,
} from '../../../src/bridge/surface/activity-coverage.js';

describe('summarizeActivityCoverage', () => {
  it('returns firestore-only coverage with empty notExamined when there are no events', () => {
    const coverage = summarizeActivityCoverage([]);
    expect(coverage).toEqual({
      examined: ['firestore'],
      notExamined: [],
    });
    expect(formatActivitySummary(0, coverage)).toBe('0 incident(s). Examined firestore only.');
  });

  it('treats legacy Firestore events without a service field as examined', () => {
    const events: SandboxEvent[] = [
      {
        kind: 'request',
        id: 'evt-1',
        at: 1,
        evalMs: 0,
        method: 'get',
        path: 'items/a',
        auth: null,
        result: 'allow',
        reasons: [],
        origin: 'user',
      },
      {
        kind: 'listener_attach',
        id: 'evt-2',
        at: 2,
        listenerId: 'l-1',
        target: { kind: 'doc', path: 'items/a' },
        auth: null,
      },
    ];
    const coverage = summarizeActivityCoverage(events);
    expect(coverage).toEqual({
      examined: ['firestore'],
      notExamined: [],
    });
    expect(formatActivitySummary(1, coverage)).toBe('1 incident(s). Examined firestore only.');
  });

  it('ignores session_boundary and observation_gap stream control events', () => {
    const events: SandboxEvent[] = [
      {
        kind: 'session_boundary',
        id: 'evt-b',
        at: 1,
        phase: 'reset',
        priorOpCount: 0,
      },
      {
        kind: 'observation_gap',
        id: 'evt-g',
        at: 2,
        reason: 'history-limit',
        omittedCount: 10,
        firstEventId: 'evt-1',
        lastEventId: 'evt-10',
      },
    ];
    expect(summarizeActivityCoverage(events)).toEqual({
      examined: ['firestore'],
      notExamined: [],
    });
  });

  it('counts listener and non-listener events per unexamined service in sorted order', () => {
    const events: SandboxEvent[] = [
      {
        kind: 'listener',
        id: 'evt-1',
        at: 1,
        service: 'rtdb',
        phase: 'attach',
        listenerId: 'r-1',
        target: { kind: 'value', path: '/items/a' },
        auth: null,
      },
      {
        kind: 'listener',
        id: 'evt-2',
        at: 2,
        service: 'rtdb',
        phase: 'delivery',
        listenerId: 'r-1',
        target: { kind: 'value', path: '/items/a' },
        auth: null,
      },
      {
        kind: 'operation',
        id: 'evt-3',
        at: 3,
        service: 'rtdb',
        method: 'set',
        path: '/items/a',
        auth: null,
        result: 'allow',
        origin: 'user',
      },
      {
        kind: 'service_mutation',
        id: 'evt-4',
        at: 4,
        service: 'auth',
        op: 'user_create',
        path: 'users/u1',
        auth: null,
      },
      {
        kind: 'runtime_error',
        id: 'evt-5',
        at: 5,
        service: 'storage',
        method: 'uploadBytes',
        path: 'files/a.txt',
        auth: null,
        error: { message: 'failed' },
      },
      {
        kind: 'commit',
        id: 'evt-6',
        at: 6,
        service: 'storage',
        method: 'uploadBytes',
        path: 'files/a.txt',
        auth: null,
      },
    ];
    const coverage = summarizeActivityCoverage(events);
    expect(coverage).toEqual({
      examined: ['firestore'],
      notExamined: [
        { service: 'auth', eventCount: 1, listenerEventCount: 0 },
        { service: 'rtdb', eventCount: 3, listenerEventCount: 2 },
        { service: 'storage', eventCount: 2, listenerEventCount: 0 },
      ],
    });
    expect(formatActivitySummary(0, coverage)).toBe(
      '0 incident(s). Examined firestore only; 1 auth event(s), 3 rtdb event(s) (2 listener), 2 storage event(s) not examined.',
    );
  });

  it('formats listener-only services as listener events', () => {
    const events: SandboxEvent[] = [
      {
        kind: 'listener',
        id: 'evt-1',
        at: 1,
        service: 'rtdb',
        phase: 'attach',
        listenerId: 'r-1',
        target: { kind: 'value', path: '/items/a' },
        auth: null,
      },
    ];
    const coverage = summarizeActivityCoverage(events);
    expect(formatActivitySummary(0, coverage)).toBe(
      '0 incident(s). Examined firestore only; 1 rtdb listener event(s) not examined.',
    );
  });
});
