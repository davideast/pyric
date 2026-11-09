import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/auth',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLButtonElement = dom.window.HTMLButtonElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.EventTarget = dom.window.EventTarget;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).attachEvent = () => {};
(dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).detachEvent = () => {};
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { AuthSurface } from '../../../src/features/auth/AuthSurface.js';
import { EnvironmentProvider } from '../../../src/shell/environment.js';
import { resetLiveStatusPollerForTesting } from '../../../src/shell/live-status.js';
import { resetServeInitForTests } from '../../../src/shell/serve-init.js';

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
    sent,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: Record<string, unknown>) {
      sent.push(msg);
      setTimeout(() => {
        if (msg.t === 'op') {
          let value: unknown = {};
          if (msg.method === 'listRootCollections') value = { ids: ['users'] };
          if (msg.method === 'auth.listUsers') value = [];
          if (msg.method === 'auth.getProviderConfig') value = { providers: {} };
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
    authOpMethods(): string[] {
      return sent
        .filter((m) => m.t === 'op' && typeof m.method === 'string' && String(m.method).startsWith('auth.'))
        .map((m) => String(m.method));
    },
    restore() {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
    },
  };
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 25)));

beforeEach(() => {
  resetLiveStatusPollerForTesting();
  resetServeInitForTests();
  window.history.replaceState(null, '', '/auth');
});

afterEach(() => {
  cleanup();
  resetLiveStatusPollerForTesting();
  resetServeInitForTests();
  globalThis.fetch = originalFetch;
});

describe('AuthSurface', () => {
  it('waits for /__pyric/health before mounting sandbox Auth subscriptions, and renders read-only unavailable copy on a live host', async () => {
    let resolveHealth!: (res: Response) => void;
    const healthDeferred = new Promise<Response>((res) => {
      resolveHealth = res;
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.endsWith('/__pyric/health')) return healthDeferred;
      if (url.endsWith('/__pyric/live/session-data')) {
        return new Response(
          JSON.stringify({
            revision: 1,
            updatedAt: 1000,
            projectId: 'demo-live',
            firestore: {},
            rtdb: {},
            defaultRtdbInstance: null,
            stats: { firestoreDocs: 0, rtdbInstances: 0, byteEstimate: 0, truncated: false, droppedCount: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/__pyric/init.json')) {
        return new Response(JSON.stringify({ seed: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const shim = installWorkerShim();
    try {
      const view = render(
        <EnvironmentProvider mode="local">
          <AuthSurface />
        </EnvironmentProvider>,
      );

      await flush();
      expect(shim.authOpMethods()).toEqual([]);
      expect(view.container.querySelector('[data-pyric-ui="auth-surface-empty"]')?.textContent).toContain(
        'Local backend pending',
      );
      expect(view.container.querySelector('.auth-sub__add')).toBeNull();

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

      await waitFor(() =>
        expect(view.container.querySelector('[data-pyric-ui="live-service-unavailable"]')).not.toBeNull(),
      );
      expect(view.container.textContent).toContain('Auth user listing is unavailable in Live mode');
      expect(view.container.querySelector('[data-live-observed-badge]')).not.toBeNull();
      expect(view.container.querySelector('.auth-sub__add')).toBeNull();
      expect(view.container.querySelector('[data-pyric-ui="auth-user-list"]')).toBeNull();
      expect(shim.authOpMethods()).toEqual([]);
    } finally {
      shim.restore();
    }
  });

  it('mounts the sandbox Auth user list and Add user button once /__pyric/health answers as a sandbox host', async () => {
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

    const shim = installWorkerShim();
    try {
      const view = render(
        <EnvironmentProvider mode="local">
          <AuthSurface />
        </EnvironmentProvider>,
      );

      await waitFor(() =>
        expect(view.container.querySelector('[data-pyric-ui="auth-user-list"]')).not.toBeNull(),
      );
      expect(view.container.querySelector('.auth-sub__add')?.textContent).toBe('Add user');
      expect(shim.authOpMethods()).toContain('auth.listUsers');
    } finally {
      shim.restore();
    }
  });

  it('preserves direct auth prop overrides for isolated component callers', async () => {
    const sb = initializeSandbox();
    const auth = getAuth(sb);
    authSandbox.createUser(auth, { uid: 'user-1', email: 'reader@example.com' });

    const view = render(
      <EnvironmentProvider mode="local">
        <AuthSurface auth={auth} />
      </EnvironmentProvider>,
    );

    await waitFor(() => expect(view.container.textContent).toContain('reader@example.com'));
    expect(view.container.querySelector('.auth-sub__add')?.textContent).toBe('Add user');
  });
});
