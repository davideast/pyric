// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.IS_REACT_ACT_ENVIRONMENT = true;

import '../reset-shell-singletons-preload.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useLiveHost } from '../../src/shell/live-status.js';
import { useServeInit } from '../../src/shell/serve-init.js';

const originalFetch = globalThis.fetch;

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}

function installMockLiveEndpoints(projectId: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestPath(input);
    if (url.endsWith('/__pyric/health')) {
      return new Response(
        JSON.stringify({
          ok: true,
          live: {
            projectId,
            configProjectId: projectId,
            configSource: '.firebaserc',
            appProjectIds: [projectId],
            billed: { reads: 1, writes: 0, deliveries: 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/__pyric/init.json')) {
      return new Response(
        JSON.stringify({ persist: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('null', { status: 404 });
  }) as typeof fetch;
}

function ShellProbe({ onRead }: { onRead: (snapshot: { projectId: string | null; initStatus: string }) => void }) {
  const live = useLiveHost();
  const init = useServeInit();
  onRead({ projectId: live?.projectId ?? null, initStatus: init.status });
  return null;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('Studio shell singleton reset preload', () => {
  it('starts clean on initial mount and populates live-status and serve-init (case A)', async () => {
    const observed: Array<{ projectId: string | null; initStatus: string }> = [];
    installMockLiveEndpoints('demo-project-a');
    render(<ShellProbe onRead={(snap) => observed.push(snap)} />);
    expect(observed[0]).toEqual({ projectId: null, initStatus: 'loading' });

    await waitFor(() => {
      const last = observed[observed.length - 1];
      expect(last).toEqual({ projectId: 'demo-project-a', initStatus: 'ready' });
    });
  });

  it('starts clean after a sibling test left live-status and serve-init populated (case B)', async () => {
    const observed: Array<{ projectId: string | null; initStatus: string }> = [];
    installMockLiveEndpoints('demo-project-b');
    render(<ShellProbe onRead={(snap) => observed.push(snap)} />);
    expect(observed[0]).toEqual({ projectId: null, initStatus: 'loading' });

    await waitFor(() => {
      const last = observed[observed.length - 1];
      expect(last).toEqual({ projectId: 'demo-project-b', initStatus: 'ready' });
    });
  });
});
