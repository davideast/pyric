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
import { EnvironmentProvider } from '../../src/shell/environment.js';
import { resetLiveStatusPollerForTesting } from '../../src/shell/live-status.js';
import { usePresenceView } from '../../src/shell/presence.js';
import { resetServeInitForTests } from '../../src/shell/serve-init.js';

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
          port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, value: {} } });
        } else if (msg.t === 'sub' && msg.target === 'events') {
          port.onmessage?.({ data: { t: 'event', subId: msg.subId, events: [] } });
        } else if (msg.t === 'sub' && msg.target === 'presence') {
          port.onmessage?.({
            data: {
              t: 'presence',
              subId: msg.subId,
              clients: [{ clientId: 'c-1', kind: 'studio', route: '/', visibility: 'visible', lastSeen: 10 }],
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
    presenceSubCount: () => sent.filter((m) => m.t === 'sub' && m.target === 'presence').length,
    restore() {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
    },
  };
}

function PresenceProbe() {
  const view = usePresenceView();
  return <div data-chip={view?.chipLabel ?? ''} />;
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

describe('presence', () => {
  it('does not subscribe to worker presence on a live host and subscribes on a sandbox host', async () => {
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
          <PresenceProbe />
        </EnvironmentProvider>,
      );
      await flush();
      expect(liveShim.presenceSubCount()).toBe(0);
    } finally {
      liveShim.restore();
    }

    cleanup();
    resetLiveStatusPollerForTesting();
    resetServeInitForTests();
    liveMode = false;

    const sandboxShim = installWorkerShim();
    try {
      render(
        <EnvironmentProvider mode="local">
          <PresenceProbe />
        </EnvironmentProvider>,
      );
      await waitFor(() => expect(sandboxShim.presenceSubCount()).toBe(1));
    } finally {
      sandboxShim.restore();
    }
  });
});
