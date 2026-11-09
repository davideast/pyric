import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { LiveServiceUnavailable } from '../../src/components/LiveServiceUnavailable.js';

afterEach(() => cleanup());

describe('LiveServiceUnavailable', () => {
  it('renders read-only live-mode copy for Auth', () => {
    const authView = render(<LiveServiceUnavailable view="auth" />);
    expect(authView.container.textContent).toContain('Live mode · Read-only');
    expect(authView.container.textContent).toContain('Auth user listing is unavailable in Live mode');
  });
});
