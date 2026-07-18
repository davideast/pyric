import { describe, expect, it } from 'bun:test';
import type { ActivityFeed } from 'pyric/firestore/internal';
import type { SandboxEvent } from 'pyric/sandbox';
import { setupFirebaseActivityGuard } from '../../src/serve/activity-guard.js';

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
});
