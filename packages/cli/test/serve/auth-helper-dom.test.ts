import { describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import { ServeAuthHelper } from '../../src/serve/entries/auth-helper-core.js';
import { mountAuthHelperDialog } from '../../src/serve/entries/auth-helper-dom.js';

describe('mountAuthHelperDialog keyboard & autofill event isolation', () => {
  it('stops synthetic browser autofill keydown events and keypresses from leaking to host window listeners', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const prevDocument = globalThis.document;
    globalThis.document = dom.window.document as unknown as Document;

    // Polyfill HTMLDialogElement modal methods absent in JSDOM.
    const DialogProto = dom.window.HTMLElement.prototype as unknown as {
      open?: boolean;
      showModal?: () => void;
      close?: () => void;
    };
    DialogProto.showModal = function showModal(this: { open?: boolean }) {
      this.open = true;
    };
    DialogProto.close = function close(this: { open?: boolean }) {
      this.open = false;
    };

    try {
      let leakedEvents = 0;
      dom.window.addEventListener('keydown', (ev) => {
        leakedEvents += 1;
        // Exact host app pattern from spaces CommandProvider.tsx:287 (`ev.code.replace(...)`).
        void (ev as KeyboardEvent).code.replace(/^Key/, '');
      });

      const helper = new ServeAuthHelper({
        list: () => [],
      });

      mountAuthHelperDialog(helper);
      const pending = helper.resolver().openPopup({
        providerId: 'google.com',
        provider: { providerId: 'google.com' } as never,
        auth: {} as never,
      });
      await new Promise((r) => setTimeout(r, 10));

      const emailInput = dom.window.document.querySelector<HTMLInputElement>(
        'dialog[data-pyric-auth] input[type="email"]',
      );
      if (emailInput === null) throw new Error('expected email input');

      // 1. Chrome Autofill dispatches a base Event('keydown', { bubbles: true }) where ev.code is undefined.
      emailInput.dispatchEvent(new dom.window.Event('keydown', { bubbles: true }));
      // 2. Regular keyboard typing inside the dialog.
      emailInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));

      expect(leakedEvents).toBe(0);

      // Submitting the form inside the dialog still resolves sign-in normally.
      emailInput.value = 'dceast@gmail.com';
      const form = dom.window.document.querySelector('dialog[data-pyric-auth] form');
      if (form === null) throw new Error('expected auth dialog form');
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

      const settled = await pending;
      expect(settled.user.email).toBe('dceast@gmail.com');
    } finally {
      globalThis.document = prevDocument;
      dom.window.close();
    }
  });
});

type ListedIdentity = {
  uid: string;
  email: string | null;
  displayName: string | null;
  isAnonymous?: boolean;
  providerUserInfo?: Array<{ providerId: string }>;
  customClaims: Record<string, unknown>;
};

