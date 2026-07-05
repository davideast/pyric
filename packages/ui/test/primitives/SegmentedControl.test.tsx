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
import { SegmentedControl } from '../../src/primitives/index.js';

afterEach(() => cleanup());

const OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'deny', label: 'Denied', tone: 'error' },
  { value: 'allow', label: 'Allowed', tone: 'ok' },
] as const;

describe('<SegmentedControl>', () => {
  it('renders one button per option inside a radiogroup', () => {
    const { container } = render(
      <SegmentedControl options={OPTIONS} value="all" onChange={() => {}} />,
    );
    expect(
      container.querySelector('[data-pyric-ui="segmented-control"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-pyric-segment]').length).toBe(3);
    expect(
      container.querySelector('[role="radiogroup"]'),
    ).not.toBeNull();
  });

  it('marks the selected option with data-pyric-active + aria-checked', () => {
    const { container } = render(
      <SegmentedControl options={OPTIONS} value="deny" onChange={() => {}} />,
    );
    const active = container.querySelectorAll(
      '[data-pyric-segment][data-pyric-active]',
    );
    expect(active.length).toBe(1);
    expect(active[0].textContent).toBe('Denied');
    expect(active[0].getAttribute('aria-checked')).toBe('true');
  });

  it('surfaces tone as data-pyric-segment-tone', () => {
    const { container } = render(
      <SegmentedControl options={OPTIONS} value="all" onChange={() => {}} />,
    );
    expect(
      container.querySelector('[data-pyric-segment-tone="error"]')!.textContent,
    ).toBe('Denied');
  });

  it('fires onChange with the clicked value', () => {
    let picked: string | null = null;
    const { container } = render(
      <SegmentedControl
        options={OPTIONS}
        value="all"
        onChange={(v) => {
          picked = v;
        }}
      />,
    );
    const allowBtn = Array.from(
      container.querySelectorAll('[data-pyric-segment]'),
    ).find((b) => b.textContent === 'Allowed')!;
    fireEvent.click(allowBtn);
    expect(picked).toBe('allow');
  });
});
