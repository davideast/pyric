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
import { TrafficMetricCards } from '../../../src/traffic/components/TrafficMetricCards.js';
import type { MetricSeries } from '../../../src/traffic/hooks/useTrafficMetrics.js';

afterEach(() => cleanup());

const SERIES: MetricSeries[] = [
  { key: 'reads', label: 'Read ops', values: [1, 2], total: 3 },
  { key: 'writes', label: 'Writes', values: [0, 1], total: 1 },
  { key: 'deletes', label: 'Deletes', values: [0, 0], total: 0 },
];

describe('<TrafficMetricCards>', () => {
  it('renders one card per series with its total, no checkboxes by default', () => {
    const { container } = render(<TrafficMetricCards series={SERIES} />);
    const cards = container.querySelectorAll('[data-pyric-metric-card]');
    expect(cards.length).toBe(3);
    expect(cards[0].querySelector('[data-pyric-metric-value]')!.textContent).toBe('3');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('renders a checkbox per card when visible + onToggle are supplied', () => {
    let toggled: string | null = null;
    const { container } = render(
      <TrafficMetricCards
        series={SERIES}
        visible={new Set(['reads', 'writes', 'deletes'])}
        onToggle={(key) => (toggled = key)}
      />,
    );
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(3);
    fireEvent.click(checkboxes[1]);
    expect(toggled).toBe('writes');
  });

  it('marks a toggled-off card with data-pyric-metric-hidden', () => {
    const { container } = render(
      <TrafficMetricCards series={SERIES} visible={new Set(['reads'])} onToggle={() => {}} />,
    );
    const writesCard = container.querySelector('[data-pyric-metric-key="writes"]')!;
    expect(writesCard.hasAttribute('data-pyric-metric-hidden')).toBe(true);
    const readsCard = container.querySelector('[data-pyric-metric-key="reads"]')!;
    expect(readsCard.hasAttribute('data-pyric-metric-hidden')).toBe(false);
  });

  it('uses a custom formatValue', () => {
    const { container } = render(
      <TrafficMetricCards series={SERIES} formatValue={(n) => `${n}x`} />,
    );
    expect(container.querySelector('[data-pyric-metric-value]')!.textContent).toBe('3x');
  });
});
