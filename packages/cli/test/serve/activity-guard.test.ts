import { describe, expect, it } from 'bun:test';
import type { ActivityFeed, ActivityIncident } from 'pyric/firestore/internal';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  setupFirebaseActivityGuard,
  setupStreamedFirebaseActivityGuard,
} from '../../src/serve/activity-guard.js';
import { formatActivityWarning } from '../../src/serve/activity-warning.js';

describe('pyric dev Firebase activity guard', () => {
  it('posts a structured incident from the shared browser-safe feed seam', () => {
    const listeners = new Set<(event: SandboxEvent) => void>();
    const feed: ActivityFeed = {
      history: () => [],
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    setupFirebaseActivityGuard(feed, fetchFn, 'activity-test-token');
    for (let index = 0; index < 5; index += 1) {
      const event: SandboxEvent = {
        kind: 'request',
        id: `read-${index}`,
        at: 100 + index,
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
      for (const listener of listeners) listener(event);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/__pyric/activity');
    expect(requests[0]?.init?.headers).toEqual({
      'content-type': 'application/json',
      'x-pyric-activity-token': 'activity-test-token',
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      pattern: 'repeated-read',
      method: 'get',
      targetFingerprint: 'users/alice',
      sourceAttribution: 'app',
    });
  });

  it('monitors streamed hosted events for duplicate-listener and listener-churn without replaying history', () => {
    let deliver: ((events: readonly SandboxEvent[], batch: { readonly history: boolean }) => void) | null = null;
    const requests: ActivityIncident[] = [];
    const fetchFn = ((_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')) as ActivityIncident);
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    const monitor = setupStreamedFirebaseActivityGuard(
      (callback) => {
        deliver = callback;
        return () => {
          deliver = null;
        };
      },
      fetchFn,
      'hosted-activity-token',
    );

    const pushBatch = (events: readonly SandboxEvent[], history: boolean): void => {
      if (deliver !== null) {
        deliver(events, { history });
      }
    };

    const historicalAttaches: SandboxEvent[] = [0, 1, 2].map((index) => ({
      kind: 'listener_attach',
      id: `hist-attach-${index}`,
      at: 50 + index,
      listenerId: `hist-l-${index}`,
      target: { kind: 'doc', path: 'todos/t1' },
      auth: { uid: 'alice' },
      operationContext: {
        source: { kind: 'app', journeyId: 'hosted-page-1' },
        authLens: { mode: 'app-session' },
      },
    } as SandboxEvent));

    pushBatch(historicalAttaches, true);
    expect(requests).toEqual([]);
    expect(monitor.report().incidents).toHaveLength(1);

    for (let index = 0; index < 3; index += 1) {
      pushBatch([{
        kind: 'listener_attach',
        id: `live-dup-${index}`,
        at: 500 + index,
        listenerId: `live-l-${index}`,
        target: { kind: 'doc', path: 'todos/t1' },
        auth: { uid: 'alice' },
        operationContext: {
          source: { kind: 'app', journeyId: 'hosted-page-1' },
          authLens: { mode: 'app-session' },
        },
      } as SandboxEvent], false);
    }

    expect(requests).toHaveLength(1);
    const duplicate = requests[0];
    expect(duplicate?.pattern).toBe('duplicate-listener');
    if (duplicate) {
      const terminalLine = formatActivityWarning(duplicate);
      expect(terminalLine).toContain('3 duplicate active Firestore listeners on todos/t1');
      expect(terminalLine).toContain('Source: app hosted-page-1.');
    }

    for (let index = 0; index < 4; index += 1) {
      const listenerId = `churn-l-${index}`;
      pushBatch([{
        kind: 'listener_attach',
        id: `churn-a-${index}`,
        at: 900 + index * 2,
        listenerId,
        target: { kind: 'doc', path: 'todos/t2' },
        auth: { uid: 'alice' },
        operationContext: {
          source: { kind: 'app', journeyId: 'hosted-page-1' },
          authLens: { mode: 'app-session' },
        },
      } as SandboxEvent], false);
      if (index < 3) {
        pushBatch([{
          kind: 'listener_detach',
          id: `churn-d-${index}`,
          at: 901 + index * 2,
          listenerId,
          target: { kind: 'doc', path: 'todos/t2' },
          auth: { uid: 'alice' },
          operationContext: {
            source: { kind: 'app', journeyId: 'hosted-page-1' },
            authLens: { mode: 'app-session' },
          },
        } as SandboxEvent], false);
      }
    }

    expect(requests).toHaveLength(2);
    expect(requests[1]?.pattern).toBe('listener-churn');

    monitor.dispose();
  });
});
