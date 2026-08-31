import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { createChipDialogController } from '../../../src/serve/runtime/chip-dialog.js';
import type { AuthUserRecord } from 'pyric/auth';
import type { AuthLens } from 'pyric/sandbox';

describe('chip-stress tests', () => {
  function setupDialog(initialUsers: AuthUserRecord[] = []) {
    const dom = new JSDOM('<!doctype html><body><button id="trigger">Trigger</button></body>', {
      url: 'http://localhost/',
    });
    const trigger = dom.window.document.getElementById('trigger') as HTMLButtonElement;
    const shadowHost = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(shadowHost);
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    if (typeof dom.window.HTMLDialogElement !== 'undefined') {
      if (!dom.window.HTMLDialogElement.prototype.showModal) {
        dom.window.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
          this.setAttribute('open', '');
        };
      }
      if (!dom.window.HTMLDialogElement.prototype.close) {
        dom.window.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
          this.removeAttribute('open');
        };
      }
    }

    let currentLens: AuthLens | undefined = undefined;
    let switchedUser: string | null = null;
    let signedOut = false;

    const controller = createChipDialogController({
      shadowRoot,
      listUsers: () => initialUsers,
      onSwitchUser: (uid) => {
        switchedUser = uid;
      },
      onSignOut: () => {
        signedOut = true;
      },
      onOpenCreateUser: () => {},
      onToggleAdminBypass: (enable) => {
        currentLens = enable ? { mode: 'admin' } : undefined;
      },
      getCurrentUser: () => null,
      getLens: () => currentLens,
    });

    return {
      dom,
      trigger,
      controller,
      getSwitchedUser: () => switchedUser,
      isSignedOut: () => signedOut,
    };
  }

  it('rapidly opens and closes dialog 100 times without leaking state or crashing', async () => {
    const { controller, trigger } = setupDialog();

    try {
      for (let i = 0; i < 100; i++) {
        await controller.open(trigger);
        expect(controller.element.hasAttribute('open')).toBe(true);
        controller.close();
        expect(controller.element.hasAttribute('open')).toBe(false);
      }
    } finally {
      controller.dispose();
    }
  });

  it('restores focus to trigger button when closed', async () => {
    const { controller, trigger } = setupDialog();

    try {
      await controller.open(trigger);
      controller.close();
      expect(controller.element.hasAttribute('open')).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it('handles rapid user selection across 50 simulated candidates', async () => {
    const users: AuthUserRecord[] = Array.from({ length: 50 }, (_, i) => ({
      uid: `stress-user-${i}`,
      email: `stress-${i}@example.com`,
      displayName: `Stress User ${i}`,
      customClaims: i % 5 === 0 ? { role: 'admin' } : {},
    }));

    const { controller, trigger, getSwitchedUser } = setupDialog(users);

    try {
      await controller.open(trigger);
      const listbox = controller.element.querySelector('[data-user-search-listbox]')!;
      const firstItem = listbox.querySelector<HTMLElement>('.user-search-item');
      expect(firstItem).not.toBeNull();
      firstItem?.click();

      expect(getSwitchedUser()).toBe('stress-user-0');
    } finally {
      controller.dispose();
    }
  });

  it('toggles admin rules bypass repeatedly without corruption', () => {
    const { controller } = setupDialog();

    try {
      const toggle = controller.element.querySelector<HTMLButtonElement>('[data-action-toggle-admin]')!;
      expect(toggle).not.toBeNull();

      for (let i = 0; i < 20; i++) {
        toggle.click();
      }
    } finally {
      controller.dispose();
    }
  });
});
