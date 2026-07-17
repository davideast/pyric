import { describe, expect, it } from 'bun:test';
import {
  monitorFirebaseActivity,
  type ActivityFeed,
  type ActivityIncident,
} from 'pyric/firestore/internal';
import type { SandboxEvent } from 'pyric/sandbox';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  query,
  where,
} from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';

class TestActivityFeed implements ActivityFeed {
  readonly #listeners = new Set<(event: SandboxEvent) => void>();

  constructor(private readonly events: SandboxEvent[] = []) {}

  history(): readonly SandboxEvent[] {
    return this.events;
  }

  subscribe(listener: (event: SandboxEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: SandboxEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function appRead(id: string, at: number): SandboxEvent {
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
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    },
  };
}

function appReadAs(id: string, at: number, uid: string): SandboxEvent {
  return {
    ...appRead(id, at),
    auth: { uid },
  };
}

function canonicalAppRead(id: string, at: number): SandboxEvent {
  return {
    kind: 'operation',
    id,
    at,
    service: 'firestore',
    method: 'get',
    path: 'users/alice',
    auth: { uid: 'alice' },
    result: 'allow',
    origin: 'user',
    operationContext: {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    },
  };
}

function appListener(
  id: string,
  at: number,
  phase: 'attach' | 'detach',
  listenerId: string,
  path = 'users/alice',
): SandboxEvent {
  return {
    kind: phase === 'attach' ? 'listener_attach' : 'listener_detach',
    id,
    at,
    listenerId,
    target: { kind: 'doc', path },
    auth: { uid: 'alice' },
    operationContext: {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    },
  };
}

function canonicalAppListener(
  id: string,
  at: number,
  phase: 'attach' | 'errored',
  listenerId: string,
): SandboxEvent {
  return {
    kind: 'listener',
    service: 'firestore',
    id,
    at,
    phase,
    listenerId,
    target: { kind: 'doc', path: 'users/alice' },
    auth: null,
    operationContext: {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    },
  };
}

function appQuery(id: string, at: number, query: unknown): SandboxEvent {
  return {
    ...appRead(id, at),
    method: 'list',
    path: 'users',
    detail: { query },
  } as SandboxEvent;
}

function appQueryWithActivityShape(id: string, at: number, activityQuery: unknown): SandboxEvent {
  return {
    ...appRead(id, at),
    method: 'list',
    path: 'users',
    detail: { query: {}, activityQuery },
  } as SandboxEvent;
}

function boundary(id: string, at: number): SandboxEvent {
  return {
    kind: 'session_boundary',
    id,
    at,
    phase: 'reset',
    eventCount: 0,
  } as SandboxEvent;
}

describe('Firebase activity monitor', () => {
  it('reports repeated identical app reads without replaying a hydrated warning', () => {
    const feed = new TestActivityFeed([
      appRead('read-1', 100),
      appRead('read-2', 200),
      appRead('read-3', 300),
      appRead('read-4', 400),
      appRead('read-5', 500),
    ]);
    const warnings: ActivityIncident[] = [];

    const monitor = monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    expect(monitor.report().incidents).toEqual([
      expect.objectContaining({
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
        usage: {
          unit: 'document-reads',
          lowerBound: 5,
          limitations: [
            'Observed sandbox reads are a lower bound; production cache and billing behavior are not measured.',
          ],
        },
        sourceAttribution: 'unattributed',
        evidenceEventIds: ['read-1', 'read-2', 'read-3', 'read-4', 'read-5'],
      }),
    ]);
    expect(warnings).toEqual([]);

    feed.emit(appRead('read-6', 600));
    feed.emit(appRead('read-7', 700));

    expect(warnings).toEqual([]);
    feed.emit(appRead('read-8', 800));
    feed.emit(appRead('read-9', 900));
    feed.emit(appRead('read-10', 1_000));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ pattern: 'repeated-read', count: 5 });
  });

