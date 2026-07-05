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
import { render, cleanup } from '@testing-library/react';
import { TrafficStats } from '../../../src/traffic/index.js';
import type { TrafficStatsSummary } from '../../../src/traffic/index.js';

afterEach(() => cleanup());

const STATS: TrafficStatsSummary = {
  total: 4,
  allows: 3,
  denies: 1,
  unsupported: 0,
  denyRate: 0.25,
  byMethod: [
    { key: 'get', count: 3 },
    { key: 'update', count: 1 },
  ],
  byOrigin: [{ key: 'user', count: 4 }],
  byPath: [{ key: 'users/alice', count: 4 }],
};

describe('<TrafficStats>', () => {
  it('renders the totals row', () => {
    const { container } = render(<TrafficStats stats={STATS} />);
    expect(
      container.querySelector('[data-pyric-stat-key="total"] [data-pyric-stat-value]')!
        .textContent,
    ).toBe('4');
    expect(
      container.querySelector('[data-pyric-stat-key="denies"] [data-pyric-stat-value]')!
        .textContent,
    ).toBe('1');
  });

  it('renders the deny rate as a percentage and a CSS custom property', () => {
    const { container } = render(<TrafficStats stats={STATS} />);
    const root = container.querySelector(
      '[data-pyric-ui="traffic-stats"]',
    ) as HTMLElement;
    expect(root.style.getPropertyValue('--pyric-deny-rate')).toBe('0.25');
    expect(
      container.querySelector(
        '[data-pyric-stat-key="deny-rate"] [data-pyric-stat-value]',
      )!.textContent,
    ).toBe('25%');
  });

  it('renders a bucket group per breakdown dimension', () => {
    const { container } = render(<TrafficStats stats={STATS} />);
    const labels = Array.from(
      container.querySelectorAll('[data-pyric-stat-group]'),
    ).map((g) => g.getAttribute('data-pyric-stat-group-label'));
    expect(labels).toEqual(['method', 'origin', 'path']);
  });

  it('renders method buckets with labels and counts', () => {
    const { container } = render(<TrafficStats stats={STATS} />);
    const methodGroup = container.querySelector(
      '[data-pyric-stat-group-label="method"]',
    )!;
    const buckets = methodGroup.querySelectorAll('[data-pyric-stat-bucket]');
    expect(buckets.length).toBe(2);
    expect(
      buckets[0].querySelector('[data-pyric-stat-bucket-count]')!.textContent,
    ).toBe('3');
  });
});
