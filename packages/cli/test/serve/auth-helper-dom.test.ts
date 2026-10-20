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

      const emailInput = dom.window.document.querySelector('dialog[data-pyric-auth] input[type="email"]');
      expect(emailInput).not.toBeNull();

      // 1. Chrome Autofill dispatches a base Event('keydown', { bubbles: true }) where ev.code is undefined.
      emailInput!.dispatchEvent(new dom.window.Event('keydown', { bubbles: true }));
      // 2. Regular keyboard typing inside the dialog.
      emailInput!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));

      expect(leakedEvents).toBe(0);

      // Submitting the form inside the dialog still resolves sign-in normally.
      (emailInput as HTMLInputElement).value = 'dceast@gmail.com';
      const form = dom.window.document.querySelector('dialog[data-pyric-auth] form');
      form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

      const settled = await pending;
      expect(settled.user.email).toBe('dceast@gmail.com');
    } finally {
      globalThis.document = prevDocument;
      dom.window.close();
    }
  });
});
