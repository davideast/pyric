import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.EventTarget = dom.window.EventTarget;
g.Event = dom.window.Event;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { EnvironmentProvider, useEnvironment } from '../../src/shell/environment.js';
import { resetLiveStatusPollerForTesting } from '../../src/shell/live-status.js';
import { resetServeInitForTests } from '../../src/shell/serve-init.js';
import { useStudioDataSource } from '../../src/shell/studio-data.js';

const originalFetch = globalThis.fetch;

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}

function installWorkerShim() {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  const sent: Array<Record<string, unknown>> = [];
  const port = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: Record<string, unknown>) {
      sent.push(msg);
      setTimeout(() => {
        if (msg.t === 'op') {
          const value = msg.method === 'listRootCollections' ? { ids: ['orders'] } : {};
          port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, value } });
        } else if (msg.t === 'sub' && msg.target === 'events') {
          port.onmessage?.({ data: { t: 'event', subId: msg.subId, events: [] } });
        }
      }, 0);
    },
    start() {},
    addEventListener() {},
    close() {},
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = port;
    constructor(_url: unknown, _opts: unknown) {}
  };
  return {
    methods: () =>
      sent
        .filter((m) => m.t === 'op' && m.method !== 'getRuntimeEpoch' && !String(m.method).startsWith('presence.'))
        .map((m) => String(m.method)),
    restore() {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
    },
  };
}

function StudioDataProbe() {
  const state = useStudioDataSource();
  const roots = state.status === 'ready' ? state.handles.listRootCollections().join(',') : '';
  return <div data-status={state.status} data-roots={roots} />;
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 25)));

beforeEach(() => {
  resetLiveStatusPollerForTesting();
  resetServeInitForTests();
});

afterEach(() => {
  cleanup();
  resetLiveStatusPollerForTesting();
  resetServeInitForTests();
  globalThis.fetch = originalFetch;
});

