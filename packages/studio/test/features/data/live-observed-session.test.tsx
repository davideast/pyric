// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/firestore',
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLButtonElement = dom.window.HTMLButtonElement;
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
(dom.window.HTMLElement.prototype as any).attachEvent = () => {};
(dom.window.HTMLElement.prototype as any).detachEvent = () => {};
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { DataFeature } from '../../../src/features/data/DataFeature.js';
import { RtdbSurface } from '../../../src/features/rtdb/RtdbSurface.js';
import { EnvironmentProvider } from '../../../src/shell/environment.js';
import { resetServeInitForTests } from '../../../src/shell/serve-init.js';

interface MockLiveServerState {
  snapshot: {
    revision: number;
    updatedAt: number | null;
    projectId: string;
    firestore: Record<string, Record<string, unknown>>;
    rtdb: Record<string, unknown>;
    defaultRtdbInstance: string | null;
    storage?: Record<
      string,
      {
        prefixes: string[];
        objects: Record<string, Record<string, unknown>>;
      }
    >;
    defaultStorageBucket?: string | null;
    stats: {
      firestoreDocs: number;
      rtdbInstances: number;
      storageBuckets?: number;
      storageObjects?: number;
      byteEstimate: number;
      truncated: boolean;
      droppedCount: number;
    };
    skips?: {
      oversized: number;
      unsupported: number;
      truncated: number;
      failed: number;
      admin: number;
    };
  };
  initPayload: Record<string, unknown>;
  seedRequests: Array<Record<string, unknown>>;
}

