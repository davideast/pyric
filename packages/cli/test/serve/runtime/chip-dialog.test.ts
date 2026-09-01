import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  createChipDialogController,
} from '../../../src/serve/runtime/chip-dialog.js';
import type { RuntimeIdentity } from '../../../src/serve/runtime/identity.js';
import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';

describe('chip-dialog', () => {
  let dom: JSDOM;
  let shadowRoot: ShadowRoot;
  let triggerButton: HTMLButtonElement;

  const mockUsers: AuthUserRecord[] = [
    {
      uid: 'user-sam',
      email: 'sam@example.com',
      displayName: 'Sam Hacker',
      providerUserInfo: [{ providerId: 'password' }],
      customClaims: {},
    },
  ];

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { url: 'http://localhost/' });
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.HTMLDialogElement = dom.window.HTMLDialogElement;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.Event = dom.window.Event;

    // Polyfill showModal and close for JSDOM
    if (!dom.window.HTMLDialogElement.prototype.showModal) {
      dom.window.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
        Object.defineProperty(this, 'open', { value: true, writable: true, configurable: true });
      };
    }
    if (!dom.window.HTMLDialogElement.prototype.close) {
      dom.window.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
        this.removeAttribute('open');
        Object.defineProperty(this, 'open', { value: false, writable: true, configurable: true });
      };
    }

    const host = dom.window.document.getElementById('host')!;
    shadowRoot = host.attachShadow({ mode: 'open' });
    triggerButton = dom.window.document.createElement('button');
    triggerButton.setAttribute('data-open-impersonate', '');
    triggerButton.textContent = 'Identity';
    shadowRoot.appendChild(triggerButton);
  });

  it('opens and closes dialog with showModal and close', async () => {
    let currentUser: RuntimeIdentity | null = { uid: 'user-1', email: 'u1@example.com' };
    const controller = createChipDialogController({
      shadowRoot,
      getCurrentUser: () => currentUser,
      getLens: () => undefined,
      onSwitchUser: () => {},
      onSignOut: () => {},
      onOpenCreateUser: () => {},
      onToggleAdminBypass: () => {},
    });

    expect(controller.element.open).toBeFalsy();

    await controller.open(triggerButton);
    expect(controller.element.open).toBe(true);

    controller.close();
    expect(controller.element.open).toBeFalsy();
  });

  it('displays user info and sign-out button when signed in, and hides when guest', async () => {
    let currentUser: RuntimeIdentity | null = { uid: 'user-1', displayName: 'David East' };
    const controller = createChipDialogController({
      shadowRoot,
      getCurrentUser: () => currentUser,
      getLens: () => undefined,
      onSwitchUser: () => {},
      onSignOut: () => {},
      onOpenCreateUser: () => {},
      onToggleAdminBypass: () => {},
    });

    await controller.open(triggerButton);
    const nameEl = controller.element.querySelector('[data-identity-name]')!;
    const signOutBtn = controller.element.querySelector<HTMLButtonElement>('[data-action-signout]')!;

    expect(nameEl.textContent).toBe('David East');
    expect(signOutBtn.style.display).toBe('inline-flex');

    // Switch to null (guest)
    currentUser = null;
    controller.updateState();
    expect(nameEl.textContent).toBe('Unauthenticated Guest');
    expect(signOutBtn.style.display).toBe('none');
  });

  it('clicking sign-out invokes onSignOut and closes dialog', async () => {
    const onSignOut = mock(() => {});
    const controller = createChipDialogController({
      shadowRoot,
      getCurrentUser: () => ({ uid: 'user-1' }),
      getLens: () => undefined,
      onSwitchUser: () => {},
      onSignOut,
      onOpenCreateUser: () => {},
      onToggleAdminBypass: () => {},
    });

    await controller.open(triggerButton);
    const signOutBtn = controller.element.querySelector<HTMLButtonElement>('[data-action-signout]')!;
    signOutBtn.click();
    await Promise.resolve();

    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(controller.element.open).toBeFalsy();
  });

  it('selecting a user from the search combobox invokes onSwitchUser and closes dialog', async () => {
    const onSwitchUser = mock((_uid: string) => {});
    const controller = createChipDialogController({
      shadowRoot,
      listUsers: () => mockUsers,
      getCurrentUser: () => null,
      getLens: () => undefined,
      onSwitchUser,
      onSignOut: () => {},
      onOpenCreateUser: () => {},
      onToggleAdminBypass: () => {},
    });

    await controller.open(triggerButton);
    const input = controller.element.querySelector<HTMLInputElement>('[data-user-search-input]')!;
    input.focus();

    const item = controller.element.querySelector<HTMLElement>('.user-search-item')!;
    expect(item).toBeDefined();
    item.click();
    await Promise.resolve();

    expect(onSwitchUser).toHaveBeenCalledWith('user-sam');
    expect(controller.element.open).toBeFalsy();
  });

  it('clicking create new user closes dialog and invokes onOpenCreateUser', async () => {
    const onOpenCreateUser = mock(() => {});
    const controller = createChipDialogController({
      shadowRoot,
      getCurrentUser: () => null,
      getLens: () => undefined,
      onSwitchUser: () => {},
      onSignOut: () => {},
      onOpenCreateUser,
      onToggleAdminBypass: () => {},
    });

    await controller.open(triggerButton);
    const createBtn = controller.element.querySelector<HTMLButtonElement>('[data-action-create-user]')!;
    createBtn.click();

    expect(onOpenCreateUser).toHaveBeenCalledTimes(1);
    expect(controller.element.open).toBeFalsy();
  });

  it('toggling rules bypass invokes onToggleAdminBypass', async () => {
    let currentLens: AuthLens | undefined = undefined;
    const onToggleAdminBypass = mock((enable: boolean) => {
      currentLens = enable ? { mode: 'admin' } : undefined;
    });

    const controller = createChipDialogController({
      shadowRoot,
      getCurrentUser: () => null,
      getLens: () => currentLens,
      onSwitchUser: () => {},
      onSignOut: () => {},
      onOpenCreateUser: () => {},
      onToggleAdminBypass,
    });

    await controller.open(triggerButton);
    const toggleBtn = controller.element.querySelector<HTMLButtonElement>('[data-action-toggle-admin]')!;
    toggleBtn.click();

    expect(onToggleAdminBypass).toHaveBeenCalledWith(true);
  });

  it('safely restores focus to trigger button upon close without failing if trigger is detached', async () => {
    const controller = createChipDialogController({
      shadowRoot,
      getCurrentUser: () => null,
      getLens: () => undefined,
      onSwitchUser: () => {},
      onSignOut: () => {},
      onOpenCreateUser: () => {},
      onToggleAdminBypass: () => {},
    });

    await controller.open(triggerButton);

    // Simulate chip re-render: detach old trigger button and create a new one with same selector
    triggerButton.remove();
    const newTrigger = dom.window.document.createElement('button');
    newTrigger.setAttribute('data-open-impersonate', '');
    shadowRoot.appendChild(newTrigger);

    let focused = false;
    newTrigger.focus = () => {
      focused = true;
    };

    controller.close();
    expect(focused).toBe(true);
  });

  it('supports repeated open and close cycles without stale dialog state', async () => {
    const controller = createChipDialogController({
      shadowRoot,
      getCurrentUser: () => null,
      getLens: () => undefined,
      onSwitchUser: () => {},
      onSignOut: () => {},
      onOpenCreateUser: () => {},
      onToggleAdminBypass: () => {},
    });

    for (let index = 0; index < 100; index += 1) {
      await controller.open(triggerButton);
      expect(controller.element.hasAttribute('open')).toBe(true);
      controller.close();
      expect(controller.element.hasAttribute('open')).toBe(false);
    }
  });

  it('selects from a large sandbox user directory', async () => {
    const users: AuthUserRecord[] = Array.from({ length: 50 }, (_, index) => ({
      uid: `stress-user-${index}`,
      email: `stress-${index}@example.com`,
      displayName: `Stress User ${index}`,
      customClaims: index % 5 === 0 ? { role: 'admin' } : {},
    }));
    const onSwitchUser = mock((_uid: string) => {});
    const controller = createChipDialogController({
      shadowRoot,
      listUsers: () => users,
      getCurrentUser: () => null,
      getLens: () => undefined,
      onSwitchUser,
      onSignOut: () => {},
      onOpenCreateUser: () => {},
      onToggleAdminBypass: () => {},
    });

    await controller.open(triggerButton);
    controller.element.querySelector<HTMLElement>('.user-search-item')?.click();
    await Promise.resolve();

    expect(onSwitchUser).toHaveBeenCalledWith('stress-user-0');
  });

  it('handles repeated rules-bypass toggles', () => {
    const onToggleAdminBypass = mock((_enable: boolean) => {});
    const controller = createChipDialogController({
      shadowRoot,
      getCurrentUser: () => null,
      getLens: () => undefined,
      onSwitchUser: () => {},
      onSignOut: () => {},
      onOpenCreateUser: () => {},
      onToggleAdminBypass,
    });
    const toggle = controller.element.querySelector<HTMLButtonElement>('[data-action-toggle-admin]')!;

    for (let index = 0; index < 20; index += 1) toggle.click();

    expect(onToggleAdminBypass).toHaveBeenCalledTimes(20);
  });
});