  it('does not report Strict Mode\'s expected double read invocation', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    const monitor = monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    // React Strict Mode runs the initial effect twice: two identical reads.
    feed.emit(appRead('strict-read-1', 100));
    feed.emit(appRead('strict-read-2', 150));

    expect(warnings).toEqual([]);
    expect(monitor.report().incidents).toEqual([]);
  });

  it('keeps an active fingerprint deduplicated under fingerprint eviction pressure', () => {
    const readAt = (id: string, at: number, path: string): SandboxEvent =>
      ({ ...appRead(id, at), path }) as SandboxEvent;
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    // Make one hot fingerprint incident-active, then flood well past the
    // fingerprint bound with cold fingerprints while the hot one stays live.
    for (let read = 0; read < 5; read += 1) {
      feed.emit(readAt(`hot-0-${read}`, read, 'hot/doc'));
    }
    for (let target = 1; target <= 300; target += 1) {
      const base = target * 10;
      for (let read = 0; read < 5; read += 1) {
        feed.emit(readAt(`cold-${target}-${read}`, base + read, `cold/doc-${target}`));
      }
      feed.emit(readAt(`hot-${target}`, base + 5, 'hot/doc'));
    }

    const hotWarnings = warnings.filter(
      (incident) => incident.targetFingerprint === 'hot/doc',
    );
    // Exactly one initial warning plus one escalation to critical; eviction
    // pressure must never re-notify the still-hot fingerprint at an
    // unchanged severity.
    expect(hotWarnings.map((incident) => incident.severity)).toEqual([
      'warning',
      'critical',
    ]);
  });

  it('reports three concurrent listeners on one target as a duplicate', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    feed.emit(appListener('attach-1', 100, 'attach', 'listener-1'));
    feed.emit(appListener('attach-2', 200, 'attach', 'listener-2'));
    feed.emit(appListener('attach-3', 300, 'attach', 'listener-3'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      pattern: 'duplicate-listener',
      confidence: 'medium',
      severity: 'warning',
      service: 'firestore',
      method: 'listen',
      targetFingerprint: '{"kind":"doc","path":"users/alice"}',
      actor: { kind: 'app' },
      authLens: { mode: 'app-session' },
      authUid: 'alice',
      count: 3,
      listenerBalance: { attaches: 3, detaches: 0, active: 3 },
      usage: {
        unit: 'listener-attaches',
        lowerBound: 3,
        limitations: [
          'Listener lifecycle events count attachments; document deliveries and production billing are not measured.',
        ],
      },
      sourceAttribution: 'unattributed',
      evidenceEventIds: ['attach-1', 'attach-2', 'attach-3'],
    });
  });

  it('detects duplicate listeners through the Firebase-shaped in-page app seam', () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(
      sandbox,
      { projectId: 'activity-monitor-test' },
      `activity-monitor-${Math.random().toString(36).slice(2)}`,
    );
    const db = getFirestore(app);
    const warnings: ActivityIncident[] = [];
    const monitor = monitorFirebaseActivity(
      {
        history: () => sandbox.history(),
        subscribe: (listener) => sandbox.onEvent(listener),
      },
      (incident) => warnings.push(incident),
    );

    const unsubscribes = [
      onSnapshot(doc(db, 'users/alice'), () => {}),
      onSnapshot(doc(db, 'users/alice'), () => {}),
      onSnapshot(doc(db, 'users/alice'), () => {}),
    ];

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      pattern: 'duplicate-listener',
      actor: { kind: 'app' },
      authLens: { mode: 'app-session' },
    });
    for (const unsubscribe of unsubscribes) unsubscribe();
    monitor.dispose();
  });

  it('does not report terminally errored listeners as active duplicates', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, `rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents {
        match /{document=**} { allow read: if false; }
      }
    }`);
    const app = createAppForSandbox(
      sandbox,
      { projectId: 'activity-monitor-error-test' },
      `activity-monitor-error-${Math.random().toString(36).slice(2)}`,
    );
    const db = getFirestore(app);
    const warnings: ActivityIncident[] = [];
    const errors: unknown[] = [];
    const monitor = monitorFirebaseActivity(
      {
        history: () => sandbox.history(),
        subscribe: (listener) => sandbox.onEvent(listener),
      },
      (incident) => warnings.push(incident),
    );

    for (let index = 0; index < 3; index += 1) {
      onSnapshot(
        doc(db, 'users/alice'),
        () => {},
        (error) => errors.push(error),
      );
      await Promise.resolve();
    }

    expect(errors).toHaveLength(3);
    expect(sandbox.history().filter((event) => event.kind === 'listener_errored')).toHaveLength(3);
    expect(warnings).toEqual([]);
    monitor.dispose();

    const canonicalFeed = new TestActivityFeed();
    const canonicalWarnings: ActivityIncident[] = [];
    monitorFirebaseActivity(canonicalFeed, (incident) => canonicalWarnings.push(incident));
    for (let index = 0; index < 3; index += 1) {
      const listenerId = `canonical-${index}`;
      canonicalFeed.emit(canonicalAppListener(`attach-${index}`, index, 'attach', listenerId));
      canonicalFeed.emit(canonicalAppListener(`error-${index}`, index + 1, 'errored', listenerId));
    }
    expect(canonicalWarnings).toEqual([]);
  });

  it('reports listener attach/detach churn but ignores the Strict Mode probe', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    // React Strict Mode intentionally mounts, cleans up, and mounts once more.
    feed.emit(appListener('strict-a1', 100, 'attach', 'strict-1', 'strict/doc'));
    feed.emit(appListener('strict-d1', 150, 'detach', 'strict-1', 'strict/doc'));
    feed.emit(appListener('strict-a2', 200, 'attach', 'strict-2', 'strict/doc'));
    expect(warnings).toEqual([]);

    feed.emit(appListener('churn-a1', 300, 'attach', 'churn-1', 'churn/doc'));
    feed.emit(appListener('churn-d1', 400, 'detach', 'churn-1', 'churn/doc'));
    feed.emit(appListener('churn-a2', 500, 'attach', 'churn-2', 'churn/doc'));
    feed.emit(appListener('churn-d2', 600, 'detach', 'churn-2', 'churn/doc'));
    feed.emit(appListener('churn-a3', 700, 'attach', 'churn-3', 'churn/doc'));
    feed.emit(appListener('churn-d3', 800, 'detach', 'churn-3', 'churn/doc'));
    feed.emit(appListener('churn-a4', 900, 'attach', 'churn-4', 'churn/doc'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      pattern: 'listener-churn',
      count: 4,
      windowMs: 600,
      usage: { unit: 'listener-attaches', lowerBound: 4 },
    });
  });

  it('does not combine distinct query shapes on the same collection', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    for (let index = 0; index < 3; index += 1) {
      feed.emit(appQuery(`open-${index}`, 100 + index, { where: ['status', '==', 'open'] }));
      feed.emit(appQuery(`closed-${index}`, 200 + index, { where: ['status', '==', 'closed'] }));
    }

    expect(warnings).toEqual([]);
  });

  it('uses the full activity query shape when rules request.query projections match', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    for (let index = 0; index < 3; index += 1) {
      feed.emit(appQueryWithActivityShape(
        `open-${index}`,
        100 + index,
        { where: [{ field: 'status', op: '==', value: 'open' }] },
      ));
      feed.emit(appQueryWithActivityShape(
        `closed-${index}`,
        200 + index,
        { where: [{ field: 'status', op: '==', value: 'closed' }] },
      ));
    }

    expect(warnings).toEqual([]);
  });

  it('keeps long query identities bounded and opaque', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));
    const values = Array.from({ length: 30 }, (_, index) => `${index}:${'x'.repeat(103)}`);
    const activityQuery = {
      filters: [{ kind: 'where', field: 'tag', op: 'in', value: values }],
    };

    for (let index = 0; index < 5; index += 1) {
      feed.emit(appQueryWithActivityShape(`long-${index}`, 100 + index, activityQuery));
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.targetFingerprint.length).toBeLessThanOrEqual(1_800);
    expect(warnings[0]!.fingerprint.length).toBeLessThanOrEqual(1_800);
    expect(warnings[0]!.targetFingerprint).toMatch(/^users\|query:#\d+$/);
    expect(warnings[0]!.fingerprint).toMatch(/^activity:#\d+$/);
    expect(JSON.stringify(warnings[0])).not.toContain('x'.repeat(103));
  });

  it('compacts long document paths into route-valid incident messages', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));
    const path = `parents/${'p'.repeat(1_500)}/children/${'c'.repeat(1_500)}`;

    for (let index = 0; index < 5; index += 1) {
      feed.emit({ ...appRead(`long-path-${index}`, 100 + index), path });
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message.length).toBeLessThanOrEqual(2_000);
    expect(warnings[0]!.message).toMatch(/…#[0-9a-f]{16}: 5 reads in 4ms\.$/);
  });

  it('does not combine repeated reads from different application identities', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    feed.emit(appReadAs('alice-1', 100, 'alice'));
    feed.emit(appReadAs('bob-1', 150, 'bob'));
    feed.emit(appReadAs('alice-2', 200, 'alice'));
    feed.emit(appReadAs('bob-2', 250, 'bob'));
    feed.emit(appReadAs('alice-3', 300, 'alice'));

    expect(warnings).toEqual([]);
  });

  it('deduplicates a fingerprint until its severity materially escalates', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    for (let index = 0; index < 19; index += 1) {
      feed.emit(appRead(`read-${index}`, 100 + index * 10));
    }
    expect(warnings.map((incident) => incident.severity)).toEqual(['warning']);

    feed.emit(appRead('read-19', 290));
    expect(warnings.map((incident) => incident.severity)).toEqual(['warning', 'critical']);

    for (let index = 20; index < 30; index += 1) {
      feed.emit(appRead(`read-${index}`, 100 + index * 10));
    }
    expect(warnings.map((incident) => incident.severity)).toEqual(['warning', 'critical']);
  });

  it('counts legacy and canonical representations of one event only once', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    for (let index = 0; index < 3; index += 1) {
      const id = `logical-${index}`;
      const at = 100 + index * 10;
      feed.emit(appRead(id, at));
      feed.emit(canonicalAppRead(id, at));
    }

    expect(warnings).toEqual([]);
  });

  it('does not expose custom-token claims in incident diagnostics', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    for (let index = 0; index < 5; index += 1) {
      feed.emit({
        ...appRead(`as-${index}`, 100 + index),
        auth: { uid: 'alice', token: { admin: true, secret: 'claim' } },
        operationContext: {
          source: { kind: 'app' },
          authLens: { mode: 'as', uid: 'alice', token: { admin: true, secret: 'claim' } },
        },
      });
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.authLens).toEqual({ mode: 'as', uid: 'alice' });
    expect(JSON.stringify(warnings[0])).not.toContain('secret');
  });

  it('resets counters at session boundaries', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    for (let index = 0; index < 4; index += 1) {
      feed.emit(appRead(`before-${index}`, 100 + index));
    }
    feed.emit(boundary('reset', 200));
    for (let index = 0; index < 4; index += 1) {
      feed.emit(appRead(`after-${index}`, 300 + index));
    }

    expect(warnings).toEqual([]);
  });

  it('excludes grouped, setup, admin-lens, and non-app reads', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    monitorFirebaseActivity(feed, (incident) => warnings.push(incident));

    const excluded: SandboxEvent[] = [
      { ...appRead('batch', 100), origin: 'batch', groupId: 'batch-1', groupKind: 'batch' },
      { ...appRead('transaction', 200), origin: 'transaction', groupId: 'tx-1', groupKind: 'transaction' },
      { ...appRead('seed', 300), detail: { admin: true } },
      {
        ...appRead('admin-lens', 400),
        operationContext: { source: { kind: 'app' }, authLens: { mode: 'admin' } },
      },
      {
        ...appRead('studio', 500),
        operationContext: { source: { kind: 'studio' }, authLens: { mode: 'anon' } },
      },
      {
        ...appRead('agent', 600),
        operationContext: {
          source: { kind: 'agent', name: 'builder' },
          authLens: { mode: 'anon' },
          planId: 'plan-1',
        },
      },
      {
        ...appRead('unknown', 700),
        operationContext: { source: { kind: 'unattributed' }, authLens: { mode: 'anon' } },
      },
    ];
    for (let repeat = 0; repeat < 5; repeat += 1) {
      for (const event of excluded) feed.emit({ ...event, id: `${event.id}-${repeat}` });
    }

    expect(warnings).toEqual([]);
  });

  it('keeps evidence and reported incident cardinality bounded', () => {
    const history: SandboxEvent[] = [];
    for (let path = 0; path < 80; path += 1) {
      for (let repeat = 0; repeat < 12; repeat += 1) {
        history.push({
          ...appRead(`read-${path}-${repeat}`, path * 10_000 + repeat),
          path: `items/${path}`,
        });
      }
    }

    const monitor = monitorFirebaseActivity(new TestActivityFeed(history), () => {});

    expect(monitor.report().incidents.length).toBeLessThanOrEqual(64);
    expect(monitor.report().incidents.every(
      (incident) => incident.evidenceEventIds.length <= 8,
    )).toBe(true);
  });

  it('marks listener counts as lower bounds after bounded retention saturates', () => {
    const feed = new TestActivityFeed();
    const warnings: ActivityIncident[] = [];
    const monitor = monitorFirebaseActivity(feed, (incident) => warnings.push(incident));
    for (let index = 0; index < 92; index += 1) {
      feed.emit(appListener(`attach-${index}`, 100 + index, 'attach', `listener-${index}`));
    }

    const incident = monitor.report().incidents.find(
      (candidate) => candidate.pattern === 'duplicate-listener',
    );
    expect(incident).toMatchObject({
      count: 32,
      listenerBalance: { active: 32, isLowerBound: true },
      usage: { lowerBound: 32 },
    });
    expect(incident!.usage.limitations).toContain(
      'Listener retention saturated; reported counts are observed lower bounds.',
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.at(-1)?.severity).toBe('critical');
    expect(warnings.at(-1)?.listenerBalance?.isLowerBound).not.toBe(true);
    monitor.dispose();
  });

  it('never lets a warning callback change application behavior', () => {
    const feed = new TestActivityFeed();
    monitorFirebaseActivity(feed, () => {
      throw new Error('broken warning sink');
    });

    expect(() => {
      for (let index = 0; index < 5; index += 1) {
        feed.emit(appRead(`safe-${index}`, 100 + index));
      }
    }).not.toThrow();
  });
});
