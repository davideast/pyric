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
import { useSandboxInstanceId, useSavedStates } from '../../src/shell/studio-saved-states.js';

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
          let value: unknown = {};
          if (msg.method === 'getVersion') value = { instanceId: 'sandbox-inst-1' };
          if (msg.method === 'listCheckpoints') value = { checkpoints: [] };
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

function SavedStatesProbe() {
  const instanceId = useSandboxInstanceId();
  useSavedStates();
  return <div data-instance-id={instanceId} />;
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

describe('studio-saved-states', () => {
  it('skips getVersion and listCheckpoints worker RPCs on a live host and enables them on a sandbox host', async () => {
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
          <SavedStatesProbe />
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
          <SavedStatesProbe />
        </EnvironmentProvider>,
      );
      await waitFor(() =>
        expect(view.container.querySelector('[data-instance-id="sandbox-inst-1"]')).not.toBeNull(),
      );
      expect(sandboxShim.methods()).toContain('getVersion');
      expect(sandboxShim.methods()).toContain('listCheckpoints');
    } finally {
      sandboxShim.restore();
    }
  });
});
