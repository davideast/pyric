import { describe, expect, it } from 'bun:test';
import {
  ACTIVITY_CONTRACT,
  hasGeneratedActivitySemantics,
} from '../../../src/firestore/sandbox/activity-contract.js';
import type { ActivityIncident } from '../../../src/firestore/sandbox/activity-monitor.js';

function incident(overrides: Partial<ActivityIncident> = {}): ActivityIncident {
  return {
    fingerprint: 'activity:#1',
    pattern: 'repeated-read',
    confidence: 'high',
    severity: 'warning',
    service: 'firestore',
    method: 'get',
    targetFingerprint: 'users/alice',
    actor: { kind: 'app' },
    authLens: { mode: 'app-session' },
    authUid: null,
    count: ACTIVITY_CONTRACT.readThreshold,
    windowMs: ACTIVITY_CONTRACT.readWindowMs,
    usage: { unit: 'document-reads', lowerBound: 5, limitations: [] },
    evidenceEventIds: ['event-1'],
    sourceAttribution: 'app',
    ...overrides,
  };
}

describe('hasGeneratedActivitySemantics', () => {
  it('accepts read thresholds and enforces the critical severity boundary', () => {
    expect(hasGeneratedActivitySemantics(incident())).toBe(true);
    expect(hasGeneratedActivitySemantics(incident({
      count: ACTIVITY_CONTRACT.criticalReadThreshold,
      severity: 'critical',
    }))).toBe(true);
    expect(hasGeneratedActivitySemantics(incident({ count: 4 }))).toBe(false);
    expect(hasGeneratedActivitySemantics(incident({
      count: ACTIVITY_CONTRACT.criticalReadThreshold,
      severity: 'warning',
    }))).toBe(false);
  });

  it('rejects read windows and retained counts beyond producer bounds', () => {
    expect(hasGeneratedActivitySemantics(incident({
      windowMs: ACTIVITY_CONTRACT.readWindowMs + 1,
    }))).toBe(false);
    expect(hasGeneratedActivitySemantics(incident({
      count: ACTIVITY_CONTRACT.maxEventsPerFingerprint + 1,
      severity: 'critical',
    }))).toBe(false);
  });

  it('requires duplicate-listener balances to match active count', () => {
    const duplicate = incident({
      pattern: 'duplicate-listener',
      method: 'listen',
      confidence: 'medium',
      count: ACTIVITY_CONTRACT.duplicateListenerThreshold,
      listenerBalance: { attaches: 3, detaches: 0, active: 3 },
      usage: { unit: 'listener-attaches', lowerBound: 3, limitations: [] },
    });
    expect(hasGeneratedActivitySemantics(duplicate)).toBe(true);
    expect(hasGeneratedActivitySemantics({
      ...duplicate,
      listenerBalance: { attaches: 3, detaches: 0, active: 2 },
    })).toBe(false);
  });

  it('requires churn detach and window thresholds', () => {
    const churn = incident({
      pattern: 'listener-churn',
      method: 'listen',
      count: ACTIVITY_CONTRACT.churnAttachThreshold,
      windowMs: ACTIVITY_CONTRACT.listenerWindowMs,
      listenerBalance: { attaches: 4, detaches: 3, active: 1 },
      usage: { unit: 'listener-attaches', lowerBound: 4, limitations: [] },
    });
    expect(hasGeneratedActivitySemantics(churn)).toBe(true);
    expect(hasGeneratedActivitySemantics({
      ...churn,
      listenerBalance: { attaches: 4, detaches: 2, active: 2 },
    })).toBe(false);
    expect(hasGeneratedActivitySemantics({
      ...churn,
      windowMs: ACTIVITY_CONTRACT.listenerWindowMs + 1,
    })).toBe(false);
  });
});
