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
import { RuleHeatmap } from '../../../src/traffic/index.js';
import type { RuleHeatmapEntry } from '../../../src/traffic/index.js';

afterEach(() => cleanup());

const ENTRIES: RuleHeatmapEntry[] = [
  {
    ruleIndex: 0,
    operations: ['read'],
    total: 10,
    allows: 10,
    denies: 0,
    unsupported: 0,
    denyRatio: 0,
  },
  {
    ruleIndex: 2,
    operations: ['update'],
    total: 4,
    allows: 1,
    denies: 3,
    unsupported: 0,
    denyRatio: 0.75,
  },
];

describe('<RuleHeatmap>', () => {
  it('renders the empty state when there are no entries', () => {
    const { container } = render(
      <RuleHeatmap entries={[]} emptyState={<span>no rules</span>} />,
    );
    const root = container.querySelector('[data-pyric-ui="rule-heatmap"]')!;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
    expect(root.textContent).toBe('no rules');
  });

  it('renders one row per entry with index + count attrs', () => {
    const { container } = render(<RuleHeatmap entries={ENTRIES} />);
    const rows = container.querySelectorAll('[data-pyric-rule-row]');
    expect(rows.length).toBe(2);
    expect(rows[0].getAttribute('data-pyric-rule-index')).toBe('0');
    expect(
      rows[0].querySelector('[data-pyric-rule-total]')!.textContent,
    ).toBe('10');
    expect(
      rows[1].querySelector('[data-pyric-rule-denies]')!.textContent,
    ).toBe('3');
  });

  it('buckets deny ratio into a heat level', () => {
    const { container } = render(<RuleHeatmap entries={ENTRIES} />);
    const rows = container.querySelectorAll('[data-pyric-rule-row]');
    expect(rows[0].getAttribute('data-pyric-rule-heat')).toBe('none');
    expect(rows[1].getAttribute('data-pyric-rule-heat')).toBe('high');
  });

  it('exposes the raw deny ratio as a CSS custom property', () => {
    const { container } = render(<RuleHeatmap entries={ENTRIES} />);
    const row = container.querySelectorAll('[data-pyric-rule-row]')[1] as HTMLElement;
    expect(row.style.getPropertyValue('--pyric-deny-ratio')).toBe('0.75');
  });

  it('fires onSelectRule with the clicked rule index', () => {
    let picked: number | null = null;
    const { container } = render(
      <RuleHeatmap entries={ENTRIES} onSelectRule={(i) => (picked = i)} />,
    );
    fireEvent.click(
      container.querySelectorAll('[data-pyric-rule-row]')[1],
    );
    expect(picked).toBe(2);
  });

  it('marks the selected rule row', () => {
    const { container } = render(
      <RuleHeatmap entries={ENTRIES} selectedRuleIndex={2} />,
    );
    const selected = container.querySelectorAll(
      '[data-pyric-rule-row][data-pyric-selected]',
    );
    expect(selected.length).toBe(1);
    expect(selected[0].getAttribute('data-pyric-rule-index')).toBe('2');
  });
});
