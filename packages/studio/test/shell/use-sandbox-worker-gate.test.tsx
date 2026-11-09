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
import { resetServeInitForTests } from '../../src/shell/serve-init.js';
import {
  isSandboxHostConfirmed,
  useIsSandboxWorkerAllowed,
  useSandboxWorkerLive,
} from '../../src/shell/use-sandbox-worker-gate.js';

const originalFetch = globalThis.fetch;

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}

function installWorkerShim() {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  const port = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: Record<string, unknown>) {
      setTimeout(() => {
        if (msg.t === 'op') {
          port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, value: {} } });
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
  return () => {
    (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
  };
}

function GateProbe() {
  const allowed = useIsSandboxWorkerAllowed();
  const live = useSandboxWorkerLive();
  return <div data-allowed={String(allowed)} data-has-live={String(Boolean(live))} />;
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

describe('use-sandbox-worker-gate', () => {
  it('confirms sandbox mode only after health answers with null liveHost', () => {
    expect(isSandboxHostConfirmed(false, null)).toBe(false);
    expect(
      isSandboxHostConfirmed(true, {
        projectId: 'demo-live',
        configProjectId: 'demo-live',
        configSource: '.firebaserc',
        appProjectIds: ['demo-live'],
        billed: { reads: 0, writes: 0, deliveries: 0 },
      }),
    ).toBe(false);
    expect(isSandboxHostConfirmed(true, null)).toBe(true);
  });

  it('withholds worker access until /__pyric/health resolves and keeps it off on a live host', async () => {
    let resolveHealth!: (res: Response) => void;
    const healthDeferred = new Promise<Response>((res) => {
      resolveHealth = res;
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.endsWith('/__pyric/health')) return healthDeferred;
      if (url.endsWith('/__pyric/init.json')) {
        return new Response(JSON.stringify({ seed: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const restore = installWorkerShim();
    try {
      const view = render(
        <EnvironmentProvider mode="local">
          <GateProbe />
        </EnvironmentProvider>,
      );

      await flush();
      expect(view.container.querySelector('[data-allowed="false"][data-has-live="false"]')).not.toBeNull();

      await act(async () => {
        resolveHealth(
          new Response(
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
          ),
        );
      });

      await flush();
      expect(view.container.querySelector('[data-allowed="false"][data-has-live="false"]')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('exposes the worker plane once /__pyric/health confirms a sandbox host', async () => {
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

    const restore = installWorkerShim();
    try {
      const view = render(
        <EnvironmentProvider mode="local">
          <GateProbe />
        </EnvironmentProvider>,
      );

      await waitFor(() =>
        expect(view.container.querySelector('[data-allowed="true"][data-has-live="true"]')).not.toBeNull(),
      );
    } finally {
      restore();
    }
  });
});