describe('studio-data', () => {
  it('issues zero sandbox worker RPCs on a live host and queries listRootCollections on a sandbox host', async () => {
    let liveMode = true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.endsWith('/__pyric/health')) {
        if (liveMode) {
          return new Response(
            JSON.stringify({
              status: 'ok',
              live: {
                projectId: 'demo-live',
                configProjectId: 'demo-live',
                configSource: '.firebaserc',
                appProjectIds: ['demo-live'],
                billed: { reads: 0, writes: 0, deliveries: 0 },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/__pyric/init.json')) {
        return new Response(JSON.stringify({ seed: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const liveShim = installWorkerShim();
    try {
      render(
        <EnvironmentProvider mode="local">
          <StudioDataProbe />
        </EnvironmentProvider>,
      );
      await flush();
      expect(liveShim.methods()).toEqual([]);
    } finally {
      liveShim.restore();
    }

    cleanup();
    resetLiveStatusPollerForTesting();
    resetServeInitForTests();
    liveMode = false;

    const sandboxShim = installWorkerShim();
    try {
      const view = render(
        <EnvironmentProvider mode="local">
          <StudioDataProbe />
        </EnvironmentProvider>,
      );
      await waitFor(() => expect(view.container.querySelector('[data-roots="orders"]')).not.toBeNull());
      expect(sandboxShim.methods()).toContain('listRootCollections');
    } finally {
      sandboxShim.restore();
    }
  });

  it('deduplicates feed subscriptions and root-collection refreshes across concurrent useStudioDataSource consumers (#390)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.endsWith('/__pyric/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/__pyric/init.json')) {
        return new Response(JSON.stringify({ seed: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    let currentDefaultRoots = ['orders'];
    let currentAnalyticsRoots = ['events'];
    let eventsSubId: string | null = null;
    const prevWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    const port = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage(msg: Record<string, unknown>) {
        setTimeout(() => {
          if (msg.t === 'op') {
            let value: Record<string, unknown> = {};
            if (msg.method === 'getRuntimeEpoch') {
              value = { workerProtocol: 2 };
            } else if (msg.method === 'listRootCollections') {
              const ids = msg.databaseId === 'analytics' ? currentAnalyticsRoots : currentDefaultRoots;
              value = { ids };
            }
            port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, value } });
          } else if (msg.t === 'sub' && msg.target === 'events') {
            eventsSubId = String(msg.subId);
            port.onmessage?.({ data: { t: 'event', subId: msg.subId, events: [] } });
          }
        }, 0);
      },
      start() {},
      addEventListener() {},
      close() {},
    };
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = port;
      constructor(_url: unknown, _opts: unknown) {}
    };

    const telemetry = {
      feedSubscribeCalls: 0,
      feedUnsubscribeCalls: 0,
      listRootsByDb: new Map<string, number>(),
    };
    let wrappedLive: unknown = null;

    function LivePlaneSpy() {
      const env = useEnvironment();
      if (env.status === 'ready' && env.env.live && wrappedLive !== env.env.live) {
        wrappedLive = env.env.live;
        const live = env.env.live;
        const origSubscribe = live.feed.subscribe.bind(live.feed);
        const origListRoots = live.listRootCollections.bind(live);
        live.feed.subscribe = (cb) => {
          telemetry.feedSubscribeCalls += 1;
          const unsub = origSubscribe(cb);
          return () => {
            telemetry.feedUnsubscribeCalls += 1;
            unsub();
          };
        };
        live.listRootCollections = (databaseId?: string) => {
          const key = databaseId ?? '(default)';
          const prior = telemetry.listRootsByDb.get(key) ?? 0;
          telemetry.listRootsByDb.set(key, prior + 1);
          return origListRoots(databaseId);
        };
      }
      return null;
    }

    function NamedConsumer({ id, databaseId }: { id: string; databaseId?: string }) {
      const state = useStudioDataSource(databaseId);
      let roots = '';
      if (state.status === 'ready') {
        roots = state.handles.listRootCollections().join(',');
      }
      return <div data-consumer={id} data-roots={roots} />;
    }

    try {
      const view = render(
        <EnvironmentProvider mode="local">
          <LivePlaneSpy />
          <NamedConsumer id="shell" />
          <NamedConsumer id="index" />
          <NamedConsumer id="home" />
          <NamedConsumer id="analytics-1" databaseId="analytics" />
          <NamedConsumer id="analytics-2" databaseId="analytics" />
        </EnvironmentProvider>,
      );

      await waitFor(() => {
        expect(view.container.querySelector('[data-consumer="shell"][data-roots="orders"]')).not.toBeNull();
        expect(view.container.querySelector('[data-consumer="home"][data-roots="orders"]')).not.toBeNull();
        expect(view.container.querySelector('[data-consumer="analytics-2"][data-roots="events"]')).not.toBeNull();
      });

      // Three default-db consumers + two analytics-db consumers share ONE feed subscription per db (2 total, not 5).
      expect(telemetry.feedSubscribeCalls).toBe(2);
      expect(telemetry.listRootsByDb.get('(default)')).toBe(1);
      expect(telemetry.listRootsByDb.get('analytics')).toBe(1);

      // Materialise a new collection on a live event: each db refreshes once and updates every consumer.
      currentDefaultRoots = ['orders', 'users'];
      await act(async () => {
        port.onmessage?.({
          data: {
            t: 'event',
            subId: eventsSubId,
            events: [
              {
                kind: 'write',
                id: 'w-users',
                at: 10,
                method: 'create',
                path: 'users/u1',
                auth: null,
                priorState: null,
                nextState: {},
                requestTime: { seconds: 0, nanoseconds: 0 },
              },
            ],
          },
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      });

      await waitFor(() => {
        expect(view.container.querySelector('[data-consumer="shell"][data-roots="orders,users"]')).not.toBeNull();
        expect(view.container.querySelector('[data-consumer="index"][data-roots="orders,users"]')).not.toBeNull();
        expect(view.container.querySelector('[data-consumer="home"][data-roots="orders,users"]')).not.toBeNull();
      });
      expect(telemetry.listRootsByDb.get('(default)')).toBe(2);
      expect(telemetry.listRootsByDb.get('analytics')).toBe(2);

      // Unmounting all consumers tears down both shared feed subscriptions cleanly.
      view.unmount();
      expect(telemetry.feedUnsubscribeCalls).toBe(2);
    } finally {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prevWorker;
    }
  });
});