describe('mountAuthHelperDialog keeps the form across emits', () => {
  it('keeps the typed email, its input node and focus when the identities list arrives', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const prevDocument = globalThis.document;
    globalThis.document = dom.window.document as unknown as Document;
    const DialogProto = dom.window.HTMLElement.prototype as unknown as {
      open?: boolean;
      showModal?: () => void;
      close?: () => void;
    };
    DialogProto.showModal = function showModal(this: { open?: boolean }) {
      this.open = true;
    };
    DialogProto.close = function close(this: { open?: boolean }) {
      this.open = false;
    };

    try {
      // A SharedWorker directory answers asynchronously: the constructor's
      // read settles at once, the read `open()` starts settles later.
      let releaseList: (identities: ListedIdentity[]) => void = () => {};
      let reads = 0;
      const helper = new ServeAuthHelper({
        list: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve([]);
          return new Promise<ListedIdentity[]>((resolve) => {
            releaseList = resolve;
          });
        },
      });
      await new Promise((r) => setTimeout(r, 0));

      mountAuthHelperDialog(helper);
      const pending = helper.resolver().openPopup({
        providerId: 'google.com',
        provider: { providerId: 'google.com' } as never,
        auth: {} as never,
      });

      const doc = dom.window.document;
      const email = doc.querySelector<HTMLInputElement>('dialog[data-pyric-auth] input[type="email"]');
      if (email === null) throw new Error('expected email input');
      email.focus();
      email.value = 'erin@example.com';
      expect(doc.activeElement).toBe(email);

      releaseList([
        { uid: 'anonymous-a1', email: null, displayName: null, isAnonymous: true, customClaims: {} },
        { uid: 'anonymous-a2', email: null, displayName: null, isAnonymous: true, customClaims: {} },
        { uid: 'u1', email: 'ada@example.com', displayName: 'Ada', isAnonymous: false, customClaims: {} },
      ]);
      await new Promise((r) => setTimeout(r, 0));

      const buttons = doc.querySelectorAll('dialog[data-pyric-auth] .ids button');
      expect(buttons.length).toBe(1);
      expect(buttons[0]?.textContent).toBe('Ada (ada@example.com)');
      const after = doc.querySelector<HTMLInputElement>('dialog[data-pyric-auth] input[type="email"]');
      expect(after).toBe(email);
      expect(after?.value).toBe('erin@example.com');
      expect(doc.activeElement).toBe(email);

      helper.cancel();
      await pending.catch((error: unknown) => { void error; });
    } finally {
      globalThis.document = prevDocument;
      dom.window.close();
    }
  });

  it('preserves button.submit and resolves linkWithPopup when async listUsers settles between fill and click (#1578)', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const prevDocument = globalThis.document;
    globalThis.document = dom.window.document as unknown as Document;
    const DialogProto = dom.window.HTMLElement.prototype as unknown as {
      open?: boolean;
      showModal?: () => void;
      close?: () => void;
    };
    DialogProto.showModal = function showModal(this: { open?: boolean }) {
      this.open = true;
    };
    DialogProto.close = function close(this: { open?: boolean }) {
      this.open = false;
    };

    try {
      let releaseOpenList: (identities: ListedIdentity[]) => void = () => {};
      let reads = 0;
      const helper = new ServeAuthHelper({
        list: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve([]);
          return new Promise<ListedIdentity[]>((resolve) => {
            releaseOpenList = resolve;
          });
        },
      });
      await new Promise((r) => setTimeout(r, 0));

      mountAuthHelperDialog(helper);
      const pending = helper.resolver().openPopup({
        providerId: 'google.com',
        authType: 'link',
      });

      const doc = dom.window.document;
      const dialog = doc.querySelector<HTMLDialogElement>('dialog[data-pyric-auth]');
      const email = doc.querySelector<HTMLInputElement>('dialog[data-pyric-auth] input[type="email"]');
      const submitBefore = doc.querySelector<HTMLButtonElement>('dialog[data-pyric-auth] button.submit');
      if (dialog === null || email === null || submitBefore === null) {
        throw new Error('expected open auth dialog elements');
      }

      email.value = 'provider@example.com';

      // SharedWorker `listUsers(workerAuth)` resolves right before `submit.click()`.
      releaseOpenList([
        { uid: 'anonymous-orig', email: null, displayName: null, isAnonymous: true, customClaims: {} },
      ]);
      await new Promise((r) => setTimeout(r, 0));

      const submitAfter = doc.querySelector<HTMLButtonElement>('dialog[data-pyric-auth] button.submit');
      expect(submitAfter).toBe(submitBefore);
      expect(submitBefore.isConnected).toBe(true);

      submitBefore.click();
      const credential = await pending;
      expect(credential.user.email).toBe('provider@example.com');
      expect(credential.providerId).toBe('google.com');
      expect(dialog.open).toBe(false);
    } finally {
      globalThis.document = prevDocument;
      dom.window.close();
    }
  });
});
