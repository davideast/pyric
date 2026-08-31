import { JSDOM } from 'jsdom';
import { describe, expect, it, mock } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { AuthLens } from 'pyric/sandbox';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

function setupHarness(options: {
  initiallyOpen?: boolean;
  initialLens?: AuthLens | undefined;
  setLens?: (lens: AuthLens | undefined) => void;
  subscribeLens?: (listener: (lens: AuthLens | undefined) => void) => () => void;
} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
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

  let currentLens = options.initialLens;
  const listeners = new Set<(lens: AuthLens | undefined) => void>();
  const setLensMock = mock((lens: AuthLens | undefined) => {
    currentLens = lens;
    for (const l of listeners) l(lens);
  });
  const subscribeLensMock = mock((listener: (lens: AuthLens | undefined) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });

  const runtime = createPyricRuntimeStatus(manifest);
  const writeText = mock(() => Promise.resolve());
  const clipboard = { writeText };
  const chip = mountPyricRuntimeChip({
    runtime,
    document: dom.window.document,
    getLens: () => currentLens,
    setLens: options.setLens ?? setLensMock,
    subscribeLens: options.subscribeLens ?? subscribeLensMock,
    clipboard,
    initiallyOpen: options.initiallyOpen ?? true,
    studioUrl: manifest.studioUrl,
  });
  const root = chip.element.shadowRoot!;
  return {
    dom,
    runtime,
    chip,
    root,
    writeText,
    setLensMock,
    subscribeLensMock,
    get currentLens() {
      return currentLens;
    },
    setCurrentLens(lens: AuthLens | undefined) {
      currentLens = lens;
      for (const l of listeners) l(lens);
    },
    dispatchKey(target: EventTarget, key: string, shiftKey = false) {
      const event = new (dom.window.KeyboardEvent)('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event;
    },
  };
}

describe('Empirical Adversarial Stress Suite: Shadow DOM Dialog & A11y', () => {
  describe('Area 1: Dialog Focus Trapping', () => {
    it('exhaustively cycles forward and backward across all focusable elements without escape', () => {
      const { root, dispatchKey } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;

      impersonateBtn.focus();
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );

      // Verify all interactive elements exist (including search combobox controls)
      expect(focusables.length).toBe(12);
      const closeBtn = focusables[0];
      const submitBtn = focusables[focusables.length - 1];

      // On open, close button should have focus
      expect(root.activeElement).toBe(closeBtn);

      // Forward Tab cycling from last to first
      submitBtn.focus();
      expect(root.activeElement).toBe(submitBtn);
      const tabWrap = dispatchKey(dialog, 'Tab', false);
      expect(tabWrap.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(closeBtn);

      // Backward Shift+Tab cycling from first to last
      closeBtn.focus();
      expect(root.activeElement).toBe(closeBtn);
      const shiftTabWrap = dispatchKey(dialog, 'Tab', true);
      expect(shiftTabWrap.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(submitBtn);

      // Stress: 50 cycles of Tab / Shift+Tab cycling
      for (let i = 0; i < 50; i++) {
        submitBtn.focus();
        dispatchKey(dialog, 'Tab', false);
        expect(root.activeElement).toBe(closeBtn);

        closeBtn.focus();
        dispatchKey(dialog, 'Tab', true);
        expect(root.activeElement).toBe(submitBtn);
      }
    });

    it('intercepts Tab when focus somehow leaks outside dialog while open and re-traps it', () => {
      const { root, dispatchKey } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;

      impersonateBtn.click();

      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      // Artificially move focus outside dialog to collapse button in panel
      const collapseBtn = root.querySelector<HTMLButtonElement>('[data-collapse]')!;
      collapseBtn.focus();
      expect(root.activeElement).toBe(collapseBtn);
      expect(dialog.contains(root.activeElement)).toBe(false);

      // Pressing Tab should detect !dialog.contains(current) and re-trap to first
      const tabEvent = dispatchKey(dialog, 'Tab', false);
      expect(tabEvent.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(first);

      // Move focus outside again and press Shift+Tab -> should re-trap to last
      collapseBtn.focus();
      const shiftTabEvent = dispatchKey(dialog, 'Tab', true);
      expect(shiftTabEvent.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(last);
    });

    it('ignores non-Tab keydowns (Arrow keys, Space, Enter) without hijacking them', () => {
      const { root, dispatchKey } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;

      impersonateBtn.click();
      const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;
      uidInput.focus();

      const arrowDown = dispatchKey(dialog, 'ArrowDown');
      expect(arrowDown.defaultPrevented).toBe(false);

      const space = dispatchKey(dialog, ' ');
      expect(space.defaultPrevented).toBe(false);

      const enter = dispatchKey(dialog, 'Enter');
      expect(enter.defaultPrevented).toBe(false);
    });
  });

  describe('Area 2: Focus Restoration', () => {
    it('restores focus to trigger button when closed via close button', () => {
      const { root } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const closeBtn = dialog.querySelector<HTMLButtonElement>('[data-close-impersonate]')!;

      impersonateBtn.focus();
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      closeBtn.click();
      expect(dialog.hasAttribute('open')).toBe(false);
      expect(root.activeElement).toBe(impersonateBtn);
    });

    it('restores focus to trigger button when closed via Escape key', () => {
      const { root, dispatchKey } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;

      impersonateBtn.focus();
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      const escEvent = dispatchKey(dialog, 'Escape');
      expect(escEvent.defaultPrevented).toBe(true);
      expect(dialog.hasAttribute('open')).toBe(false);
      expect(root.activeElement).toBe(impersonateBtn);
    });

    it('restores focus to trigger button when closed via backdrop click', () => {
      const { root, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;

      impersonateBtn.focus();
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      const clickEvent = new (dom.window.MouseEvent)('click', { bubbles: true, cancelable: true });
      Object.defineProperty(clickEvent, 'target', { value: dialog });
      dialog.dispatchEvent(clickEvent);

      expect(dialog.hasAttribute('open')).toBe(false);
      expect(root.activeElement).toBe(impersonateBtn);
    });

    it('focus restoration behavior when background runtime error occurs while dialog is open', () => {
      const { root, runtime } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const closeBtn = dialog.querySelector<HTMLButtonElement>('[data-close-impersonate]')!;

      impersonateBtn.focus();
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      // Background event triggers re-render of view while dialog is open!
      runtime.reportError('async error during open modal', 'firestore');

      // Now close dialog
      closeBtn.click();
      expect(dialog.hasAttribute('open')).toBe(false);

      // Check whether root.activeElement is connected to document/shadowRoot
      const currentActive = root.activeElement;
      const currentImpersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]');
      
      // Document empirical finding:
      // When background render happens while dialog is open, triggerElement holds the detached button reference.
      // Calling .focus() on the detached triggerElement leaves focus stranded on the dialog's close button!
      expect(currentActive).toBe(closeBtn);
      expect(currentActive).not.toBe(currentImpersonateBtn);
    });

    it('focus restoration behavior after form submission and reset to app session', () => {
      const { root, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
      const submitBtn = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;

      impersonateBtn.focus();
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
      asRadio.click();
      asRadio.checked = true;
      dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'alice';

      // Submit form
      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));
      expect(dialog.hasAttribute('open')).toBe(false);

      const currentActive = root.activeElement;
      const currentImpersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]');

      console.log('Post-submit activeElement:', {
        tag: currentActive?.tagName,
        classes: currentActive?.className,
        isImpersonateBtn: currentActive === currentImpersonateBtn,
      });

      // Does focus get restored to the connected Impersonate button?
      // When setLens was called, render() rebuilt view.innerHTML, detaching triggerElement.
      // Thus closeDialog()'s triggerElement.focus() was called on a detached node.
      expect(currentActive).not.toBe(currentImpersonateBtn);
    });
  });

  describe('Area 3: Malformed JSON in Custom Claims', () => {
    const malformedInputs = [
      { name: 'syntax error (unclosed object)', value: '{ not valid json }' },
      { name: 'syntax error (unquoted key)', value: '{ foo: "bar" }' },
      { name: 'syntax error (single quotes)', value: "{ 'role': 'admin' }" },
      { name: 'syntax error (trailing comma)', value: '{ "role": "admin", }' },
      { name: 'syntax error (bare word)', value: 'undefined' },
      { name: 'syntax error (incomplete JSON)', value: '{"foo":' },
    ];

    for (const { name, value } of malformedInputs) {
      it(`handles ${name} by displaying error, blocking setLens, and not crashing`, () => {
        const { root, setLensMock, dom } = setupHarness();
        const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
        const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
        const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
        const errorEl = dialog.querySelector<HTMLElement>('[data-dialog-error]')!;

        impersonateBtn.click();
        const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
        asRadio.click();
        asRadio.checked = true;

        dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'alice';
        const claimsInput = dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!;
        claimsInput.value = value;

        form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

        // Dialog must remain open
        expect(dialog.hasAttribute('open')).toBe(true);
        // setLens must NOT be called
        expect(setLensMock).not.toHaveBeenCalled();
        // Error message must be visible
        expect(errorEl.style.display).not.toBe('none');
        expect(errorEl.textContent).toContain('Invalid JSON in custom claims');
      });
    }

    it('clears the error message when reopening dialog', () => {
      const { root, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
      const errorEl = dialog.querySelector<HTMLElement>('[data-dialog-error]')!;
      const closeBtn = dialog.querySelector<HTMLButtonElement>('[data-close-impersonate]')!;

      impersonateBtn.click();
      const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
      asRadio.click();
      asRadio.checked = true;

      dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'alice';
      dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!.value = 'bad json';
      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

      expect(errorEl.style.display).not.toBe('none');

      // Close and reopen
      closeBtn.click();
      expect(dialog.hasAttribute('open')).toBe(false);

      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(errorEl.style.display).toBe('none');
      expect(errorEl.textContent).toBe('');
    });

    it('accepts valid JSON claims with surrounding whitespace', () => {
      const { root, setLensMock, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;

      impersonateBtn.click();
      const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
      asRadio.click();
      asRadio.checked = true;

      dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'bob';
      dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!.value = '   {"tier": "gold", "level": 3}   \n';

      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

      expect(dialog.hasAttribute('open')).toBe(false);
      expect(setLensMock).toHaveBeenCalledWith({
        mode: 'as',
        uid: 'bob',
        tenant: undefined,
        token: { tier: 'gold', level: 3 },
      });
    });

    it('treats whitespace-only claims input as undefined token rather than error', () => {
      const { root, setLensMock, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;

      impersonateBtn.click();
      const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
      asRadio.click();
      asRadio.checked = true;

      dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'carol';
      dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!.value = '    \n  \t ';

      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

      expect(dialog.hasAttribute('open')).toBe(false);
      expect(setLensMock).toHaveBeenCalledWith({
        mode: 'as',
        uid: 'carol',
        tenant: undefined,
        token: undefined,
      });
    });

    it('adversarially probes valid JSON primitives (e.g. number, boolean, array)', () => {
      const { root, setLensMock, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;

      impersonateBtn.click();
      const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
      asRadio.click();
      asRadio.checked = true;

      dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'dave';
      dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!.value = '12345';

      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

      // Document empirical behavior: JSON.parse("12345") is valid JSON syntax
      // Does setLens get called with token: 12345 or blocked?
      // Notice: token is Record<string, unknown> by type
      if (setLensMock.mock.calls.length > 0) {
        expect(setLensMock).toHaveBeenCalledWith({
          mode: 'as',
          uid: 'dave',
          tenant: undefined,
          token: 12345 as any,
        });
      }
    });

    it('adversarially probes submission with empty UID in as mode', () => {
      const { root, setLensMock, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;

      impersonateBtn.click();
      const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
      asRadio.click();
      asRadio.checked = true;

      // Leave UID input empty
      dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = '   ';

      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

      // Observed behavior: setLens is called with uid: "" because empty UID is not blocked by chip.ts
      expect(setLensMock).toHaveBeenCalledWith({
        mode: 'as',
        uid: '',
        tenant: undefined,
        token: undefined,
      });
    });
  });

  describe('Area 4: Rapid State Churning', () => {
    it('rapidly opens and closes dialog 100 times without leaking state or crashing', () => {
      const { root } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const closeBtn = dialog.querySelector<HTMLButtonElement>('[data-close-impersonate]')!;

      for (let i = 0; i < 100; i++) {
        impersonateBtn.click();
        expect(dialog.hasAttribute('open')).toBe(true);
        closeBtn.click();
        expect(dialog.hasAttribute('open')).toBe(false);
      }
      expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('rapidly alternates between form submission modes 50 times', () => {
      const { root, setLensMock, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
      const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;

      const modes = ['app-session', 'admin', 'as'];

      for (let i = 0; i < 50; i++) {
        impersonateBtn.click();
        expect(dialog.hasAttribute('open')).toBe(true);

        const targetMode = modes[i % 3];
        for (const radio of dialog.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
          radio.checked = radio.value === targetMode;
        }

        if (targetMode === 'as') {
          uidInput.value = `user_${i}`;
        }

        form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));
        expect(dialog.hasAttribute('open')).toBe(false);
      }

      expect(setLensMock).toHaveBeenCalledTimes(50);
    });

    it('rapidly clears lens and re-applies identity in tight sequence', () => {
      const { root, setLensMock, dom } = setupHarness({
        initialLens: { mode: 'as', uid: 'initial' },
      });
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const clearBtn = dialog.querySelector<HTMLButtonElement>('[data-clear-lens]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
      const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;

      for (let i = 0; i < 30; i++) {
        // Open and Clear
        impersonateBtn.click();
        clearBtn.click();
        expect(dialog.hasAttribute('open')).toBe(false);

        // Open and Set
        impersonateBtn.click();
        for (const radio of dialog.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
          radio.checked = radio.value === 'as';
        }
        uidInput.value = `rapid_${i}`;
        form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));
        expect(dialog.hasAttribute('open')).toBe(false);
      }

      // Total operations: 30 clears + 30 sets = 60
      expect(setLensMock).toHaveBeenCalledTimes(60);
    });

    it('gracefully handles chip disposal while dialog is open', () => {
      const { chip, root, dom } = setupHarness();
      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;

      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      expect(() => {
        chip.dispose();
      }).not.toThrow();

      expect(dom.window.document.querySelector('[data-pyric-runtime-chip-host]')).toBeNull();
    });
  });
});
