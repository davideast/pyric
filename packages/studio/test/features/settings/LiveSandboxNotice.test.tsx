// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
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
import { LiveSandboxNotice } from '../../../src/features/settings/LiveSandboxNotice.js';

afterEach(() => cleanup());

describe('LiveSandboxNotice', () => {
  it('renders on a live host and carries the host project id', () => {
    const { container } = render(<LiveSandboxNotice projectId="customer-portal-prod" />);
    const notice = container.querySelector('[data-live-notice]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status');
    expect(container.querySelector('[data-live-notice-project]')?.textContent).toBe('customer-portal-prod');
  });

  it('renders nothing without a live host', () => {
    const { container } = render(<LiveSandboxNotice projectId={null} />);
    expect(container.querySelector('[data-live-notice]')).toBeNull();
    expect(container.childElementCount).toBe(0);
  });
});
