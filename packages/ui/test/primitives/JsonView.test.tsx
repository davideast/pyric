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
import { JsonView } from '../../src/primitives/index.js';

afterEach(() => cleanup());

describe('<JsonView>', () => {
  it('renders a primitive value with its type', () => {
    const { container } = render(<JsonView value="hello" />);
    const node = container.querySelector(
      '[data-pyric-json-node][data-pyric-json-type="string"]',
    );
    expect(node).not.toBeNull();
    expect(
      node!.querySelector('[data-pyric-json-value]')!.textContent,
    ).toBe('"hello"');
  });

  it('renders null for null and undefined', () => {
    const { container } = render(<JsonView value={null} />);
    expect(
      container.querySelector('[data-pyric-json-type="null"]'),
    ).not.toBeNull();
  });

  it('renders object keys and nested values when expanded', () => {
    const { container } = render(
      <JsonView value={{ uid: 'alice', count: 2 }} />,
    );
    const keys = Array.from(
      container.querySelectorAll('[data-pyric-json-key]'),
    ).map((k) => k.textContent);
    expect(keys).toContain('uid');
    expect(keys).toContain('count');
  });

  it('collapses a container at/below defaultCollapsedDepth', () => {
    const { container } = render(
      <JsonView value={{ a: 1 }} defaultCollapsedDepth={0} />,
    );
    const root = container.querySelector('[data-pyric-json-type="object"]')!;
    expect(root.hasAttribute('data-pyric-collapsed')).toBe(true);
    // Collapsed → shows the summary placeholder, hides children.
    expect(
      container.querySelector('[data-pyric-json-summary]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-pyric-json-children]'),
    ).toBeNull();
  });

  it('toggles a container open via its toggle button', () => {
    const { container } = render(
      <JsonView value={{ a: 1 }} defaultCollapsedDepth={0} />,
    );
    expect(
      container.querySelector('[data-pyric-json-children]'),
    ).toBeNull();
    fireEvent.click(container.querySelector('[data-pyric-json-toggle]')!);
    expect(
      container.querySelector('[data-pyric-json-children]'),
    ).not.toBeNull();
  });

  it('renders array indices as keys', () => {
    const { container } = render(<JsonView value={['x', 'y']} />);
    const keys = Array.from(
      container.querySelectorAll('[data-pyric-json-key]'),
    ).map((k) => k.textContent);
    expect(keys).toEqual(['0', '1']);
  });
});
