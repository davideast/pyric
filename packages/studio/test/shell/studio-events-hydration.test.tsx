// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Characterization of issue #364: opening Studio against a worker that ALREADY
 * holds session history must render that history on first paint of the
 * activity surfaces — before any further live event arrives.
 *
 * The shim below plays the worker HOST's documented event-stream contract
 * (host-events.ts): on `{t:'sub', target:'events'}` it delivers the seeded
 * `sandbox.history()` as the first batch, ASYNCHRONOUSLY (a real MessagePort
 * round-trip is a macrotask). The hook under test is the real
 * `useStudioEvents` over the real `EnvironmentProvider` + `workerEventFeed`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import type { SandboxEvent } from 'pyric/sandbox';

const HISTORY: SandboxEvent[] = ['h1', 'h2'].map(
  (id) =>
    ({
      kind: 'write',
      id,
      at: 0,
      method: 'create',
      path: `users/${id}`,
      auth: null,
      priorState: null,
      nextState: {},
      requestTime: { seconds: 0, nanoseconds: 0 },
    }) as SandboxEvent,
);

/** A SharedWorker shim whose port honors the host's event-stream contract:
 *  ops get an ok reply, an events sub gets the seeded history batch — both
 *  delivered asynchronously like a real port round-trip. */
function installWorkerShim(history: readonly SandboxEvent[]) {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  const sent: any[] = [];
  const eventSubIds: string[] = [];
  const port = {
    sent,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: any) {
      sent.push(msg);
      setTimeout(() => {
        if (msg.t === 'op') {
          port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, value: {} } });
        } else if (msg.t === 'sub' && msg.target === 'events') {
          eventSubIds.push(msg.subId);
          port.onmessage?.({ data: { t: 'event', subId: msg.subId, events: history } });
        }
      }, 0);
    },
    start() {},
    addEventListener() {},
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = port;
    constructor(_url: unknown, _opts: unknown) {}
  };
  return {
    port,
    /** Deliver one LIVE event to every open events sub (a later batch). */
    deliverLive(event: SandboxEvent) {
      for (const subId of eventSubIds) {
        port.onmessage?.({ data: { t: 'event', subId, events: [event] } });
      }
    },
    restore: () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
    },
  };
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

afterEach(() => cleanup());

describe('useStudioEvents first-open hydration (issue #364)', () => {
  it('shows the worker history backlog before any new live event arrives', async () => {
    const shim = installWorkerShim(HISTORY);
    try {
      const { EnvironmentProvider } = await import('../../src/shell/environment.js');
      const { useStudioEvents } = await import('../../src/shell/studio-data.js');

      function Probe() {
        const events = useStudioEvents();
        return <div data-testid="ids">{events.map((e) => e.id).join(',')}</div>;
      }

      let result: ReturnType<typeof render>;
      await act(async () => {
        result = render(
          <StrictMode>
          <EnvironmentProvider mode="local">
            <Probe />
          </EnvironmentProvider>
          </StrictMode>,
        );
      });
      await flush();

      // The backlog must be visible NOW — no further live event has arrived.
      expect(result!.getByTestId('ids').textContent).toBe('h1,h2');
    } finally {
      shim.restore();
    }
  });
});
