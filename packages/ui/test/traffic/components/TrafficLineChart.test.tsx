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
import { TrafficLineChart } from '../../../src/traffic/components/TrafficLineChart.js';
import { bucketBillableMetrics } from '../../../src/traffic/hooks/useTrafficMetrics.js';
import type { TimeWindow } from '../../../src/traffic/index.js';
import { evt } from '../helpers/fake-source.js';

afterEach(() => cleanup());

const WINDOW: TimeWindow = { start: 0, end: 1000 };

describe('<TrafficLineChart>', () => {
  it('renders the empty state when there are no points', () => {
    const { container } = render(
      <TrafficLineChart points={[]} series={[]} emptyState={<span>no metrics</span>} />,
    );
    const root = container.querySelector('[data-pyric-ui="traffic-line-chart"]')!;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
    expect(root.textContent).toBe('no metrics');
  });

  it('renders one path per series', () => {
    const events = [
      evt({ at: 50, method: 'get', result: 'allow' }),
      evt({ at: 150, method: 'set', result: 'allow' }),
      evt({ at: 950, method: 'delete', result: 'allow' }),
    ];
    const { points, series } = bucketBillableMetrics(events, WINDOW, 10);
    const { container } = render(<TrafficLineChart points={points} series={series} />);
    const lines = container.querySelectorAll('[data-pyric-chart-line]');
    expect(lines.length).toBe(3);
    expect(lines[0].getAttribute('data-pyric-series-key')).toBe('reads');
  });

  it('omits a line for a series excluded from `visible`', () => {
    const events = [evt({ at: 50, method: 'get', result: 'allow' })];
    const { points, series } = bucketBillableMetrics(events, WINDOW, 10);
    const { container } = render(
      <TrafficLineChart points={points} series={series} visible={new Set(['writes', 'deletes'])} />,
    );
    const lines = container.querySelectorAll('[data-pyric-chart-line]');
    expect(lines.length).toBe(2);
    expect(container.querySelector('[data-pyric-series-key="reads"]')).toBeNull();
  });

  it('can omit zero-total series without hiding their metric card', () => {
    const events = [evt({ at: 50, method: 'get', result: 'allow' })];
    const { points, series } = bucketBillableMetrics(events, WINDOW, 10);
    const { container } = render(
      <TrafficLineChart points={points} series={series} omitZeroSeries />,
    );
    const lines = container.querySelectorAll('[data-pyric-chart-line]');
    expect(lines.length).toBe(1);
    expect(lines[0].getAttribute('data-pyric-series-key')).toBe('reads');
  });

  it('shows a tooltip with per-series values on hover', () => {
    const events = [evt({ at: 50, method: 'get', result: 'allow' })];
    const { points, series } = bucketBillableMetrics(events, WINDOW, 10);
    const { container } = render(<TrafficLineChart points={points} series={series} />);
    expect(container.querySelector('[data-pyric-chart-tooltip]')).toBeNull();
    const firstHit = container.querySelector('[data-pyric-chart-hit][data-pyric-point-index="0"]')!;
    fireEvent.mouseEnter(firstHit);
    const tooltip = container.querySelector('[data-pyric-chart-tooltip]');
    expect(tooltip).not.toBeNull();
    const readsRow = tooltip!.querySelector('[data-pyric-series-key="reads"] [data-pyric-tooltip-value]');
    expect(readsRow!.textContent).toBe('1');
  });

  it('hides the tooltip on mouse leave', () => {
    const events = [evt({ at: 50, method: 'get', result: 'allow' })];
    const { points, series } = bucketBillableMetrics(events, WINDOW, 10);
    const { container } = render(<TrafficLineChart points={points} series={series} />);
    const firstHit = container.querySelector('[data-pyric-chart-hit][data-pyric-point-index="0"]')!;
    fireEvent.mouseEnter(firstHit);
    fireEvent.mouseLeave(firstHit);
    expect(container.querySelector('[data-pyric-chart-tooltip]')).toBeNull();
  });
});
