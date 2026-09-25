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

  it('keeps one segment in the tab order: the active one', () => {
    const { container } = render(
      <SegmentedControl options={OPTIONS} value="deny" onChange={() => {}} />,
    );
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-pyric-segment]'));
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('keeps the first segment in the tab order when the value matches no option', () => {
    const { container } = render(
      <SegmentedControl options={OPTIONS} value={'none' as 'all'} onChange={() => {}} />,
    );
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-pyric-segment]'));
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves the selection and focus with arrow keys, Home and End, wrapping at the ends', () => {
    const picked: string[] = [];
    const { container } = render(
      <SegmentedControl options={OPTIONS} value="all" onChange={(value) => picked.push(value)} />,
    );
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-pyric-segment]'));

    fireEvent.keyDown(buttons[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]!);
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowDown' });
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(buttons[2]!);
    fireEvent.keyDown(buttons[1]!, { key: 'ArrowUp' });
    fireEvent.keyDown(buttons[1]!, { key: 'End' });
    fireEvent.keyDown(buttons[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]!);
    expect(picked).toEqual(['deny', 'deny', 'allow', 'all', 'allow', 'all']);
  });

  it('leaves other keys alone', () => {
    const picked: string[] = [];
    const { container } = render(
      <SegmentedControl options={OPTIONS} value="all" onChange={(value) => picked.push(value)} />,
    );
    const first = container.querySelector<HTMLButtonElement>('[data-pyric-segment]')!;
    fireEvent.keyDown(first, { key: 'a' });
    expect(picked).toEqual([]);
  });
});
