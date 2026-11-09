// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:3000/traffic',
});
const g = globalThis as any;
g.window = dom.window;
g.Window = dom.window.Window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MutationObserver = dom.window.MutationObserver;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import type { SandboxEvent } from 'pyric/sandbox';
import { TrafficSurface } from '../../../src/features/traffic/TrafficSurface.js';
import { resetTrafficSubrouteQuery } from '../../../src/features/traffic/traffic-tabs.js';
import { EnvironmentProvider } from '../../../src/shell/environment.js';
import { resetLiveStatusPollerForTesting } from '../../../src/shell/live-status.js';
import { currentPath, replacePath, useRoute } from '../../../src/shell/router.js';

const LIVE_HEALTH = {
  live: {
    projectId: 'demo-live',
    configProjectId: 'demo-live',
    configSource: 'firebase.json',
    appProjectIds: ['demo-live'],
    billed: { reads: 4, writes: 1, deliveries: 2 },
    clients: [
      { kind: 'browser', clientId: 'client-web', label: '/items', user: 'u-1', lastSeen: 1 },
      { kind: 'node', clientId: 'client-cron', label: 'cron.mjs', user: null, lastSeen: 1 },
    ],
  },
};

function resolveFetchUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installWorkerShim(history: readonly SandboxEvent[]) {
  const previousWorker = g.SharedWorker;
  const eventSubIds: string[] = [];
  const port = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: any) {
      setTimeout(() => {
        if (msg.t === 'op') {
          port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, value: {} } });
          return;
        }
        const subscribesToEvents = msg.t === 'sub' && msg.target === 'events';
        if (subscribesToEvents) {
          eventSubIds.push(msg.subId);
          port.onmessage?.({ data: { t: 'event', subId: msg.subId, events: history } });
        }
      }, 0);
    },
    start() {},
    addEventListener() {},
  };
  g.SharedWorker = class {
    port = port;
    constructor(_url: unknown, _opts: unknown) {}
  };
  return {
    deliverLive(event: SandboxEvent) {
      for (const subId of eventSubIds) {
        port.onmessage?.({ data: { t: 'event', subId, events: [event] } });
      }
    },
    restore() {
      g.SharedWorker = previousWorker;
    },
  };
}

