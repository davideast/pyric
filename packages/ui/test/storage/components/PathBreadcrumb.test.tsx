// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { PathBreadcrumb } from '../../../src/storage/index.js';

afterEach(() => cleanup());

function queryAll(c: HTMLElement, sel: string): HTMLElement[] {
  return Array.from(c.querySelectorAll(sel)) as HTMLElement[];
}

describe('PathBreadcrumb', () => {
  it('renders just the root crumb at the root path', () => {
    const { container } = render(<PathBreadcrumb path="" />);
    const links = queryAll(container, '[data-pyric-breadcrumb-link]');
    expect(links.length).toBe(1);
    expect(links[0].hasAttribute('data-pyric-breadcrumb-root')).toBe(true);
    expect(links[0].hasAttribute('data-pyric-current')).toBe(true);
    expect(links[0].getAttribute('aria-current')).toBe('page');
    expect(links[0].textContent).toBe('/');
  });

  it('renders one crumb per segment with the last marked current', () => {
    const { container } = render(<PathBreadcrumb path="docs/sub/deep" />);
    const links = queryAll(container, '[data-pyric-breadcrumb-link]');
    expect(links.map((l) => l.textContent)).toEqual(['/', 'docs', 'sub', 'deep']);

    const current = queryAll(container, '[data-pyric-current]');
    expect(current.length).toBe(1);
    expect(current[0].textContent).toBe('deep');
    expect(current[0].getAttribute('aria-current')).toBe('page');
  });

  it('fires onNavigate with the absolute ancestor path', () => {
    const seen: string[] = [];
    const { container } = render(
      <PathBreadcrumb path="docs/sub/deep" onNavigate={(p) => seen.push(p)} />,
    );
    const links = queryAll(container, '[data-pyric-breadcrumb-link]');
    fireEvent.click(links[2]); // 'sub'
    fireEvent.click(links[0]); // root
    expect(seen).toEqual(['docs/sub', '']);
  });

  it('normalizes a sloppy path prop', () => {
    const { container } = render(<PathBreadcrumb path="/docs//sub/" />);
    const links = queryAll(container, '[data-pyric-breadcrumb-link]');
    expect(links.map((l) => l.textContent)).toEqual(['/', 'docs', 'sub']);
  });

  it('renders custom rootLabel and separator, forwards className', () => {
    const { container } = render(
      <PathBreadcrumb
        path="docs"
        rootLabel="my-bucket"
        separator="›"
        className="crumbs"
      />,
    );
    const nav = container.querySelector('[data-pyric-ui="path-breadcrumb"]')!;
    expect(nav.className).toBe('crumbs');
    expect(
      container.querySelector('[data-pyric-breadcrumb-root]')!.textContent,
    ).toBe('my-bucket');
    const seps = queryAll(container, '[data-pyric-breadcrumb-separator]');
    expect(seps.length).toBe(1);
    expect(seps[0].textContent).toBe('›');
  });
});
