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

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import {
  BillableMetricsView,
  RulesMetricsView,
} from '../../../src/features/traffic/TrafficMetricsViews.js';
import type { StudioTrafficEvent } from '../../../src/features/traffic/verdict.js';
import { resetLiveStatusPollerForTesting } from '../../../src/shell/live-status.js';

const originalFetch = globalThis.fetch;

function installLiveHostHealth(): void {
  g.fetch = async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/__pyric/health')) {
      return new Response(
        JSON.stringify({
          ok: true,
          live: {
            projectId: 'demo-project',
            configProjectId: 'demo-project',
            configSource: '.firebaserc',
            appProjectIds: ['demo-project'],
            billed: { reads: 3, writes: 2, deliveries: 1 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('null', { status: 404 });
  };
}

afterEach(() => {
  cleanup();
  resetLiveStatusPollerForTesting();
  g.fetch = originalFetch;
});

function operation(
  id: string,
  method: StudioTrafficEvent['method'],
  at: number,
): StudioTrafficEvent {
  return {
    id,
    kind: 'operation',
    service: 'firestore',
    at,
    method,
    path: 'notes/one',
    auth: null,
    result: 'allow',
    reasons: [],
    origin: 'user',
    operationContext: {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    },
    rulesDisposition: { kind: 'evaluated', verdict: 'allow' },
  } as StudioTrafficEvent;
}

function rulesDecision(
  id: string,
  verdict: 'allow' | 'deny',
  at: number,
): StudioTrafficEvent {
  return {
    ...operation(id, 'get', at),
    result: verdict,
    rulesDisposition: { kind: 'evaluated', verdict },
  } as StudioTrafficEvent;
}

describe('<BillableMetricsView>', () => {
  it('leads with the observed story and prominent series totals', () => {
    const events = [
      operation('r1', 'get', 1_000),
      operation('r2', 'get', 2_000),
      operation('r3', 'list', 3_000),
      operation('w1', 'set', 4_000),
      operation('d1', 'delete', 5_000),
    ];
    const { container, getByText } = render(
      <BillableMetricsView events={events} window={{ start: 0, end: 10_000 }} />,
    );

    expect(getByText('5 observed billable operations')).toBeTruthy();
    expect(getByText('Read operations accounted for 60% of activity in this window.')).toBeTruthy();
    expect(
      container.querySelector('[data-pyric-metric-key="reads"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('3');
    expect(
      container.querySelector('[data-pyric-metric-key="writes"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('1');
    expect(
      container.querySelector('[data-pyric-metric-key="deletes"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('1');
    expect(getByText('When the activity happened')).toBeTruthy();
  });

  it('keeps the measurement boundary available but collapsed by default', () => {
    const { container, getByText } = render(
      <BillableMetricsView
        events={[operation('r1', 'list', 1_000)]}
        window={{ start: 0, end: 10_000 }}
      />,
    );

    const methodology = container.querySelector('.traffic__metric-methodology') as HTMLDetailsElement;
    expect(methodology.open).toBe(false);
    expect(getByText('How this is counted')).toBeTruthy();
    expect(container.textContent).toContain(
      'Source: Pyric Firestore sandbox events · Operation counts, not a Firebase invoice',
    );
    expect(container.textContent).toContain('Read ops are a proxy, not billed document reads.');
    expect(container.textContent).toContain('not a Firebase invoice');
  });

  it('does not mix other services into Firestore billing semantics', () => {
    const storageRead = {
      ...operation('storage-read', 'get', 2_000),
      service: 'storage',
    } as StudioTrafficEvent;
    const rtdbWrite = {
      ...operation('rtdb-write', 'set', 3_000),
      service: 'rtdb',
    } as StudioTrafficEvent;

    const { getByText } = render(
      <BillableMetricsView
        events={[operation('firestore-read', 'get', 1_000), storageRead, rtdbWrite]}
        window={{ start: 0, end: 10_000 }}
      />,
    );

    expect(getByText('1 observed billable operation')).toBeTruthy();
    expect(getByText('Read operations accounted for 100% of activity in this window.')).toBeTruthy();
  });

  it('uses each prominent metric as its chart-series toggle', () => {
    const { container } = render(
      <BillableMetricsView
        events={[operation('r1', 'get', 1_000), operation('w1', 'set', 2_000)]}
        window={{ start: 0, end: 10_000 }}
      />,
    );

    expect(container.querySelector('[data-pyric-chart-line][data-pyric-series-key="reads"]')).toBeTruthy();
    const readsToggle = container.querySelector(
      '[data-pyric-metric-key="reads"] input[type="checkbox"]',
    )!;
    fireEvent.click(readsToggle);
    expect(container.querySelector('[data-pyric-chart-line][data-pyric-series-key="reads"]')).toBeNull();
  });

  it('splits live-mode Billable metrics into Operation-metered (Firestore + Storage) and Bandwidth-metered (Realtime Database) panels', async () => {
    installLiveHostHealth();

    const liveEvents: StudioTrafficEvent[] = [
      {
        ...operation('fs-read', 'getDoc', 1_000),
        service: 'firestore',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' }, usage: { documentReads: 2 } },
      },
      {
        ...operation('storage-read', 'getDownloadURL', 1_500),
        service: 'storage',
        path: 'gs://demo-project.appspot.com/items/one.png',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' } },
      },
      {
        ...operation('rtdb-delivery', 'onValue', 2_000),
        service: 'rtdb',
        path: '/rooms/lobby',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' } },
      },
      {
        ...operation('rtdb-write', 'update', 3_000),
        service: 'rtdb',
        path: '/rooms/lobby',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' } },
      },
      {
        ...operation('storage-write', 'uploadBytes', 4_000),
        service: 'storage',
        path: 'gs://demo-project.appspot.com/items/one.png',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'ok' } },
      },
      {
        ...operation('admin-failed', 'DocumentReference.set', 5_000),
        service: 'firestore',
        result: 'error',
        operationContext: { source: { kind: 'app' }, authLens: { mode: 'admin' } },
        rulesDisposition: { kind: 'bypassed', reason: 'admin' },
        production: { outcome: { status: 'error', code: 'unavailable' } },
      },
      {
        ...operation('rtdb-denied', 'get', 6_000),
        service: 'rtdb',
        result: 'deny',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: { outcome: { status: 'error', code: 'permission_denied' } },
      },
    ];

    const { container, getByText } = render(
      <BillableMetricsView events={liveEvents} window={{ start: 0, end: 10_000 }} />,
    );

    await waitFor(() => {
      expect(getByText('4 observed billable operations')).toBeTruthy();
    });

    const opPanel = container.querySelector('[data-pyric-billable-panel="operation"]')!;
    const bwPanel = container.querySelector('[data-pyric-billable-panel="bandwidth"]')!;
    expect(opPanel).toBeTruthy();
    expect(bwPanel).toBeTruthy();

    expect(
      opPanel.querySelector('[data-pyric-metric-key="reads"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('3');
    expect(
      opPanel.querySelector('[data-pyric-metric-key="writes"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('1');
    expect(
      opPanel.querySelector('[data-pyric-metric-key="deletes"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('0');

    expect(getByText('2 observed Realtime Database transfers')).toBeTruthy();
    expect(
      bwPanel.querySelector('[data-pyric-metric-key="deliveries"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('1');
    expect(
      bwPanel.querySelector('[data-pyric-metric-key="writes"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('1');
    expect(
      bwPanel.querySelector('[data-pyric-metric-key="removes"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('0');

    expect(container.textContent).toContain(
      'Source: observed live requests · Firestore documents and Storage operations, not a Firebase invoice',
    );
    expect(container.textContent).toContain(
      'Source: observed live Realtime Database requests · Callback deliveries and mutations, not byte totals',
    );
    expect(container.textContent).not.toContain('Pyric Firestore sandbox events');
  });
});

describe('<RulesMetricsView>', () => {
  it('uses the same editorial hierarchy for observed allow and deny decisions', () => {
    const events = [
      rulesDecision('a1', 'allow', 1_000),
      rulesDecision('a2', 'allow', 2_000),
      rulesDecision('a3', 'allow', 3_000),
      rulesDecision('d1', 'deny', 4_000),
    ];
    const { container, getByText } = render(
      <RulesMetricsView events={events} window={{ start: 0, end: 10_000 }} />,
    );

    expect(getByText('4 observed Rules evaluations')).toBeTruthy();
    expect(getByText('Allowed requests accounted for 75% of evaluations in this window.')).toBeTruthy();
    expect(
      container.querySelector('[data-pyric-metric-key="allows"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('3');
    expect(
      container.querySelector('[data-pyric-metric-key="denies"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('1');
    expect(container.querySelector('[data-pyric-metric-key="errors"]')).toBeNull();
    expect(getByText('When Rules evaluated requests')).toBeTruthy();
  });

  it('counts only canonical evaluated dispositions', () => {
    const bypassed = {
      ...operation('bypass', 'get', 2_000),
      rulesDisposition: { kind: 'bypassed', reason: 'admin' },
    } as StudioTrafficEvent;
    const noRules = {
      ...operation('no-rules', 'get', 3_000),
      rulesDisposition: { kind: 'not-evaluated', reason: 'no-rules' },
    } as StudioTrafficEvent;
    const runtimeError = {
      ...operation('runtime', 'get', 4_000),
      result: 'error',
      rulesDisposition: { kind: 'not-evaluated', reason: 'runtime-error' },
    } as StudioTrafficEvent;

    const { container, getByText } = render(
      <RulesMetricsView
        events={[rulesDecision('denied', 'deny', 1_000), bypassed, noRules, runtimeError]}
        window={{ start: 0, end: 10_000 }}
      />,
    );

    expect(getByText('1 observed Rules evaluation')).toBeTruthy();
    expect(getByText('Denied requests accounted for 100% of evaluations in this window.')).toBeTruthy();
    expect(container.textContent).toContain(
      'Source: Pyric sandbox events · Evaluated Rules dispositions only',
    );
    expect(container.textContent).toContain('runtime errors are excluded');
  });

  it('keeps the prominent decision totals wired to chart visibility', () => {
    const { container } = render(
      <RulesMetricsView
        events={[rulesDecision('allowed', 'allow', 1_000), rulesDecision('denied', 'deny', 2_000)]}
        window={{ start: 0, end: 10_000 }}
      />,
    );

    expect(container.querySelector('[data-pyric-chart-line][data-pyric-series-key="denies"]')).toBeTruthy();
    fireEvent.click(
      container.querySelector('[data-pyric-metric-key="denies"] input[type="checkbox"]')!,
    );
    expect(container.querySelector('[data-pyric-chart-line][data-pyric-series-key="denies"]')).toBeNull();
  });

  it('counts advisory local rules evaluations across Firestore, Realtime Database, and Storage in live mode', async () => {
    installLiveHostHealth();

    const liveEvents: StudioTrafficEvent[] = [
      {
        ...operation('fs-allow', 'getDoc', 1_000),
        service: 'firestore',
        path: 'rooms/alpha',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: {
          outcome: { status: 'ok' },
          local: { result: 'allow' },
        },
      },
      {
        ...operation('rtdb-drift', 'update', 2_000),
        service: 'rtdb',
        path: '/rooms/alpha',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: {
          outcome: { status: 'ok' },
          local: { result: 'deny', drift: true },
        },
      },
      {
        ...operation('storage-deny', 'uploadBytes', 3_000),
        service: 'storage',
        path: 'gs://demo-project.appspot.com/items/one.png',
        result: 'deny',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: {
          outcome: { status: 'error', code: 'storage/unauthorized' },
          local: { result: 'deny' },
        },
      },
      {
        ...operation('rtdb-uneval', 'set', 4_000),
        service: 'rtdb',
        path: '/rooms/alpha/meta',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: {
          outcome: { status: 'ok' },
          local: { result: 'unevaluated', needs: ['write-data'] },
        },
      },
      {
        ...operation('admin-op', 'DocumentReference.set', 5_000),
        service: 'firestore',
        path: 'rooms/alpha',
        operationContext: { source: { kind: 'app' }, authLens: { mode: 'admin' } },
        rulesDisposition: { kind: 'bypassed', reason: 'admin' },
        production: { outcome: { status: 'ok' } },
      },
    ];

    const { container, getByText } = render(
      <RulesMetricsView events={liveEvents} window={{ start: 0, end: 10_000 }} />,
    );

    await waitFor(() => {
      expect(getByText('3 advisory local Rules evaluations')).toBeTruthy();
    });

    expect(getByText('Advisory local rules')).toBeTruthy();
    expect(
      getByText(
        'Local rules would deny 67% of evaluated requests in this window · 1 disagreed with production.',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-pyric-metric-key="allows"] [data-pyric-metric-label]')
        ?.textContent,
    ).toBe('Would allow');
    expect(
      container.querySelector('[data-pyric-metric-key="allows"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('1');
    expect(
      container.querySelector('[data-pyric-metric-key="denies"] [data-pyric-metric-label]')
        ?.textContent,
    ).toBe('Would deny');
    expect(
      container.querySelector('[data-pyric-metric-key="denies"] [data-pyric-metric-value]')
        ?.textContent,
    ).toBe('2');
    expect(container.textContent).toContain('Drift with production: 1');
    expect(container.textContent).toContain('Unevaluated locally: 1');
    expect(container.textContent).toContain('Denied by production: 1');
    expect(getByText('When local rules evaluated requests')).toBeTruthy();
    expect(container.textContent).toContain(
      'Source: observed live requests · Local rules evaluated against observed traffic (advisory)',
    );
    expect(container.textContent).not.toContain('Pyric sandbox events');
  });

  it('surfaces unevaluated live requests honestly when no local verdict could be decided', async () => {
    installLiveHostHealth();

    const liveEvents: StudioTrafficEvent[] = [
      {
        ...operation('rtdb-uneval', 'set', 2_000),
        service: 'rtdb',
        path: '/rooms/alpha/meta',
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
        production: {
          outcome: { status: 'ok' },
          local: { result: 'unevaluated', needs: ['write-data'] },
        },
      },
    ];

    const { container, getByText } = render(
      <RulesMetricsView events={liveEvents} window={{ start: 0, end: 10_000 }} />,
    );

    await waitFor(() => {
      expect(getByText('No decided local Rules evaluations')).toBeTruthy();
    });

    expect(
      getByText('1 observed request could not be evaluated locally in this window.'),
    ).toBeTruthy();
    expect(container.textContent).toContain('Unevaluated locally: 1');
  });
});
