import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import {
  LiveObservedDataBanner,
  type LiveObservedDataBannerProps,
} from '../../src/components/LiveObservedDataBanner.js';

afterEach(() => cleanup());

function createObservedState(
  overrides: Partial<LiveObservedDataBannerProps['observed']['snapshot']> = {},
): LiveObservedDataBannerProps['observed'] {
  const baseSnapshot: LiveObservedDataBannerProps['observed']['snapshot'] = {
    revision: 1,
    updatedAt: 1000,
    projectId: 'demo-project',
    firestore: {},
    rtdb: {},
    defaultRtdbInstance: null,
    stats: {
      firestoreDocs: 0,
      rtdbInstances: 0,
      byteEstimate: 0,
      truncated: false,
      droppedCount: 0,
    },
    ...overrides,
  };
  return {
    status: 'ready',
    error: null,
    snapshot: baseSnapshot,
    handles: {} as LiveObservedDataBannerProps['observed']['handles'],
    firestoreApi: {} as LiveObservedDataBannerProps['observed']['firestoreApi'],
    rtdbApi: {} as LiveObservedDataBannerProps['observed']['rtdbApi'],
    rtdbInstances: [],
    rtdbInstanceSummaries: [],
    activeRtdbInstance: '',
    setActiveRtdbInstance: () => {},
    hasObservedRtdb: false,
    refresh: async () => {},
    seedLocalSandbox: async (mode) => ({
      ok: true,
      mode,
      seededFirestoreDocs: 0,
      seededRtdbInstances: [],
      revision: 1,
    }),
    exportSeedJson: () => '{}',
    downloadSeedJson: () => {},
  };
}

describe('LiveObservedDataBanner', () => {
  it('renders default session badge before any SDK source contributes', () => {
    const view = render(<LiveObservedDataBanner observed={createObservedState()} />);
    const badge = view.container.querySelector('[data-live-observed-badge]');
    expect(badge?.textContent).toBe('Observed this session · Partial · Read-only');
  });

  it('renders SDK provenance badge for client, admin, and combined client + admin sessions', () => {
    const clientView = render(
      <LiveObservedDataBanner
        observed={createObservedState({
          sources: { client: true, admin: false },
          stats: {
            firestoreDocs: 1,
            rtdbInstances: 0,
            byteEstimate: 32,
            truncated: false,
            droppedCount: 0,
          },
        })}
      />,
    );
    expect(clientView.container.querySelector('[data-live-observed-badge]')?.textContent).toBe(
      'Observed · Client · Partial · Read-only',
    );
    cleanup();

    const adminView = render(
      <LiveObservedDataBanner
        observed={createObservedState({
          sources: { client: false, admin: true },
          stats: {
            firestoreDocs: 2,
            rtdbInstances: 1,
            byteEstimate: 96,
            truncated: false,
            droppedCount: 0,
          },
        })}
      />,
    );
    expect(adminView.container.querySelector('[data-live-observed-badge]')?.textContent).toBe(
      'Observed · Admin · Partial · Read-only',
    );
    expect(adminView.container.querySelector('[data-live-observed-skips]')).toBeNull();
    cleanup();

    const combinedView = render(
      <LiveObservedDataBanner
        observed={createObservedState({
          sources: { client: true, admin: true },
          stats: {
            firestoreDocs: 3,
            rtdbInstances: 1,
            byteEstimate: 128,
            truncated: false,
            droppedCount: 0,
          },
        })}
      />,
    );
    expect(combinedView.container.querySelector('[data-live-observed-badge]')?.textContent).toBe(
      'Observed · Client + Admin · Partial · Read-only',
    );
  });

  it('summarizes uncaptured ops without listing captured Admin calls as skipped', () => {
    const view = render(
      <LiveObservedDataBanner
        observed={createObservedState({
          sources: { client: false, admin: true },
          skips: {
            oversized: 0,
            unsupported: 2,
            truncated: 0,
            failed: 0,
            admin: 0,
          },
        })}
      />,
    );
    const skipsText = view.container.querySelector('[data-live-observed-skips]')?.textContent ?? '';
    expect(skipsText).toContain(
      '2 uncaptured ops (sentinels, converters, projections, field masks, or client transactions)',
    );
    expect(skipsText).not.toContain('Admin SDK');
  });
});
