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

import { afterEach, describe, it, expect, mock } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  AuthProviderToggles,
  DEFAULT_KNOWN_PROVIDER_IDS,
} from '../../../src/auth/index.js';

afterEach(() => cleanup());

describe('<AuthProviderToggles>', () => {
  it('renders one row per known provider, in order, even with an empty config', () => {
    const { container } = render(<AuthProviderToggles config={[]} onToggle={() => {}} />);
    const rows = Array.from(container.querySelectorAll('[data-pyric-provider-toggle]')).map(
      (r) => r.getAttribute('data-pyric-provider-id'),
    );
    expect(rows).toEqual([...DEFAULT_KNOWN_PROVIDER_IDS]);
  });

  it('reflects config: enabled providers are checked and carry data-pyric-provider-enabled', () => {
    const { container } = render(
      <AuthProviderToggles
        config={[
          { providerId: 'password', enabled: true },
          { providerId: 'anonymous', enabled: true },
          { providerId: 'google.com', enabled: false },
        ]}
        onToggle={() => {}}
      />,
    );
    const passwordRow = container.querySelector('[data-pyric-provider-id="password"]')!;
    expect(passwordRow.hasAttribute('data-pyric-provider-enabled')).toBe(true);
    expect(
      (passwordRow.querySelector('input[type="checkbox"]') as HTMLInputElement).checked,
    ).toBe(true);

    const googleRow = container.querySelector('[data-pyric-provider-id="google.com"]')!;
    expect(googleRow.hasAttribute('data-pyric-provider-enabled')).toBe(false);
  });

  it('clicking a checkbox fires onToggle with the flipped value', () => {
    const onToggle = mock(() => {});
    const { container } = render(
      <AuthProviderToggles
        config={[{ providerId: 'google.com', enabled: false }]}
        onToggle={onToggle}
      />,
    );
    const checkbox = container.querySelector(
      '[data-pyric-provider-id="google.com"] input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith('google.com', true);
  });

  it('renders custom (non-known) providers already in config as extra rows', () => {
    const { container } = render(
      <AuthProviderToggles
        config={[{ providerId: 'yahoo.com', enabled: true }]}
        onToggle={() => {}}
      />,
    );
    const row = container.querySelector('[data-pyric-provider-id="yahoo.com"]');
    expect(row).not.toBeNull();
    expect(row!.hasAttribute('data-pyric-provider-custom')).toBe(true);
  });

  // NOTE on text-input events under bun:test + JSDOM (same environment quirk
  // documented in DocumentEditor.test.tsx): `fireEvent.change` on a
  // controlled `<input type="text">` does not fire React's onChange handler
  // here, so the "type → button enables → submit" path can't be driven via
  // fireEvent in this suite. The button's disabled-when-empty starting state
  // and the submit handler's guard (empty/whitespace never calls onToggle)
  // are still directly verifiable.
  it('the add-provider button starts disabled (empty input)', () => {
    const { container } = render(<AuthProviderToggles config={[]} onToggle={() => {}} />);
    const button = container.querySelector('[data-pyric-add-provider]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('submitting the add-provider form while disabled never calls onToggle', () => {
    const onToggle = mock(() => {});
    const { container } = render(<AuthProviderToggles config={[]} onToggle={onToggle} />);
    const form = container.querySelector('[data-pyric-add-provider-form]') as HTMLFormElement;
    fireEvent.submit(form);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('surfaces an error via data-pyric-provider-toggles-error', () => {
    const { container } = render(
      <AuthProviderToggles config={[]} onToggle={() => {}} error={new Error('boom')} />,
    );
    expect(container.querySelector('[data-pyric-provider-toggles-error]')?.textContent).toBe(
      'boom',
    );
  });
});