function installLiveFetch() {
  const previousFetch = g.fetch;
  g.fetch = async (input: string | URL | Request): Promise<Response> => {
    const rawUrl = resolveFetchUrl(input);
    if (rawUrl.includes('/__pyric/health')) {
      return new Response(JSON.stringify(LIVE_HEALTH), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('null', { status: 404 });
  };
  return () => {
    g.fetch = previousFetch;
  };
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));

afterEach(() => {
  cleanup();
  resetLiveStatusPollerForTesting();
  replacePath({ tab: 'traffic', query: {} });
});

describe('<TrafficSurface> live retention and brushed subtab scoping', () => {
  it('never evicts client Rules counts under >500 background Admin calls and scopes Rules cap notice to clientCapped', async () => {
    const now = Date.now();
    const clientEvents: SandboxEvent[] = [
      {
        kind: 'operation',
        id: 'c-allow-1',
        at: now - 50_000,
        service: 'firestore',
        method: 'getDoc',
        path: 'items/item-1',
        auth: { uid: 'u-1' },
        origin: 'user',
        result: 'allow',
        caller: { kind: 'page', pageId: 'tab-1', clientId: 'client-web' },
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' }, local: { result: 'allow' } },
      } as unknown as SandboxEvent,
      {
        kind: 'operation',
        id: 'c-deny-drift',
        at: now - 49_000,
        service: 'rtdb',
        method: 'update',
        path: '/items/item-1',
        auth: { uid: 'u-1' },
        origin: 'user',
        result: 'allow',
        caller: { kind: 'page', pageId: 'tab-1', clientId: 'client-web' },
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' }, local: { result: 'deny', drift: true } },
      } as unknown as SandboxEvent,
      {
        kind: 'operation',
        id: 'c-uneval',
        at: now - 48_000,
        service: 'rtdb',
        method: 'set',
        path: '/items/item-1/meta',
        auth: { uid: 'u-1' },
        origin: 'user',
        result: 'allow',
        caller: { kind: 'page', pageId: 'tab-1', clientId: 'client-web' },
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: {
          outcome: { status: 'ok' },
          local: { result: 'unevaluated', needs: ['write-data'] },
        },
      } as unknown as SandboxEvent,
    ];

    const adminBacklog: SandboxEvent[] = Array.from({ length: 505 }, (_, index) => ({
      kind: 'operation',
      id: `admin-${index}`,
      at: now - 40_000 + index * 10,
      service: 'firestore',
      method: 'DocumentReference.get',
      path: 'items/item-1',
      auth: null,
      origin: 'admin',
      result: 'allow',
      caller: { kind: 'node', clientId: 'client-cron' },
      rulesDisposition: { kind: 'bypassed', reason: 'admin' },
      production: { outcome: { status: 'ok' } },
    })) as unknown as SandboxEvent[];

    const restoreFetch = installLiveFetch();
    const worker = installWorkerShim([...clientEvents, ...adminBacklog]);
    try {
      const view = render(
        <EnvironmentProvider mode="local">
          <TrafficSurface />
        </EnvironmentProvider>,
      );
      await flush();

      await waitFor(() => {
        expect(view.container.querySelector('.traffic__tl-count')?.textContent).toContain(
          '(capped at 500/lane)',
        );
      });

      // Scope `From` to the browser client (only 3 rows) — rolling cap stays disclosed on Timeline and Billable!
      const fromSelect = view.container.querySelector(
        '[data-pyric-traffic-from]',
      ) as HTMLSelectElement;
      fireEvent.change(fromSelect, { target: { value: 'client:page:client-web' } });
      expect(view.container.querySelector('.traffic__tl-count')?.textContent).toBe(
        '3 requests (capped at 500/lane)',
      );

      fireEvent.change(fromSelect, { target: { value: 'all' } });
      fireEvent.click(view.getByRole('tab', { name: 'Billable metrics' }));
      await waitFor(() => {
        expect(view.container.querySelector('[data-pyric-traffic-capped]')?.textContent).toContain(
          'Showing latest 500 retained requests per traffic lane',
        );
      });

      // Stream additional live Admin SDK ticks while client is idle — client Rules counts never tick down,
      // and Rules omits the cap notice while clientCapped is false!
      fireEvent.click(view.getByRole('tab', { name: 'Rules' }));
      await waitFor(() => {
        expect(view.getByText('2 advisory local Rules evaluations')).toBeTruthy();
      });
      expect(view.container.querySelector('[data-pyric-traffic-capped]')).toBeNull();

      await act(async () => {
        for (let tick = 0; tick < 5; tick += 1) {
          worker.deliverLive({
            kind: 'operation',
            id: `admin-live-${tick}`,
            at: now - 1_000 + tick * 10,
            service: 'firestore',
            method: 'DocumentReference.get',
            path: 'items/item-1',
            auth: null,
            origin: 'admin',
            result: 'allow',
            caller: { kind: 'node', clientId: 'client-cron' },
            rulesDisposition: { kind: 'bypassed', reason: 'admin' },
            production: { outcome: { status: 'ok' } },
          } as unknown as SandboxEvent);
        }
      });
      await flush();

      expect(view.getByText('2 advisory local Rules evaluations')).toBeTruthy();
      const summary =
        view.container.querySelector('[data-pyric-live-rules-summary]')?.textContent ?? '';
      expect(summary).toContain('Evaluated locally: 2');
      expect(summary).toContain('Unevaluated locally: 1');
      expect(summary).toContain('Admin-bypassed: 500');
      expect(summary).toContain('Drift with production: 1');

      // Once client traffic itself exceeds 500, clientCapped turns true and Rules discloses its cap notice.
      await act(async () => {
        for (let index = 0; index < 500; index += 1) {
          worker.deliverLive({
            kind: 'operation',
            id: `c-overflow-${index}`,
            at: now - 500 + index,
            service: 'firestore',
            method: 'getDoc',
            path: `items/item-${index}`,
            auth: { uid: 'u-1' },
            origin: 'user',
            result: 'allow',
            caller: { kind: 'page', pageId: 'tab-1', clientId: 'client-web' },
            rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
            production: { outcome: { status: 'ok' }, local: { result: 'allow' } },
          } as unknown as SandboxEvent);
        }
      });
      await flush();

      expect(view.container.querySelector('[data-pyric-traffic-capped]')?.textContent).toContain(
        'Showing latest 500 retained client requests',
      );

      // Brushing an early Timeline bucket before the retention horizon keeps the cap notice on Rules,
      // while brushing the newest bucket after the retention horizon hides it.
      fireEvent.click(view.getByRole('tab', { name: 'Timeline' }));
      const buckets = view.container.querySelectorAll('[data-pyric-bucket]');
      fireEvent.click(buckets[0]!);
      fireEvent.click(view.getByRole('tab', { name: 'Rules' }));
      expect(view.container.querySelector('[data-pyric-traffic-capped]')).not.toBeNull();

      fireEvent.click(view.getByRole('tab', { name: 'Timeline' }));
      const updatedBuckets = view.container.querySelectorAll('[data-pyric-bucket]');
      fireEvent.click(updatedBuckets[updatedBuckets.length - 1]!);
      fireEvent.click(view.getByRole('tab', { name: 'Rules' }));
      expect(view.container.querySelector('[data-pyric-traffic-capped]')).toBeNull();
    } finally {
      worker.restore();
      restoreFetch();
    }
  });

  it('scopes Billable metrics and Rules to a brushed Timeline interval and clears back to the full session', async () => {
    const now = Date.now();
    const history: SandboxEvent[] = [
      {
        kind: 'operation',
        id: 'early-fs-read',
        at: now - 600_000,
        service: 'firestore',
        method: 'getDoc',
        path: 'items/item-1',
        auth: { uid: 'u-1' },
        origin: 'user',
        result: 'allow',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: {
          outcome: { status: 'ok' },
          usage: { documentReads: 3 },
          local: { result: 'allow' },
        },
      } as unknown as SandboxEvent,
      {
        kind: 'operation',
        id: 'early-rtdb-listen',
        at: now - 595_000,
        service: 'rtdb',
        method: 'onValue',
        path: '/items/list',
        auth: { uid: 'u-1' },
        origin: 'user',
        result: 'allow',
        detail: { listenerId: 'page:tab-1:l-items' },
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' }, local: { result: 'allow' } },
      } as unknown as SandboxEvent,
      {
        kind: 'operation',
        id: 'burst-fs-write',
        at: now - 1_000,
        service: 'firestore',
        method: 'setDoc',
        path: 'items/item-2',
        auth: { uid: 'u-1' },
        origin: 'user',
        result: 'allow',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' }, local: { result: 'allow' } },
      } as unknown as SandboxEvent,
      {
        kind: 'operation',
        id: 'burst-rtdb-push',
        at: now - 900,
        service: 'rtdb',
        method: 'onValue',
        path: '/items/list',
        auth: { uid: 'u-1' },
        origin: 'user',
        result: 'allow',
        detail: { listenerId: 'page:tab-1:l-items' },
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' }, local: { result: 'allow' } },
      } as unknown as SandboxEvent,
      {
        kind: 'operation',
        id: 'burst-fs-deny',
        at: now - 800,
        service: 'firestore',
        method: 'getDoc',
        path: 'items/item-secret',
        auth: { uid: 'u-1' },
        origin: 'user',
        result: 'deny',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: {
          outcome: { status: 'error', code: 'permission-denied' },
          local: { result: 'deny' },
        },
      } as unknown as SandboxEvent,
    ];

    const restoreFetch = installLiveFetch();
    const worker = installWorkerShim(history);
    try {
      const view = render(
        <EnvironmentProvider mode="local">
          <TrafficSurface />
        </EnvironmentProvider>,
      );
      await flush();

      await waitFor(() => {
        expect(
          view.container.querySelectorAll('[data-pyric-bucket]:not([data-pyric-bucket-count="0"])')
            .length,
        ).toBe(2);
      });

      // Brush the recent burst bucket on Timeline.
      const activeBuckets = view.container.querySelectorAll(
        '[data-pyric-bucket]:not([data-pyric-bucket-count="0"])',
      );
      fireEvent.click(activeBuckets[activeBuckets.length - 1]!);
      expect(view.getByText('Selected interval')).toBeTruthy();

      // Switch to Billable metrics: early 3 document reads are excluded; burst write (1) + RTDB delivery (1) are shown.
      fireEvent.click(view.getByRole('tab', { name: 'Billable metrics' }));
      await waitFor(() => {
        expect(view.getByText('Selected interval')).toBeTruthy();
      });
      const opPanel = view.container.querySelector('[data-pyric-billable-panel="operation"]')!;
      expect(
        opPanel.querySelector('[data-pyric-metric-key="reads"] [data-pyric-metric-value]')
          ?.textContent,
      ).toBe('0');
      expect(
        opPanel.querySelector('[data-pyric-metric-key="writes"] [data-pyric-metric-value]')
          ?.textContent,
      ).toBe('1');

      // Switch to Rules: pre-window RTDB listener `l-items` delivery inside brushed window STILL counts (2 allows + 1 deny = 3).
      fireEvent.click(view.getByRole('tab', { name: 'Rules' }));
      await waitFor(() => {
        expect(view.getByText('3 advisory local Rules evaluations')).toBeTruthy();
      });
      expect(view.getByText('Selected interval')).toBeTruthy();
      expect(
        view.container.querySelector('[data-pyric-metric-key="allows"] [data-pyric-metric-value]')
          ?.textContent,
      ).toBe('2');
      expect(
        view.container.querySelector('[data-pyric-metric-key="denies"] [data-pyric-metric-value]')
          ?.textContent,
      ).toBe('1');

      // Clear interval directly from Rules -> full session counts restore (early read + deduplicated l-items + burst write = 3 allows, 1 deny).
      fireEvent.click(view.getByRole('button', { name: 'Show all traffic' }));
      await waitFor(() => {
        expect(view.getByText('4 advisory local Rules evaluations')).toBeTruthy();
      });
      expect(view.queryByText('Selected interval')).toBeNull();
    } finally {
      worker.restore();
      restoreFetch();
    }
  });
});

describe('useRoute top-level Traffic navigation (#2540)', () => {
  const VALID = ['home', 'traffic', 'firestore'] as const;

  it('clears stale ?inspect and subview query keys when clicking top-level Traffic while preserving ?hide=studio and ?from=', () => {
    replacePath({
      tab: 'traffic',
      query: { inspect: 'ev-1', view: 'billable', hide: 'studio', from: 'user:u-1' },
    });
    const { result } = renderHook(() => useRoute(VALID, 'home', resetTrafficSubrouteQuery));
    expect(result.current[0]).toBe('traffic');

    act(() => {
      result.current[1]('traffic');
    });

    expect(currentPath().tab).toBe('traffic');
    expect(currentPath().rest).toEqual([]);
    expect(currentPath().query.inspect).toBeUndefined();
    expect(currentPath().query.view).toBeUndefined();
    expect(currentPath().query.hide).toBe('studio');
    expect(currentPath().query.from).toBe('user:u-1');
  });

  it('returns to clean /traffic when clicking top-level Traffic from ?inspect=ev-1 or /traffic/listeners/<id>', () => {
    replacePath({ tab: 'traffic', query: { inspect: 'ev-1' } });
    const { result } = renderHook(() => useRoute(VALID, 'home', resetTrafficSubrouteQuery));

    act(() => {
      result.current[1]('traffic');
    });
    expect(window.location.pathname + window.location.search).toBe('/traffic');

    act(() => {
      replacePath({ tab: 'traffic', rest: ['listeners', 'l-1'], query: { hide: 'studio' } });
    });
    act(() => {
      result.current[1]('traffic');
    });
    expect(window.location.pathname + window.location.search).toBe('/traffic?hide=studio');
  });

  it('leaves the URL unchanged on active-tab re-click when no reselectActiveQuery callback is supplied', () => {
    replacePath({ tab: 'firestore', query: { inspect: 'doc-1' } });
    const { result } = renderHook(() => useRoute(VALID, 'home'));

    act(() => {
      result.current[1]('firestore');
    });
    expect(window.location.pathname + window.location.search).toBe('/firestore?inspect=doc-1');
  });
});
