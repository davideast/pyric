import { describe, expect, it } from 'bun:test';
import {
  liveBypassedCount,
  liveRulesDecisionEvents,
  localDriftCount,
  localUnevaluatedCount,
  observedListenerVerdictKey,
  productionDeniedCount,
} from '../../../src/features/traffic/live-verdict.js';
import type { StudioTrafficEvent } from '../../../src/features/traffic/verdict.js';

const FULL_WINDOW = { start: 0, end: 500 };

describe('live-verdict', () => {
  it('projects decided local advisory verdicts for live Rules metrics and counts drift, unevaluated, and production denials', () => {
    const events = [
      {
        id: 'op-1',
        at: 100,
        result: 'allow' as const,
        rulesDisposition: { kind: 'not-evaluated' as const, reason: 'external-execution' as const },
        production: { outcome: { status: 'ok' as const }, local: { result: 'allow' as const } },
      },
      {
        id: 'op-2',
        at: 150,
        result: 'allow' as const,
        rulesDisposition: { kind: 'not-evaluated' as const, reason: 'external-execution' as const },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
      {
        id: 'op-3',
        at: 180,
        result: 'deny' as const,
        rulesDisposition: { kind: 'not-evaluated' as const, reason: 'external-execution' as const },
        production: {
          outcome: { status: 'error' as const, code: 'permission-denied' },
          local: { result: 'unevaluated' as const, needs: ['stored-document' as const] },
        },
      },
      {
        id: 'op-4',
        at: 250,
        result: 'deny' as const,
        rulesDisposition: { kind: 'not-evaluated' as const, reason: 'external-execution' as const },
        production: {
          outcome: { status: 'error' as const, code: 'permission_denied' },
          local: { result: 'deny' as const },
        },
      },
    ] as unknown as StudioTrafficEvent[];

    expect(
      liveRulesDecisionEvents(events, FULL_WINDOW).map((e) => ({ at: e.at, result: e.result })),
    ).toEqual([
      { at: 100, result: 'allow' },
      { at: 150, result: 'deny' },
      { at: 250, result: 'deny' },
    ]);
    expect(localDriftCount(events, { start: 100, end: 200 })).toBe(1);
    expect(localUnevaluatedCount(events, { start: 100, end: 200 })).toBe(1);
    expect(productionDeniedCount(events, { start: 100, end: 300 })).toBe(2);
  });

  it('counts recurring RTDB listener deliveries at most once per subscription listenerId', () => {
    const events = [
      {
        id: 'rt-1',
        at: 110,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-rt' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
      {
        id: 'rt-2',
        at: 120,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-rt' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
      {
        id: 'rt-3',
        at: 130,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-rt' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
    ] as unknown as StudioTrafficEvent[];

    expect(observedListenerVerdictKey(events[0]!)).toBe('page:tab-1:l-rt:deny:true');
    expect(liveRulesDecisionEvents(events, FULL_WINDOW)).toHaveLength(1);
    expect(liveRulesDecisionEvents(events, FULL_WINDOW)[0]?.id).toBe('rt-1');
    expect(localDriftCount(events, { start: 100, end: 200 })).toBe(1);
  });

  it('preserves a later deny or drift transition on an attached RTDB listener while still deduplicating steady-state pushes', () => {
    const events = [
      {
        id: 'rt-allow-1',
        at: 110,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-transition' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'allow' as const },
        },
      },
      {
        id: 'rt-allow-2',
        at: 120,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-transition' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'allow' as const },
        },
      },
      {
        id: 'rt-deny-1',
        at: 150,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-transition' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
      {
        id: 'rt-deny-2',
        at: 160,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-transition' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
    ] as unknown as StudioTrafficEvent[];

    expect(
      liveRulesDecisionEvents(events, FULL_WINDOW).map((e) => ({ id: e.id, result: e.result })),
    ).toEqual([
      { id: 'rt-allow-1', result: 'allow' },
      { id: 'rt-deny-1', result: 'deny' },
    ]);
    expect(localDriftCount(events, { start: 100, end: 200 })).toBe(1);
  });

  it('filters to [window.start, window.end) BEFORE deduplicating listeners so brushed sub-intervals keep active listener evaluations', () => {
    const events = [
      {
        id: 'rt-before-window',
        at: 50,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-subwindow' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
      {
        id: 'rt-in-window-1',
        at: 120,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-subwindow' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
      {
        id: 'rt-in-window-2',
        at: 140,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-subwindow' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
      {
        id: 'uneval-before-window',
        at: 60,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-uneval' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'unevaluated' as const, needs: ['stored-document' as const] },
        },
      },
      {
        id: 'uneval-in-window',
        at: 150,
        service: 'rtdb',
        method: 'onValue',
        result: 'allow' as const,
        detail: { listenerId: 'page:tab-1:l-uneval' },
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'unevaluated' as const, needs: ['stored-document' as const] },
        },
      },
    ] as unknown as StudioTrafficEvent[];

    const brushedWindow = { start: 100, end: 200 };
    const decided = liveRulesDecisionEvents(events, brushedWindow);
    expect(decided.map((event) => event.id)).toEqual(['rt-in-window-1']);
    expect(localDriftCount(events, brushedWindow)).toBe(1);
    expect(localUnevaluatedCount(events, brushedWindow)).toBe(1);
  });

  it('counts Admin-bypassed operations within [window.start, window.end)', () => {
    const events = [
      {
        id: 'admin-early',
        at: 50,
        rulesDisposition: { kind: 'bypassed' as const, reason: 'admin' as const },
      },
      {
        id: 'admin-in-window',
        at: 125,
        rulesDisposition: { kind: 'bypassed' as const, reason: 'admin' as const },
      },
      {
        id: 'client-in-window',
        at: 150,
        rulesDisposition: { kind: 'not-evaluated' as const, reason: 'external-execution' as const },
      },
    ] as unknown as StudioTrafficEvent[];

    expect(liveBypassedCount(events, { start: 100, end: 200 })).toBe(1);
    expect(liveBypassedCount(events, { start: 0, end: 200 })).toBe(2);
  });
});
