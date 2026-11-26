import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/traffic?view=subscriptions',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.EventTarget = dom.window.EventTarget;
g.Event = dom.window.Event;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { collection, doc, getFirestore, onSnapshot, setDoc } from 'pyric/firestore';
import { getDatabase, onValue, ref, sandbox as rtdbSandbox } from 'pyric/database';
import {
  getFirestore as workerGetFirestore,
  type ClientDb,
} from '@pyric/cli/serve/worker';
import {
  bucketSubscriptionMetrics,
  retainSubscriptionGauge,
  type SubscriptionConnectionEvent,
  type SubscriptionLifecycleInput,
} from '@pyric/ui/traffic';
import { workerEventFeed } from '../../../src/clients/worker-live.js';
import { EnvironmentProvider } from '../../../src/shell/environment.js';
import { resetLiveStatusPollerForTesting } from '../../../src/shell/live-status.js';
import { resetServeInitForTests } from '../../../src/shell/serve-init.js';
import { studioTrafficEvents } from '../../../src/shell/studio-events.js';
import { retainStudioSubscriptions } from '../../../src/shell/subscription-retention.js';
import { pushPath } from '../../../src/shell/router.js';
import { SubscriptionsMetricsView } from '../../../src/features/traffic/SubscriptionsMetricsView.js';
import { TrafficSurface } from '../../../src/features/traffic/TrafficSurface.js';

const originalFetch = globalThis.fetch;

function installSandboxBackedWorker(options: {
  readonly backlog: () => readonly unknown[];
  readonly presenceClients?: number;
}) {
  const prevWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  const eventSubscribers = new Set<{ port: typeof port; subId: string }>();
  const presenceCount = options.presenceClients ?? 0;
  const presenceClients = Array.from({ length: presenceCount }, (_, idx) => ({
    clientId: `presence-page-${idx + 1}`,
    kind: 'app',
    visibility: 'visible',
    connectedAt: 100,
    lastSeenAt: 100,
  }));

  const port = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: Record<string, unknown>) {
      setTimeout(() => {
        if (msg.t === 'op') {
          let value: unknown = {};
          if (msg.method === 'listRootCollections') value = { ids: [] };
          port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, value } });
          return;
        }
        if (msg.t === 'sub' && msg.target === 'events' && typeof msg.subId === 'string') {
          const entry = { port, subId: msg.subId };
          eventSubscribers.add(entry);
          port.onmessage?.({
            data: { t: 'event', subId: msg.subId, events: [...options.backlog()] },
          });
          return;
        }
        if (msg.t === 'sub' && msg.target === 'presence' && typeof msg.subId === 'string') {
          port.onmessage?.({
            data: {
              t: 'presence',
              subId: msg.subId,
              snapshot: { clients: presenceClients },
            },
          });
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
    broadcast(event: unknown) {
      for (const sub of eventSubscribers) {
        sub.port.onmessage?.({
          data: { t: 'event', subId: sub.subId, events: [event] },
        });
      }
    },
    restore() {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prevWorker;
    },
  };
}

function connection(
  id: string,
  connectionId: string,
  phase: 'attach' | 'detach',
  at: number,
  extra: Partial<SubscriptionConnectionEvent> = {},
): SubscriptionConnectionEvent {
  return {
    kind: 'connection',
    id,
    at,
    service: 'firestore',
    phase,
    connectionId,
    clientKind: 'web',
    ...extra,
  };
}

function listenerAttach(
  id: string,
  listenerId: string,
  at: number,
  connectionId?: string,
  extra: Record<string, unknown> = {},
): SandboxEvent {
  const out: Record<string, unknown> = {
    kind: 'listener_attach',
    id,
    at,
    listenerId,
    target: { kind: 'query', collection: 'orders' },
    auth: { uid: 'u-alice', token: {} },
    ...extra,
  };
  if (connectionId !== undefined) out.connectionId = connectionId;
  return out as unknown as SandboxEvent;
}

beforeEach(() => {
  resetLiveStatusPollerForTesting();
  resetServeInitForTests();
  globalThis.fetch = async () => new Response('not found', { status: 404 });
});

afterEach(() => {
  cleanup();
  resetLiveStatusPollerForTesting();
  resetServeInitForTests();
  globalThis.fetch = originalFetch;
});

