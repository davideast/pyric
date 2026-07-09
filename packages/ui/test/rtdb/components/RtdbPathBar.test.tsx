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
// React's change-event plugin probes IE-era attachEvent when it focuses a
// text input under JSDOM — no-op stubs keep the console clean.
(dom.window.HTMLElement.prototype as any).attachEvent = () => {};
(dom.window.HTMLElement.prototype as any).detachEvent = () => {};
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { RtdbPathBar } from '../../../src/rtdb/index.js';

afterEach(() => cleanup());

function queryAll(c: HTMLElement, sel: string): HTMLElement[] {
  return Array.from(c.querySelectorAll(sel)) as HTMLElement[];
}

describe('RtdbPathBar', () => {
  it('renders just the root crumb at the root path', () => {
    const { container } = render(
      <RtdbPathBar path="/" onNavigate={() => {}} rootLabel="teal-fox-sandbox" />,
    );
    const crumbs = queryAll(container, '[data-rtdb-crumb]');
    expect(crumbs.length).toBe(1);
    expect(crumbs[0].hasAttribute('data-rtdb-crumb-root')).toBe(true);
    expect(crumbs[0].hasAttribute('data-pyric-current')).toBe(true);
    expect(crumbs[0].textContent).toBe('teal-fox-sandbox');
  });

  it('renders one crumb per segment with the last marked current', () => {
    const { container } = render(
      <RtdbPathBar path="/rooms/r1" onNavigate={() => {}} rootLabel="db" />,
    );
    const crumbs = queryAll(container, '[data-rtdb-crumb]');
    expect(crumbs.map((c) => c.textContent)).toEqual(['db', 'rooms', 'r1']);
    const current = queryAll(container, '[data-pyric-current]');
    expect(current.length).toBe(1);
    expect(current[0].textContent).toBe('r1');
    expect(current[0].getAttribute('aria-current')).toBe('page');
  });

  it('fires onNavigate with the absolute crumb path (root = "/")', () => {
    const seen: string[] = [];
    const { container } = render(
      <RtdbPathBar path="/rooms/r1/messages" onNavigate={(p) => seen.push(p)} />,
    );
    const crumbs = queryAll(container, '[data-rtdb-crumb]');
    fireEvent.click(crumbs[2]); // r1
    fireEvent.click(crumbs[0]); // root
    expect(seen).toEqual(['/rooms/r1', '/']);
  });

  it('edit mode: pencil opens an input seeded with the path; Enter navigates', () => {
    const seen: string[] = [];
    const { container } = render(
      <RtdbPathBar path="/rooms" onNavigate={(p) => seen.push(p)} inputPrefix="db" />,
    );
    fireEvent.click(container.querySelector('[data-rtdb-path-edit]')!);
    const input = container.querySelector('[data-rtdb-path-input]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('/rooms');
    expect(container.querySelector('[data-rtdb-path-prefix]')!.textContent).toBe('db');

    fireEvent.change(input, { target: { value: 'users/u1//' } });
    fireEvent.submit(input.closest('form')!);
    expect(seen).toEqual(['/users/u1']);
    // Back to display mode.
    expect(container.querySelector('[data-rtdb-path-input]')).toBeNull();
  });

  it('edit mode: Escape cancels without navigating and restores crumbs', () => {
    const seen: string[] = [];
    const { container } = render(
      <RtdbPathBar path="/rooms" onNavigate={(p) => seen.push(p)} />,
    );
    fireEvent.click(container.querySelector('[data-rtdb-path-edit]')!);
    const input = container.querySelector('[data-rtdb-path-input]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/somewhere/else' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(seen).toEqual([]);
    expect(container.querySelector('[data-rtdb-path-input]')).toBeNull();
    // Re-open: the draft was reset to the real path.
    fireEvent.click(container.querySelector('[data-rtdb-path-edit]')!);
    expect(
      (container.querySelector('[data-rtdb-path-input]') as HTMLInputElement).value,
    ).toBe('/rooms');
  });

  it('parses a pasted URL on submit', () => {
    const seen: string[] = [];
    const { container } = render(<RtdbPathBar path="/" onNavigate={(p) => seen.push(p)} />);
    fireEvent.click(container.querySelector('[data-rtdb-path-edit]')!);
    const input = container.querySelector('[data-rtdb-path-input]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://demo.firebaseio.com/rooms/r1?print=pretty' },
    });
    fireEvent.submit(input.closest('form')!);
    expect(seen).toEqual(['/rooms/r1']);
  });
});
