import { describe, expect, it } from 'bun:test';
import {
  liveRulesDecisionEvents,
  localDriftCount,
  localUnevaluatedCount,
  productionDeniedCount,
} from '../../../src/features/traffic/live-verdict.js';
import type { StudioTrafficEvent } from '../../../src/features/traffic/verdict.js';

describe('live-verdict', () => {
  it('projects decided local advisory verdicts for live Rules metrics and counts drift, unevaluated, and production denials', () => {
    const events = [
      {
        id: 'op-1',
        at: 100,
        result: 'allow' as const,
        production: { outcome: { status: 'ok' as const }, local: { result: 'allow' as const } },
      },
      {
        id: 'op-2',
        at: 150,
        result: 'allow' as const,
        production: {
          outcome: { status: 'ok' as const },
          local: { result: 'deny' as const, drift: true as const },
        },
      },
      {
        id: 'op-3',
        at: 180,
        result: 'deny' as const,
        production: {
          outcome: { status: 'error' as const, code: 'permission-denied' },
          local: { result: 'unevaluated' as const, needs: ['stored-document' as const] },
        },
      },
      {
        id: 'op-4',
        at: 250,
        result: 'deny' as const,
        production: {
          outcome: { status: 'error' as const, code: 'permission_denied' },
          local: { result: 'deny' as const },
        },
      },
    ] as unknown as StudioTrafficEvent[];

    expect(liveRulesDecisionEvents(events).map((e) => ({ at: e.at, result: e.result }))).toEqual([
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

    expect(liveRulesDecisionEvents(events)).toHaveLength(1);
    expect(liveRulesDecisionEvents(events)[0]?.id).toBe('rt-1');
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

    expect(liveRulesDecisionEvents(events).map((e) => ({ id: e.id, result: e.result }))).toEqual([
      { id: 'rt-allow-1', result: 'allow' },
      { id: 'rt-deny-1', result: 'deny' },
    ]);
    expect(localDriftCount(events, { start: 100, end: 200 })).toBe(1);
  });
});