let serverState: MockLiveServerState;

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetServeInitForTests();
  serverState = {
    snapshot: {
      revision: 0,
      updatedAt: null,
      projectId: 'demo-live',
      firestore: {},
      rtdb: {},
      defaultRtdbInstance: 'demo-live-default-rtdb',
      stats: {
        firestoreDocs: 0,
        rtdbInstances: 0,
        byteEstimate: 0,
        truncated: false,
        droppedCount: 0,
      },
    },
    initPayload: { seed: null },
    seedRequests: [],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestPath(input);
    if (url.endsWith('/__pyric/health')) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          live: {
            projectId: 'demo-live',
            configProjectId: 'demo-live',
            configSource: '.firebaserc',
            appProjectIds: ['demo-live'],
            billed: { reads: 2, writes: 1, deliveries: 0 },
            admin: { mode: 'observed', observed: true, bypassesRules: true },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/__pyric/live/session-data')) {
      return new Response(JSON.stringify(serverState.snapshot), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/__pyric/live/seed-sandbox')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      serverState.seedRequests.push(body);
      if (body.confirm !== true) {
        return new Response(
          JSON.stringify({ ok: false, code: 'PYRIC_SEED_CONFIRM_REQUIRED', error: 'Confirm required' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          mode: body.mode ?? 'merge',
          seededFirestoreDocs: Object.keys(serverState.snapshot.firestore).length,
          seededRtdbInstances: Object.keys(serverState.snapshot.rtdb),
          revision: serverState.snapshot.revision,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/__pyric/init.json')) {
      return new Response(JSON.stringify(serverState.initPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  resetServeInitForTests();
  globalThis.fetch = originalFetch;
});

describe('Studio Live-mode Observed Session Data & Opt-in Seeding', () => {
  it('renders clear partial/read-only badges and honest empty states when nothing has been observed yet', async () => {
    window.history.replaceState(null, '', '/firestore');
    const fsView = render(
      <EnvironmentProvider>
        <DataFeature view="firestore" />
      </EnvironmentProvider>,
    );

    await waitFor(() =>
      expect(fsView.container.querySelector('[data-live-observed-badge]')?.textContent).toContain(
        'Observed this session · Partial · Read-only',
      ),
    );
    expect(fsView.container.textContent).toContain(
      'No Firestore reads or writes observed in this live session yet.',
    );
    // "+ New" creation controls are hidden in Live mode.
    expect(fsView.container.querySelector('.fs-add')).toBeNull();
    // Seeding button is disabled when 0 docs / 0 RTDB instances have been observed.
    expect(
      (fsView.container.querySelector('[data-live-open-seed]') as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    window.history.replaceState(null, '', '/rtdb');
    const rtdbView = render(
      <EnvironmentProvider>
        <RtdbSurface />
      </EnvironmentProvider>,
    );

    await waitFor(() =>
      expect(rtdbView.container.querySelector('[data-rtdb-live-empty]')).not.toBeNull(),
    );
    expect(rtdbView.container.textContent).toContain(
      'Inspect Realtime Database paths observed during this live session (partial, read-only).',
    );
    expect(rtdbView.container.textContent).not.toContain(
      'Browse and edit RTDB data in the shared sandbox.',
    );
    expect(rtdbView.container.textContent).toContain('Observed this session · Empty');
  });

  it('renders observed Firestore docs (including phantom parents) and RTDB paths as read-only without edit/delete controls', async () => {
    serverState.snapshot = {
      revision: 2,
      updatedAt: 5000,
      projectId: 'demo-live',
      firestore: {
        'rooms/lobby': {
          title: 'Main Lobby',
          createdAt: { seconds: 1700000000, nanoseconds: 0 },
        },
        // Nested subcollection under an unobserved ("missing" / phantom) parent doc!
        'teams/phantom-team/members/ada': {
          role: 'owner',
        },
      },
      rtdb: {
        'demo-live-default-rtdb': {
          presence: { ada: 'online', grace: 'idle' },
        },
      },
      defaultRtdbInstance: 'demo-live-default-rtdb',
      stats: {
        firestoreDocs: 2,
        rtdbInstances: 1,
        byteEstimate: 256,
        truncated: true,
        droppedCount: 4,
      },
      sources: {
        client: true,
        admin: true,
      },
    };

    window.history.replaceState(null, '', '/firestore/rooms/lobby');
    const fsView = render(
      <EnvironmentProvider>
        <DataFeature view="firestore" />
      </EnvironmentProvider>,
    );

    await waitFor(() => expect(fsView.container.textContent).toContain('Main Lobby'));
    expect(fsView.container.querySelector('[data-live-observed-badge]')?.textContent).toBe(
      'Observed · Client + Admin · Partial · Read-only',
    );
    expect(fsView.container.querySelector('[data-live-observed-truncated]')?.textContent).toContain(
      '4 older entries evicted',
    );
    // Read-only invariants: no "+ New", "+ Add field", "+ Start collection", pencil edit, or trash icons.
    expect(fsView.container.querySelector('.fs-add')).toBeNull();
    expect(fsView.container.querySelector('.fs-doc-del')).toBeNull();
    expect(fsView.container.querySelector('.fs-doctree__action')).toBeNull();
    expect(fsView.container.querySelector('.fs-doctree__icon')).toBeNull();
    cleanup();

    // Navigate into the phantom parent collection to verify phantom traversal works in read-only mode.
    window.history.replaceState(null, '', '/firestore/teams');
    const phantomView = render(
      <EnvironmentProvider>
        <DataFeature view="firestore" />
      </EnvironmentProvider>,
    );
    await waitFor(() => expect(phantomView.container.textContent).toContain('phantom-team'));
    expect(phantomView.container.textContent).toContain('missing');
    cleanup();

    // RTDB Live observed surface renders read-only tree without edit/add/delete controls.
    window.history.replaceState(null, '', '/rtdb/presence');
    const rtdbView = render(
      <EnvironmentProvider>
        <RtdbSurface />
      </EnvironmentProvider>,
    );
    await waitFor(() => expect(rtdbView.container.textContent).toContain('"online"'));
    expect(rtdbView.container.querySelector('[data-rtdb-readonly]')).not.toBeNull();
    expect(rtdbView.container.querySelector('[data-rtdb-actions]')).toBeNull();
    expect(rtdbView.container.querySelector('[data-rtdb-editor]')).toBeNull();
  });

  it('requires explicit confirmation in Studio before sending POST /__pyric/live/seed-sandbox with { confirm: true }', async () => {
    serverState.snapshot = {
      revision: 4,
      updatedAt: 9000,
      projectId: 'demo-live',
      firestore: { 'users/ada': { name: 'Ada' } },
      rtdb: { 'demo-live-default-rtdb': { flags: { beta: true } } },
      defaultRtdbInstance: 'demo-live-default-rtdb',
      stats: {
        firestoreDocs: 1,
        rtdbInstances: 1,
        byteEstimate: 120,
        truncated: false,
        droppedCount: 0,
      },
    };

    window.history.replaceState(null, '', '/firestore');
    const view = render(
      <EnvironmentProvider>
        <DataFeature view="firestore" />
      </EnvironmentProvider>,
    );

    await waitFor(() =>
      expect(
        (view.container.querySelector('[data-live-open-seed]') as HTMLButtonElement | null)
          ?.disabled,
      ).toBe(false),
    );

    // Opening the confirmation panel sends NO seed request yet.
    fireEvent.click(view.container.querySelector('[data-live-open-seed]')!);
    expect(view.container.querySelector('[data-live-seed-confirm]')).not.toBeNull();
    expect(serverState.seedRequests).toHaveLength(0);

    // Select "Replace local sandbox data" and click "Confirm seed".
    const replaceRadio = view.container.querySelector(
      'input[name="pyric-live-seed-mode"][value="replace"]',
    )!;
    fireEvent.click(replaceRadio);
    fireEvent.click(view.container.querySelector('[data-live-confirm-seed]')!);

    await waitFor(() =>
      expect(view.container.querySelector('[data-live-seed-result]')?.textContent).toContain(
        'Seeded local sandbox (replace)',
      ),
    );
    expect(serverState.seedRequests).toEqual([{ confirm: true, mode: 'replace' }]);
  });

  it('keeps Auth gated behind LiveServiceUnavailable while mounting the read-only Observed Storage browser', async () => {
    window.history.replaceState(null, '', '/auth');
    const authView = render(
      <EnvironmentProvider>
        <DataFeature view="auth" />
      </EnvironmentProvider>,
    );
    await waitFor(() =>
      expect(authView.container.querySelector('[data-pyric-ui="live-service-unavailable"]')).not.toBeNull(),
    );
    const authNotice = authView.container.querySelector('[data-pyric-ui="live-service-unavailable"]')!;
    expect(authNotice.textContent).toContain('Live mode · Read-only');
    expect(authNotice.textContent).toContain('Auth user listing is unavailable in Live mode');
    expect(authNotice.textContent).toContain(
      'Live mode observes your app’s client SDK traffic without Admin credentials, so it cannot enumerate production Auth users and never mutates local sandbox users implicitly. Inspect observed Auth operations in Traffic.',
    );
    expect(authView.container.querySelector('[data-live-observed-badge]')).not.toBeNull();
    cleanup();

    serverState.snapshot = {
      ...serverState.snapshot,
      revision: 5,
      defaultStorageBucket: 'demo-live.firebasestorage.app',
      storage: {
        'demo-live.firebasestorage.app': {
          prefixes: ['workspaces/ws-1'],
          objects: {
            'workspaces/ws-1/cover.png': {
              bucket: 'demo-live.firebasestorage.app',
              fullPath: 'workspaces/ws-1/cover.png',
              name: 'cover.png',
              size: 1024,
              contentType: 'image/png',
              customMetadata: {
                role: 'hero',
                firebaseStorageDownloadTokens: '[REDACTED]',
              },
              downloadUrl:
                'https://firebasestorage.googleapis.com/v0/b/demo-live.firebasestorage.app/o/cover.png?alt=media&token=abc',
            },
          },
        },
      },
      stats: {
        ...serverState.snapshot.stats,
        storageBuckets: 1,
        storageObjects: 1,
      },
    };

    window.history.replaceState(null, '', '/storage/workspaces/ws-1/cover.png');
    const storageView = render(
      <EnvironmentProvider>
        <DataFeature view="storage" />
      </EnvironmentProvider>,
    );
    await waitFor(() =>
      expect(
        storageView.container.querySelector('[data-pyric-ui="storage-live-observed"]'),
      ).not.toBeNull(),
    );
    expect(storageView.container.querySelector('[data-pyric-ui="live-service-unavailable"]')).toBeNull();
    await waitFor(() =>
      expect(storageView.container.querySelector('[data-live-storage-no-bytes]')).not.toBeNull(),
    );
    expect(storageView.container.querySelector('[data-live-observed-counts]')?.textContent).toContain(
      '1 Storage object',
    );
    expect(
      storageView.container.querySelector(
        '[data-pyric-metadata-key="firebaseStorageDownloadTokens"] dd',
      )?.textContent,
    ).toBe('[REDACTED]');
    const downloadAnchor = storageView.container.querySelector(
      '[data-live-storage-download-url]',
    ) as HTMLAnchorElement | null;
    expect(downloadAnchor).not.toBeNull();
    expect(downloadAnchor?.getAttribute('href')).toBe(
      'https://firebasestorage.googleapis.com/v0/b/demo-live.firebasestorage.app/o/cover.png?alt=media',
    );
    expect(downloadAnchor?.getAttribute('href')).not.toContain('token=');
    cleanup();

    // Prefix-only bucket shows `1 Storage bucket` rather than `0 Storage objects`.
    serverState.snapshot = {
      ...serverState.snapshot,
      revision: 6,
      storage: {
        'demo-live.firebasestorage.app': {
          prefixes: ['workspaces/ws-1'],
          objects: {},
        },
      },
      stats: {
        ...serverState.snapshot.stats,
        storageBuckets: 1,
        storageObjects: 0,
      },
    };
    window.history.replaceState(null, '', '/storage');
    const prefixOnlyView = render(
      <EnvironmentProvider>
        <DataFeature view="storage" />
      </EnvironmentProvider>,
    );
    await waitFor(() =>
      expect(prefixOnlyView.container.querySelector('[data-live-observed-counts]')?.textContent).toContain(
        '1 Storage bucket',
      ),
    );
    expect(prefixOnlyView.container.querySelector('[data-live-observed-counts]')?.textContent).not.toContain(
      '0 Storage objects',
    );
  });

  it('lists configured RTDB shards from init.json, auto-selects observed shard-03, renders shard-empty copy, and shows skip breakdown', async () => {
    serverState.initPayload = {
      seed: null,
      databaseInstances: {
        defaultInstance: 'demo-live-default-rtdb',
        rules: {
          'demo-live-default-rtdb': {},
          'demo-live-shard-01': {},
          'demo-live-shard-03': {},
        },
      },
    };
    serverState.snapshot = {
      revision: 3,
      updatedAt: 9000,
      projectId: 'demo-live',
      firestore: {},
      rtdb: {
        'demo-live-shard-03': {
          rooms: {
            r1: { title: 'Observed Shard Room' },
          },
        },
      },
      defaultRtdbInstance: 'demo-live-default-rtdb',
      stats: {
        firestoreDocs: 0,
        rtdbInstances: 1,
        byteEstimate: 512,
        truncated: false,
        droppedCount: 0,
      },
      skips: {
        oversized: 1,
        unsupported: 0,
        truncated: 3,
        failed: 2,
        admin: 1,
      },
    };

    window.history.replaceState(null, '', '/rtdb');
    const view = render(
      <EnvironmentProvider>
        <RtdbSurface />
      </EnvironmentProvider>,
    );

    await waitFor(() =>
      expect(view.container.querySelector('[data-rtdb-instance-bar]')).not.toBeNull(),
    );
    await waitFor(() => expect(view.container.textContent).toContain('demo-live-shard-03 (observed)'));
    expect(view.container.textContent).toContain('rooms');

    const defaultPill = view.container.querySelector('[data-rtdb-instance="demo-live-default-rtdb"]')!;
    const shard01Pill = view.container.querySelector('[data-rtdb-instance="demo-live-shard-01"]')!;
    const shard03Pill = view.container.querySelector('[data-rtdb-instance="demo-live-shard-03"]')!;

    expect(shard03Pill.getAttribute('aria-selected')).toBe('true');
    expect(shard03Pill.getAttribute('data-rtdb-instance-observed')).toBe('true');
    expect(shard03Pill.textContent).toContain('1 key');
    expect(defaultPill.getAttribute('data-rtdb-instance-observed')).toBe('false');
    expect(defaultPill.textContent).toContain('default');
    expect(defaultPill.textContent).toContain('no traffic');

    const skipBanner = view.container.querySelector('[data-live-observed-skips]')!;
    expect(skipBanner.textContent).toContain('Not captured in Data:');
    expect(skipBanner.textContent).toContain('2 failed/denied calls');
    expect(skipBanner.textContent).toContain('1 Admin SDK call');
    expect(skipBanner.textContent).toContain('1 item over the size cap');
    expect(skipBanner.textContent).toContain('3 items dropped at the session budget');

    fireEvent.click(shard01Pill);
    await waitFor(() =>
      expect(view.container.querySelector('[data-rtdb-live-empty]')).not.toBeNull(),
    );
    expect(view.container.querySelector('[data-rtdb-live-empty]')?.textContent).toContain(
      'No Realtime Database reads or writes observed on demo-live-shard-01',
    );
  });
});
