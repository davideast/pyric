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
import { Badge } from '../../src/primitives/index.js';

afterEach(() => cleanup());

describe('<Badge>', () => {
  it('renders children and the badge marker attribute', () => {
    const { container } = render(<Badge>ALLOW</Badge>);
    const badge = container.querySelector('[data-pyric-badge]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('ALLOW');
  });

  it('surfaces kind as data-pyric-badge-kind', () => {
    const { container } = render(<Badge kind="deny">DENY</Badge>);
    expect(
      container.querySelector('[data-pyric-badge-kind="deny"]'),
    ).not.toBeNull();
  });

  it('omits the kind attribute when kind is unset', () => {
    const { container } = render(<Badge>X</Badge>);
    const badge = container.querySelector('[data-pyric-badge]')!;
    expect(badge.hasAttribute('data-pyric-badge-kind')).toBe(false);
  });

  it('hides the visible glyph from a11y when ariaLabel is set', () => {
    const { container } = render(
      <Badge ariaLabel="denied">✕</Badge>,
    );
    const badge = container.querySelector('[data-pyric-badge]')!;
    expect(badge.getAttribute('aria-label')).toBe('denied');
    expect(badge.querySelector('[aria-hidden="true"]')!.textContent).toBe('✕');
  });
});
