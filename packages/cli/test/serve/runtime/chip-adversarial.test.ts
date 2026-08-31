import { JSDOM } from 'jsdom';
import { describe, expect, it, mock } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import {
  AUTH_LENS_STORAGE_KEY,
  getLens,
  hydrateLensFromStorage,
  setLens,
  subscribeLens,
} from '../../../src/serve/worker/client/core.js';
import type { AuthLens } from 'pyric/sandbox';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'test-epoch' },
};

function setupChipWithDom(initialLens?: AuthLens) {
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

  setLens(initialLens);

  const runtime = createPyricRuntimeStatus(manifest);
  const chip = mountPyricRuntimeChip({
    runtime,
    document: dom.window.document,
    getLens,
    setLens,
    subscribeLens,
  });

  const root = chip.element.shadowRoot!;
  return { dom, runtime, chip, root };
}

describe('Adversarial Stress Suite: Transport Reactivity & Chip Zero-Reload Integration', () => {
  it('prevents HTML injection / XSS in active identity badge', () => {
    const { root, chip } = setupChipWithDom();

    const maliciousLens: AuthLens = {
      mode: 'as',
      uid: '<script>alert("pwned")</script>',
      tenant: '"><img src=x onerror=alert(1)>',
    };

    setLens(maliciousLens);

    const badge = root.querySelector('[data-identity-badge]');
    // Inner HTML should have escaped HTML entities, neutralizing tags
    expect(badge?.innerHTML).not.toContain('<script>');
    expect(badge?.innerHTML).not.toContain('<img');
    expect(badge?.innerHTML).toContain('&lt;script&gt;');
    expect(badge?.innerHTML).toContain('&lt;img');
    // textContent should match verbatim string
    expect(badge?.textContent).toBe('as: <script>alert("pwned")</script> ("><img src=x onerror=alert(1)>)');

    chip.dispose();
  });

  it('handles rapid high-frequency lens mutations without race conditions or memory leaks', () => {
    const { root, chip } = setupChipWithDom();

    for (let i = 0; i < 100; i++) {
      const mode = i % 3 === 0 ? 'app-session' : i % 3 === 1 ? 'admin' : 'as';
      if (mode === 'app-session') {
        setLens(undefined);
        expect(root.querySelector('[data-identity-badge]')).toBeNull();
      } else if (mode === 'admin') {
        setLens({ mode: 'admin' });
        expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('admin');
      } else {
        setLens({ mode: 'as', uid: `user_${i}`, tenant: `tenant_${i}` });
        expect(root.querySelector('[data-identity-badge]')?.textContent).toBe(`as: user_${i} (tenant_${i})`);
      }
    }

    chip.dispose();
  });

  it('unsubscribes cleanly on dispose and does not leak callbacks or re-render disposed elements', () => {
    const { root, chip } = setupChipWithDom({ mode: 'as', uid: 'initial' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('as: initial');

    chip.dispose();

    // Mutating lens after dispose should not update the disposed DOM
    setLens({ mode: 'as', uid: 'after_dispose' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('as: initial');
  });

  it('handles deeply nested custom claims JSON in impersonation dialog', () => {
    const { root, chip } = setupChipWithDom();

    // Expand panel and click impersonate
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!.click();

    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
    const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
    asRadio.click();
    asRadio.checked = true;

    dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'complex_user';
    dialog.querySelector<HTMLInputElement>('[data-input-tenant]')!.value = 'tenant-xyz';

    const deepClaims = {
      role: 'admin',
      org: {
        id: 'org-99',
        features: ['sso', 'mfa', 'audit'],
        limits: { maxUsers: 1000, active: true },
      },
    };
    dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!.value = JSON.stringify(deepClaims);

    form.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('submit', { bubbles: true, cancelable: true }));

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(getLens()).toEqual({
      mode: 'as',
      uid: 'complex_user',
      tenant: 'tenant-xyz',
      token: deepClaims,
    });

    // Verify collapsed badge
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('as: complex_user (tenant-xyz)');

    chip.dispose();
  });

  it('gracefully recovers when custom claims JSON is malformed and then corrected', () => {
    const { root, chip } = setupChipWithDom();

    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!.click();

    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
    const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
    asRadio.click();
    asRadio.checked = true;

    dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'err_user';
    const claimsInput = dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!;
    const errorEl = dialog.querySelector<HTMLElement>('[data-dialog-error]')!;

    // 1st attempt: malformed JSON
    claimsInput.value = '{"unclosed: string';
    form.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('submit', { bubbles: true, cancelable: true }));

    expect(dialog.hasAttribute('open')).toBe(true);
    expect(errorEl.style.display).not.toBe('none');
    expect(errorEl.textContent).toContain('Invalid JSON in custom claims');
    expect(getLens()).toBeUndefined();

    // 2nd attempt: corrected JSON
    claimsInput.value = '{"fixed": true}';
    form.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('submit', { bubbles: true, cancelable: true }));

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(getLens()).toEqual({
      mode: 'as',
      uid: 'err_user',
      tenant: undefined,
      token: { fixed: true },
    });

    chip.dispose();
  });

  it('supports multiple concurrent runtime chips listening to the same transport stream', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    const runtime = createPyricRuntimeStatus(manifest);

    const chip1 = mountPyricRuntimeChip({ runtime, document: dom.window.document, getLens, setLens, subscribeLens });
    const chip2 = mountPyricRuntimeChip({ runtime, document: dom.window.document, getLens, setLens, subscribeLens });

    const root1 = chip1.element.shadowRoot!;
    const root2 = chip2.element.shadowRoot!;

    setLens({ mode: 'as', uid: 'shared_user', tenant: 'tenant_shared' });

    expect(root1.querySelector('[data-identity-badge]')?.textContent).toBe('as: shared_user (tenant_shared)');
    expect(root2.querySelector('[data-identity-badge]')?.textContent).toBe('as: shared_user (tenant_shared)');

    setLens(undefined);
    expect(root1.querySelector('[data-identity-badge]')).toBeNull();
    expect(root2.querySelector('[data-identity-badge]')).toBeNull();

    chip1.dispose();
    chip2.dispose();
  });
});
