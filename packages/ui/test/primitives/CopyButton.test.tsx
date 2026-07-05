// Install JSDOM globals before importing React or RTL — see bunfig.toml
// for why this isn't preloaded globally.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { CopyButton } from '../../src/primitives/CopyButton.js';

// Use `render`'s returned `container` rather than RTL's `screen`
// global. `screen` queries `document.body` directly and has been
// observed to throw "global document has to be available" after
// our local `afterEach` clears the body — using the container
// keeps queries scoped and stable across the test lifecycle.
function getButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector('button');
  if (!btn) throw new Error('No <button> rendered');
  return btn as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe('CopyButton', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mock(() => Promise.resolve()) },
      configurable: true,
    });
  });

  it('renders a button with default "Copy" label when no children passed', () => {
    const { container } = render(<CopyButton text="hello" />);
    expect(getButton(container).textContent).toBe('Copy');
  });

  it('renders custom children when provided', () => {
    const { container } = render(<CopyButton text="hello">copy this</CopyButton>);
    expect(getButton(container).textContent).toBe('copy this');
  });

  it('writes the text to the clipboard on click', async () => {
    const writeMock = mock(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeMock },
      configurable: true,
    });

    const { container } = render(<CopyButton text="my-secret" />);
    await act(async () => {
      fireEvent.click(getButton(container));
    });
    expect(writeMock).toHaveBeenCalledWith('my-secret');
  });

  it('exposes data-copied attribute after a successful copy', async () => {
    const { container } = render(<CopyButton text="hello" />);
    const btn = getButton(container);
    expect(btn.hasAttribute('data-copied')).toBe(false);

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => expect(btn.hasAttribute('data-copied')).toBe(true));
  });

  it('clears the data-copied attribute after resetMs', async () => {
    const { container } = render(<CopyButton text="hello" resetMs={50} />);
    const btn = getButton(container);
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(btn.hasAttribute('data-copied')).toBe(true));
    await waitFor(() => expect(btn.hasAttribute('data-copied')).toBe(false), {
      timeout: 500,
    });
  });

  it('updates aria-label to "Copied" while copied', async () => {
    const { container } = render(<CopyButton text="hello" ariaLabel="Copy path" />);
    const btn = getButton(container);
    expect(btn.getAttribute('aria-label')).toBe('Copy path');

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => expect(btn.getAttribute('aria-label')).toBe('Copied'));
  });

  it('forwards className to the underlying button', () => {
    const { container } = render(<CopyButton text="hello" className="my-class other-class" />);
    expect(getButton(container).className).toBe('my-class other-class');
  });

  it('does not flip to copied if clipboard write rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mock(() => Promise.reject(new Error('denied'))) },
      configurable: true,
    });

    const { container } = render(<CopyButton text="hello" />);
    const btn = getButton(container);
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.hasAttribute('data-copied')).toBe(false);
  });
});
