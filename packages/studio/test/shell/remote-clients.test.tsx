// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:3000',
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLButtonElement = dom.window.HTMLButtonElement;
g.HTMLOptionElement = dom.window.HTMLOptionElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.EventTarget = dom.window.EventTarget;
g.Event = dom.window.Event;
g.UIEvent = dom.window.UIEvent;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, render, fireEvent } from '@testing-library/react';
import type { RemoteConsumerRecord } from '@pyric/cli/bridge/client';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { RemoteClientsPopover } from '../../src/shell/RemoteClientsPopover.js';

afterEach(() => cleanup());

function changeInput(input: HTMLElement, value: string) {
  const propsKey = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (propsKey && (input as any)[propsKey]?.onChange) {
    (input as any)[propsKey].onChange({ target: { value } });
  } else {
    fireEvent.change(input, { target: { value } });
  }
}

describe('RemoteClientsPopover', () => {
  const sampleConsumers: RemoteConsumerRecord[] = [
    {
      clientSessionId: 'flutter-client-1234567890',
      platform: 'flutter',
      deviceLabel: 'iPhone 17 Pro',
      connectedAt: Date.now() - 30_000,
      lastSeen: Date.now() - 2_000,
      activeLens: { mode: 'app-session' },
    },
    {
      clientSessionId: 'swift-client-0987654321',
      platform: 'swift',
      deviceLabel: 'iOS Simulator',
      connectedAt: Date.now() - 60_000,
      lastSeen: Date.now() - 10_000,
      activeLens: { mode: 'admin' },
    },
    {
      clientSessionId: 'android-client-1122334455',
      platform: 'kotlin',
      deviceLabel: 'Pixel 8',
      connectedAt: Date.now() - 120_000,
      lastSeen: Date.now() - 25_000,
      activeLens: { mode: 'as', uid: 'user_alice', token: { role: 'editor' }, tenant: 'tenant-acme' },
    },
  ];

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <RemoteClientsPopover
        isOpen={false}
        onClose={() => {}}
        consumers={sampleConsumers}
        onSetLens={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders empty message when no clients connected', () => {
    const { getByText } = render(
      <RemoteClientsPopover
        isOpen={true}
        onClose={() => {}}
        consumers={[]}
        onSetLens={() => {}}
      />,
    );
    expect(getByText(/No remote mobile clients connected/i)).toBeDefined();
  });

  it('renders all connected mobile clients with platform badges and active lenses', () => {
    const { getByText, getAllByText } = render(
      <RemoteClientsPopover
        isOpen={true}
        onClose={() => {}}
        consumers={sampleConsumers}
        onSetLens={() => {}}
      />,
    );

    // Platform badges
    expect(getByText('Flutter')).toBeDefined();
    expect(getByText('iOS Swift')).toBeDefined();
    expect(getByText('Android Kotlin')).toBeDefined();

    // Device labels
    expect(getByText('iPhone 17 Pro')).toBeDefined();
    expect(getByText('iOS Simulator')).toBeDefined();
    expect(getByText('Pixel 8')).toBeDefined();

    // Active lenses
    expect(getAllByText('App Session').length).toBeGreaterThan(0);
    expect(getAllByText('Admin Bypass').length).toBeGreaterThan(0);
    expect(getByText(/User: user_alice/)).toBeDefined();
  });

  it('dispatches onSetLens when Admin or App Session buttons are clicked', () => {
    const setLensMock = mock((sessionId, lens) => {});
    const { getAllByRole } = render(
      <RemoteClientsPopover
        isOpen={true}
        onClose={() => {}}
        consumers={sampleConsumers}
        onSetLens={setLensMock}
      />,
    );

    const adminButtons = getAllByRole('button', { name: 'Admin' });
    expect(adminButtons.length).toBeGreaterThan(0);
    fireEvent.click(adminButtons[0]);

    expect(setLensMock).toHaveBeenCalledWith('flutter-client-1234567890', { mode: 'admin' });

    const appSessionButtons = getAllByRole('button', { name: 'App Session' });
    fireEvent.click(appSessionButtons[1]);
    expect(setLensMock).toHaveBeenCalledWith('swift-client-0987654321', { mode: 'app-session' });
  });

  it('allows manual UID switching with custom claims and tenant', () => {
    const setLensMock = mock((sessionId, lens) => {});
    const { getByText, getByPlaceholderText, getByRole } = render(
      <RemoteClientsPopover
        isOpen={true}
        onClose={() => {}}
        consumers={[sampleConsumers[0]]}
        onSetLens={setLensMock}
      />,
    );

    // Expand custom claims
    const advancedToggle = getByText('▼ Custom Claims / Tenant');
    fireEvent.click(advancedToggle);

    // Enter custom claims and tenant
    const claimsInput = getByPlaceholderText(/Custom Claims JSON/i);
    const tenantInput = getByPlaceholderText(/Tenant ID/i);
    const uidInput = getByPlaceholderText('Impersonate UID…');

    act(() => {
      changeInput(claimsInput, '{"role":"admin","level":2}');
      changeInput(tenantInput, 'acme-corp');
      changeInput(uidInput, 'user_bob');
    });

    // Click Switch
    const switchButton = getByRole('button', { name: 'Switch' });
    expect((switchButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(switchButton);

    expect(setLensMock).toHaveBeenCalledWith('flutter-client-1234567890', {
      mode: 'as',
      uid: 'user_bob',
      token: { role: 'admin', level: 2 },
      tenant: 'acme-corp',
    });
  });

  it('allows 1-click selection of sandbox users via auth.listUsers dropdown', () => {
    const setLensMock = mock((sessionId, lens) => {});
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'user_alice', email: 'alice@example.com', password: 'password1' },
      { uid: 'user_bob', email: 'bob@example.com', password: 'password2' },
    ]);

    const { getByRole } = render(
      <RemoteClientsPopover
        isOpen={true}
        onClose={() => {}}
        consumers={[sampleConsumers[0]]}
        onSetLens={setLensMock}
        auth={auth}
      />,
    );

    const select = getByRole('combobox');
    fireEvent.change(select, { target: { value: 'user_bob' } });

    expect(setLensMock).toHaveBeenCalledWith('flutter-client-1234567890', {
      mode: 'as',
      uid: 'user_bob',
      token: undefined,
      tenant: undefined,
    });
  });

  it('closes when Escape key is pressed', () => {
    const onCloseMock = mock(() => {});
    render(
      <RemoteClientsPopover
        isOpen={true}
        onClose={onCloseMock}
        consumers={sampleConsumers}
        onSetLens={() => {}}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseMock).toHaveBeenCalled();
  });
});
