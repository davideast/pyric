import { describe, expect, it } from 'bun:test';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { formatActivityWarning } from '../../src/serve/activity-warning.js';

function incident(overrides: Partial<ActivityIncident> = {}): ActivityIncident {
  return {
    fingerprint: 'segment:0|read:get:users/alice',
    pattern: 'repeated-read',
    confidence: 'high',
    severity: 'warning',
    service: 'firestore',
    method: 'get',
    targetFingerprint: 'users/alice',
    actor: { kind: 'app' },
    authLens: { mode: 'app-session' },
    authUid: 'alice',
    count: 5,
    windowMs: 400,
    usage: { unit: 'document-reads', lowerBound: 5, limitations: [] },
    evidenceEventIds: ['read-1', 'read-2'],
    sourceAttribution: 'unattributed',
    message: 'browser-controlled text is not rendered',
    ...overrides,
  };
}

describe('formatActivityWarning', () => {
  it('does not trust browser-provided terminal text or control sequences', () => {
    const warning = formatActivityWarning(incident({
      targetFingerprint: 'users/\u001b]8;;https://example.invalid\u0007alice',
      message: '\u001b[2Jforged terminal warning',
    }));

    expect(warning).not.toContain('forged terminal warning');
    expect(warning).not.toContain('\u001b');
    expect(warning).not.toContain('\u0007');
    expect(warning).toContain('5 repeated Firestore get operations');
  });

  it('strips Unicode bidi and line controls from terminal targets', () => {
    const warning = formatActivityWarning(incident({
      targetFingerprint: 'users/\u202Ereversed\u202C\u2028  forged:\u2066target\u2069',
    }));

    expect(warning).not.toContain('\u202E');
    expect(warning).not.toContain('\u202C');
    expect(warning).not.toContain('\u2028');
    expect(warning).not.toContain('\u2066');
    expect(warning).not.toContain('\u2069');
    expect(warning).not.toContain('\n');
    expect(warning).toContain('users/reversed  forged:target');
  });

  it('distinguishes duplicate listeners from listener churn', () => {
    const duplicate = formatActivityWarning(incident({
      pattern: 'duplicate-listener',
      confidence: 'medium',
      method: 'listen',
      count: 3,
      usage: { unit: 'listener-attaches', lowerBound: 3, limitations: [] },
      listenerBalance: { attaches: 3, detaches: 0, active: 3 },
    }));
    expect(duplicate).toContain('3 duplicate active Firestore listeners');

    const churn = formatActivityWarning(incident({
      pattern: 'listener-churn',
      method: 'listen',
      count: 4,
      usage: { unit: 'listener-attaches', lowerBound: 4, limitations: [] },
      listenerBalance: { attaches: 4, detaches: 3, active: 1, isLowerBound: true },
    }));
    expect(churn).toContain('at least 4 Firestore listener attaches, 3 detaches, 1 still active');
    expect(churn).toContain('(listener churn)');
  });
});