describe('Studio subscription lifecycle transport and view (#284)', () => {
  it('receives real sandbox listener lifecycle through workerEventFeed without fabricating TrafficEvent rows, and stays exact for late subscribers after >500 unrelated ops', async () => {
    const sandbox = initializeSandbox();
    setRules(
      sandbox,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`,
    );
    const db = getFirestore(sandbox);
    const rtdb = getDatabase(sandbox);
    rtdbSandbox.setRules(rtdb, rtdbSandbox.DEFAULT_OPEN_RULES);

    const unsubKeep = onSnapshot(collection(db, 'orders'), () => {});
    const unsubTransient = onSnapshot(doc(db, 'orders/o-transient'), () => {});
    const unsubRtdb = onValue(ref(rtdb, 'status/online'), () => {});
    unsubTransient();

    // Generate 310 writes (> 620 request + write events, exceeding STUDIO_EVENT_CAP = 500)
    // BEFORE Studio subscribes to the worker event stream.
    for (let i = 0; i < 310; i += 1) {
      await setDoc(doc(db, `noise/doc-${i}`), { step: i });
    }

    const worker = installSandboxBackedWorker({ backlog: () => sandbox.history() });
    try {
      const unsubForward = sandbox.onEvent((event) => worker.broadcast(event));
      const clientDb: ClientDb = workerGetFirestore('worker://studio-late-sub');
      const feed = workerEventFeed(clientDb);
      const received: SandboxEvent[] = [];
      const unsubFeed = feed.subscribe((ev) => received.push(ev));

      await waitFor(() => {
        expect(received.length).toBeGreaterThan(600);
      });

      // Lifecycle events never fabricate fake TrafficEvent rows.
      const trafficRows = studioTrafficEvents(feed.history());
      expect(
        trafficRows.some(
          (row) =>
            (row as unknown as { kind: string }).kind === 'listener_attach' ||
            (row as unknown as { kind: string }).kind === 'listener_detach',
        ),
      ).toBe(false);

      // Emit another 300 writes (> 600 more events) live while subscribed.
      for (let i = 310; i < 610; i += 1) {
        await setDoc(doc(db, `noise/doc-${i}`), { step: i });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      const retained = retainStudioSubscriptions(received);
      const historyWindow = {
        start: ( retained.earliestTransitionAt ?? 0 ) - 100,
        end: Date.now() + 1_000,
      };
      const fsMetrics = bucketSubscriptionMetrics(retained, historyWindow, {
        service: 'firestore',
      });
      // Two Firestore listeners attached concurrently before one detached; one remains active.
      expect(fsMetrics.currentListeners).toBe(1);
      expect(fsMetrics.peakListeners).toBe(2);
      expect(fsMetrics.connectionsObserved).toBe(false);

      // RTDB listener is tracked under 'rtdb' and excluded from Firestore counts.
      const rtdbMetrics = bucketSubscriptionMetrics(retained, historyWindow, {
        service: 'rtdb',
      });
      expect(rtdbMetrics.currentListeners).toBe(1);

      unsubKeep();
      unsubRtdb();
      unsubFeed();
      unsubForward();
    } finally {
      worker.restore();
      sandbox.dispose();
    }
  });

  it('never uses SharedWorker page presence as active connections and gates the Subscriptions tab until connection lifecycle is observed', async () => {
    const stream: SubscriptionLifecycleInput[] = [listenerAttach('l-1', 'listener-1', 1_000)];
    const worker = installSandboxBackedWorker({
      backlog: () => stream,
      presenceClients: 5,
    });

    try {
      pushPath({ tab: 'traffic', query: { view: 'subscriptions' } });
      const { container, queryByRole } = render(
        <EnvironmentProvider>
          <TrafficSurface />
        </EnvironmentProvider>,
      );

      await waitFor(() => {
        expect(queryByRole('tab', { name: 'Billable metrics' })).toBeTruthy();
      });

      // Even with 5 connected pages in SharedWorker presence, Subscriptions tab stays gated
      // because connection lifecycle is unobservable on the stream.
      expect(queryByRole('tab', { name: 'Subscriptions' })).toBeNull();
      expect(container.querySelector('[data-pyric-ui="traffic-rules-view"]')).toBeTruthy();

      // Now broadcast explicit connection + listener lifecycle over the worker event path.
      await act(async () => {
        worker.broadcast(connection('c-1', 'web-page-1', 'attach', 900));
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => {
        pushPath({ tab: 'traffic', query: { view: 'subscriptions' } });
      });

      await waitFor(() => {
        expect(queryByRole('tab', { name: 'Subscriptions' })).toBeTruthy();
        expect(container.querySelector('[data-pyric-subscriptions-current]')?.textContent).toContain(
          'Active now: 1 snapshot listeners | 1 active connections',
        );
      });
      // Active connections is 1 (from explicit connection lifecycle), NEVER 5 (presence).
      expect(
        container.querySelector('[data-pyric-metric-key="activeConnections"] [data-pyric-metric-value]')
          ?.textContent,
      ).toBe('1');
    } finally {
      worker.restore();
    }
  });

  it('renders gated, empty, and live Firestore peak states clearly with series toggles and scope filters', () => {
    // 1. Direct mount when connectionsObserved === false withholds chart honestly.
    const uninstrumented = retainSubscriptionGauge([listenerAttach('a1', 'l-1', 1_000)]);
    const gatedRender = render(
      <SubscriptionsMetricsView snapshot={uninstrumented} window={{ start: 0, end: 5_000 }} />,
    );
    expect(gatedRender.container.querySelector('[data-pyric-subscriptions-gated]')).toBeTruthy();
    expect(gatedRender.container.querySelector('[data-pyric-ui="traffic-line-chart"]')).toBeNull();
    expect(gatedRender.container.textContent).toContain(
      'Active connection lifecycle is not yet observed',
    );
    cleanup();

    // 2. Empty observed state (connection observed and detached outside window -> 0 peak).
    const emptyObserved = retainSubscriptionGauge([
      connection('c-old-a', 'web-old', 'attach', 100),
      connection('c-old-d', 'web-old', 'detach', 200),
    ]);
    const emptyRender = render(
      <SubscriptionsMetricsView snapshot={emptyObserved} window={{ start: 1_000, end: 5_000 }} />,
    );
    expect(
      emptyRender.getByText('No Firestore snapshot listeners or active connections in this window.'),
    ).toBeTruthy();
    expect(emptyRender.container.textContent).toContain('Firestore subscriptions');
    cleanup();

    // 3. Live observed state: 10 Firestore listeners on 1 web connection + 1 Studio-owned listener.
    const liveEvents: SubscriptionLifecycleInput[] = [
      connection('c-app', 'web-app', 'attach', 1_000, {
        caller: { kind: 'page', pageId: 'tab-1' },
      }),
      connection('c-studio', 'web-studio', 'attach', 1_050, {
        caller: { kind: 'studio' },
      }),
      listenerAttach('l-studio', 'studio-l1', 1_060, 'web-studio', {
        caller: { kind: 'studio' },
      }),
    ];
    for (let i = 1; i <= 10; i += 1) {
      liveEvents.push(
        listenerAttach(`l-${i}`, `app-l-${i}`, 1_100 + i * 10, 'web-app', {
          caller: { kind: 'page', pageId: 'tab-1' },
        }),
      );
    }
    const liveSnapshot = retainSubscriptionGauge(liveEvents);
    const liveRender = render(
      <SubscriptionsMetricsView
        snapshot={liveSnapshot}
        window={{ start: 1_000, end: 5_000 }}
        hideStudio
      />,
    );

    expect(
      liveRender.getByText('Peak of 10 Firestore snapshot listeners across 1 active connection'),
    ).toBeTruthy();
    expect(
      liveRender.container.querySelector('[data-pyric-subscriptions-current]')?.textContent,
    ).toBe('Active now: 10 snapshot listeners | 1 active connections');
    expect(
      liveRender.container.querySelector(
        '[data-pyric-metric-key="snapshotListeners"] [data-pyric-metric-value]',
      )?.textContent,
    ).toBe('10');
    expect(
      liveRender.container.querySelector(
        '[data-pyric-metric-key="activeConnections"] [data-pyric-metric-value]',
      )?.textContent,
    ).toBe('1');
    expect(liveRender.getByText('Peak concurrent active per bucket')).toBeTruthy();
    expect(liveRender.container.textContent).toContain(
      'Per-bucket peak active gauges (local buckets, not Cloud Monitoring 60s samples)',
    );

    // Toggle snapshotListeners checkbox hides its SVG line while keeping activeConnections visible.
    expect(
      liveRender.container.querySelector(
        '[data-pyric-chart-line][data-pyric-series-key="snapshotListeners"]',
      ),
    ).toBeTruthy();
    const toggleBox = liveRender.container.querySelector(
      '[data-pyric-metric-key="snapshotListeners"] input[type="checkbox"]',
    );
    expect(toggleBox).toBeTruthy();
    if (toggleBox) fireEvent.click(toggleBox);
    expect(
      liveRender.container.querySelector(
        '[data-pyric-chart-line][data-pyric-series-key="snapshotListeners"]',
      ),
    ).toBeNull();
    expect(
      liveRender.container.querySelector(
        '[data-pyric-chart-line][data-pyric-series-key="activeConnections"]',
      ),
    ).toBeTruthy();
  });
});
