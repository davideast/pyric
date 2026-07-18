import { describe, expect, it } from 'bun:test';
import {
  monitorFirebaseActivity,
  type ActivityFeed,
  type ActivityIncident,
} from 'pyric/firestore/internal';
import type { SandboxEvent } from 'pyric/sandbox';
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
    sourceAttribution: 'app',
    ...overrides,
  };
}

class TestActivityFeed implements ActivityFeed {
  readonly #listeners = new Set<(event: SandboxEvent) => void>();

  history(): readonly SandboxEvent[] {
    return [];
  }

  subscribe(listener: (event: SandboxEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: SandboxEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function readEvent(
  id: string,
  at: number,
  source: { kind: 'app'; journeyId?: string } | { kind: 'unattributed' },
): SandboxEvent {
  return {
    kind: 'request',
    id,
    at,
    evalMs: 1,
    method: 'get',
    path: 'users/alice',
    auth: { uid: 'alice' },
    result: 'allow',
    reasons: [],
    origin: 'user',
    operationContext: {
      source,
      authLens: { mode: 'app-session' },
    },
  } as SandboxEvent;
}

describe('formatActivityWarning', () => {
  it('is the single source of truth for the warning text', () => {
    expect(formatActivityWarning(incident({ sourceAttribution: 'app page-1' }))).toBe(
      '  \u26a0 Firebase Activity Guard: 5 repeated Firestore get operations on users/alice '
      + 'in 400ms. Observed lower bound: 5 document reads. Source: app page-1. '
      + 'Possible causes include repeated render/effect execution or missing listener '
      + 'cleanup. (warning only; app behavior is unchanged)',
    );
  });

  it('does not trust browser-provided terminal text or control sequences', () => {
    const warning = formatActivityWarning(incident({
      targetFingerprint: 'users/\u001b]8;;https://example.invalid\u0007alice',
    }));

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

  it('prints the attributed source for a monitor-generated incident', () => {
    const feed = new TestActivityFeed();
    const warnings: string[] = [];
    monitorFirebaseActivity(feed, (generated) => warnings.push(formatActivityWarning(generated)));

    for (let index = 0; index < 5; index += 1) {
      feed.emit(readEvent(`journey-${index}`, 100 + index, { kind: 'app', journeyId: 'page-1' }));
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Source: app page-1.');
    expect(warnings[0]).not.toContain('unattributed');
  });

  it('produces no warning for genuinely unattributed traffic', () => {
    const feed = new TestActivityFeed();
    const warnings: string[] = [];
    monitorFirebaseActivity(feed, (generated) => warnings.push(formatActivityWarning(generated)));

    for (let index = 0; index < 10; index += 1) {
      feed.emit(readEvent(`unattributed-${index}`, 100 + index, { kind: 'unattributed' }));
    }

    expect(warnings).toEqual([]);
  });
});
