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
import { cleanup, fireEvent, render } from '@testing-library/react';
import {
  BillableMetricsView,
  RulesMetricsView,
} from '../../../src/features/traffic/TrafficMetricsViews.js';
import type { StudioTrafficEvent } from '../../../src/features/traffic/verdict.js';

afterEach(() => cleanup());

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
});
