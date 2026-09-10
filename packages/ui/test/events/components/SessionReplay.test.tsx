// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  SessionReplayControls,
  DivergenceSummary,
  ReplayDivergenceList,
  DivergenceInspector,
  SessionReplay,
} from '../../../src/events/components/index.js';
import type { ReplayDivergence } from '../../../src/events/replayTypes.js';

afterEach(cleanup);

const SAMPLE_DIVERGENCES: ReplayDivergence[] = [
  {
    kind: 'sentinel-drift',
    path: 'users/alice',
    field: 'updatedAt',
    sentinelKind: 'serverTimestamp',
    before: 100,
    after: 200,
  },
  {
    kind: 'now-denied',
    path: 'users/alice',
    method: 'delete',
    reason: 'permission-denied',
  },
  {
    kind: 'autoid-alias',
    originalPath: 'users/id1',
    replayedPath: 'users/id2',
  },
  {
    kind: 'real-divergence',
    path: 'users/bob',
    field: 'role',
    before: 'member',
    after: 'admin',
  },
];

describe('SessionReplayControls', () => {
  it('renders replay trigger and pinRequestTime checkbox with data attributes', () => {
    let replayed = false;
    let pin = true;
    const { container } = render(
      <SessionReplayControls
        onReplay={() => {
          replayed = true;
        }}
        pinRequestTime={pin}
        onPinRequestTimeChange={(p) => {
          pin = p;
        }}
        eventCount={3}
      />,
    );

    const controls = container.querySelector('[data-pyric-ui="session-replay-controls"]');
    expect(controls).not.toBeNull();

    const replayBtn = container.querySelector('[data-pyric-replay-run]');
    expect(replayBtn).not.toBeNull();
    fireEvent.click(replayBtn!);
    expect(replayed).toBe(true);

    const pinLabel = container.querySelector('[data-pyric-replay-pin-request-time]');
    expect(pinLabel).not.toBeNull();

    const count = container.querySelector('[data-pyric-replay-event-count]');
    expect(count?.textContent).toContain('3 events');
  });
});

describe('DivergenceSummary', () => {
  it('renders counts for total, real, sentinel-drift, and now-denied', () => {
    let selectedFilter = '';
    const { container } = render(
      <DivergenceSummary
        divergences={SAMPLE_DIVERGENCES}
        filter="all"
        onFilterChange={(f) => {
          selectedFilter = f;
        }}
      />,
    );

    const root = container.querySelector('[data-pyric-ui="divergence-summary"]');
    expect(root).not.toBeNull();

    expect(container.querySelector('[data-pyric-divergence-total]')?.textContent).toBe('4');
    expect(container.querySelector('[data-pyric-divergence-sentinel-drift]')?.textContent).toBe('1');
    expect(container.querySelector('[data-pyric-divergence-now-denied]')?.textContent).toBe('1');
    expect(container.querySelector('[data-pyric-divergence-real]')?.textContent).toBe('1');

    const sentinelBtn = container.querySelector('[data-pyric-divergence-filter="sentinel-drift"]');
    fireEvent.click(sentinelBtn!);
    expect(selectedFilter).toBe('sentinel-drift');
  });
});

describe('ReplayDivergenceList and DivergenceInspector', () => {
  it('renders list items and inspects selected item', () => {
    let selectedItem: ReplayDivergence | null = null;
    const { container } = render(
      <ReplayDivergenceList
        divergences={SAMPLE_DIVERGENCES}
        onSelect={(d) => {
          selectedItem = d;
        }}
      />,
    );

    const items = container.querySelectorAll('[data-pyric-divergence-item]');
    expect(items.length).toBe(4);

    fireEvent.click(items[0]!);
    expect(selectedItem).not.toBeNull();
  });

  it('inspects sentinel-drift divergence in DivergenceInspector', () => {
    const { container } = render(
      <DivergenceInspector divergence={SAMPLE_DIVERGENCES[0]} />,
    );

    const inspector = container.querySelector('[data-pyric-ui="divergence-inspector"]');
    expect(inspector).not.toBeNull();
    expect(container.querySelector('[data-pyric-sentinel-kind]')?.textContent).toBe('serverTimestamp');
    expect(container.querySelector('[data-pyric-diff-before]')).not.toBeNull();
    expect(container.querySelector('[data-pyric-diff-after]')).not.toBeNull();
  });

  it('inspects now-denied divergence in DivergenceInspector', () => {
    const { container } = render(
      <DivergenceInspector divergence={SAMPLE_DIVERGENCES[1]} />,
    );

    expect(container.querySelector('[data-pyric-denial-reason]')?.textContent).toBe('permission-denied');
    expect(container.querySelector('[data-pyric-denial-method]')?.textContent).toBe('delete');
  });
});

describe('SessionReplay composite component', () => {
  it('renders composite session replay UI', () => {
    const { container } = render(
      <SessionReplay
        events={[]}
        rules="rules_version = '2'; service cloud.firestore { match /{d=**} { allow read, write: if true; } }"
      />,
    );

    expect(container.querySelector('[data-pyric-ui="session-replay"]')).not.toBeNull();
    expect(container.querySelector('[data-pyric-ui="session-replay-controls"]')).not.toBeNull();
  });
});
