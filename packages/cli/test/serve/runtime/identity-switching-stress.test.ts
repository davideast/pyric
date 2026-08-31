import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { AuthLens } from 'pyric/sandbox';
import {
  AUTH_LENS_STORAGE_KEY,
  getLens,
  hydrateLensFromStorage,
  setLens,
  subscribeLens,
} from '../../../src/serve/worker/client/core.js';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'testepoch12345678' },
};

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function polyfillDialog(dom: JSDOM) {
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
}

describe('Empirical Challenger: End-to-End Identity Switching & Zero-Reload Updates', () => {
  let memoryStorage: MemoryStorage;
  const originalSessionStorage = globalThis.sessionStorage;

  beforeEach(() => {
    memoryStorage = new MemoryStorage();
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: memoryStorage,
      writable: true,
      configurable: true,
    });
    setLens(undefined);
  });

  afterEach(() => {
    setLens(undefined);
    if (originalSessionStorage !== undefined) {
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: originalSessionStorage,
        writable: true,
        configurable: true,
      });
    } else {
      // @ts-expect-error cleanup global mock
      delete globalThis.sessionStorage;
    }
  });

  describe('Mission 1: End-to-end full cycle UI state transitions', () => {
    it('verifies seamless zero-reload switching across Impersonated User, Admin Bypass, and App Session', () => {
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      polyfillDialog(dom);

      const runtime = createPyricRuntimeStatus(manifest);
      const chip = mountPyricRuntimeChip({
        runtime,
        document: dom.window.document,
      });
      const root = chip.element.shadowRoot!;

      // 1. Initial State: App Session (default)
      expect(root.querySelector('[data-identity-badge]')).toBeNull();
      expect(getLens()).toBeUndefined();
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();

      // Open expanded panel to access "Impersonate" control
      const expandBtn = root.querySelector<HTMLButtonElement>('[data-expand]')!;
      expandBtn.click();

      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
      const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;
      const tenantInput = dialog.querySelector<HTMLInputElement>('[data-input-tenant]')!;
      const claimsInput = dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!;

      // ── Transition 1: Impersonated User (UID + Tenant + Custom claims) ──
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
      asRadio.click();
      asRadio.checked = true;

      uidInput.value = 'challenger-agent';
      tenantInput.value = 'tenant-acme';
      claimsInput.value = JSON.stringify({ role: 'auditor', level: 9, features: ['all'] });

      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

      // Dialog must close immediately
      expect(dialog.hasAttribute('open')).toBe(false);

      // Verify getLens() and sessionStorage match
      const expectedAsLens: AuthLens = {
        mode: 'as',
        uid: 'challenger-agent',
        tenant: 'tenant-acme',
        token: { role: 'auditor', level: 9, features: ['all'] },
      };
      expect(getLens()).toEqual(expectedAsLens);
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify(expectedAsLens));

      // Collapse panel and check collapsed bar badge
      root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
      const badgeAs = root.querySelector('[data-identity-badge]');
      expect(badgeAs).not.toBeNull();
      expect(badgeAs?.textContent).toBe('as: challenger-agent (tenant-acme)');

      // ── Transition 2: Admin Bypass ──
      root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      // Verify form pre-population from previous impersonated state
      expect(asRadio.checked).toBe(true);
      expect(uidInput.value).toBe('challenger-agent');
      expect(tenantInput.value).toBe('tenant-acme');
      expect(claimsInput.value).toContain('"role": "auditor"');

      // Select Admin Bypass
      const adminRadio = dialog.querySelector<HTMLInputElement>('input[value="admin"]')!;
      adminRadio.click();
      adminRadio.checked = true;

      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));
      expect(dialog.hasAttribute('open')).toBe(false);

      // Verify state
      const expectedAdminLens: AuthLens = { mode: 'admin' };
      expect(getLens()).toEqual(expectedAdminLens);
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify(expectedAdminLens));

      // Collapse and check collapsed badge updates immediately to 'admin'
      root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
      const badgeAdmin = root.querySelector('[data-identity-badge]');
      expect(badgeAdmin).not.toBeNull();
      expect(badgeAdmin?.textContent).toBe('admin');

      // ── Transition 3: Reset to App Session via Reset button ──
      root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      const clearBtn = dialog.querySelector<HTMLButtonElement>('[data-clear-lens]')!;
      clearBtn.click();
      expect(dialog.hasAttribute('open')).toBe(false);

      // Verify reset state
      expect(getLens()).toBeUndefined();
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();

      // Collapse and verify badge is removed
      root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
      expect(root.querySelector('[data-identity-badge]')).toBeNull();

      // ── Transition 4: Impersonated User with UID only (no tenant, no claims) ──
      root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
      impersonateBtn.click();

      asRadio.click();
      asRadio.checked = true;
      uidInput.value = 'solo-alice';
      tenantInput.value = '';
      claimsInput.value = '';

      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));
      expect(dialog.hasAttribute('open')).toBe(false);

      const expectedSoloLens: AuthLens = {
        mode: 'as',
        uid: 'solo-alice',
        tenant: undefined,
        token: undefined,
      };
      expect(getLens()).toEqual(expectedSoloLens);
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify(expectedSoloLens));

      root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
      const badgeSolo = root.querySelector('[data-identity-badge]');
      expect(badgeSolo).not.toBeNull();
      expect(badgeSolo?.textContent).toBe('as: solo-alice');

      // ── Transition 5: App Session via radio select + submit ──
      root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
      impersonateBtn.click();

      const appSessionRadio = dialog.querySelector<HTMLInputElement>('input[value="app-session"]')!;
      appSessionRadio.click();
      appSessionRadio.checked = true;

      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));
      expect(dialog.hasAttribute('open')).toBe(false);

      expect(getLens()).toBeUndefined();
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();

      root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
      expect(root.querySelector('[data-identity-badge]')).toBeNull();

      chip.dispose();
    });
  });

  describe('Mission 2: Persistence across multiple simulated page initializations', () => {
    it('persists impersonation across simulated fresh page loads and reloads', async () => {
      // ── Page Lifecycle 1: Initial Page Load ──
      const initialLens: AuthLens = {
        mode: 'as',
        uid: 'persistent-user',
        tenant: 'tenant-enterprise',
        token: { scope: 'read:write', tier: 'gold' },
      };
      setLens(initialLens);
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify(initialLens));

      // ── Page Lifecycle 2: Simulated Browser Reload #1 ──
      // Dynamic import with query parameter creates a fresh module instance simulating
      // a fresh page load where module-level `hydrateLensFromStorage()` runs at startup.
      const freshCore2 = await import(`../../../src/serve/worker/client/core.js?sim=2-${Date.now()}`);
      expect(freshCore2.getLens()).toEqual(initialLens);

      const dom2 = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      polyfillDialog(dom2);

      const runtime2 = createPyricRuntimeStatus(manifest);
      const chip2 = mountPyricRuntimeChip({
        runtime: runtime2,
        document: dom2.window.document,
        getLens: freshCore2.getLens,
        setLens: freshCore2.setLens,
        subscribeLens: freshCore2.subscribeLens,
      });
      const root2 = chip2.element.shadowRoot!;

      // On initial mount in the new page, the collapsed badge must display immediately
      const badge2 = root2.querySelector('[data-identity-badge]');
      expect(badge2).not.toBeNull();
      expect(badge2?.textContent).toBe('as: persistent-user (tenant-enterprise)');

      // Open dialog on Page 2 and check pre-population
      root2.querySelector<HTMLButtonElement>('[data-expand]')!.click();
      root2.querySelector<HTMLButtonElement>('[data-open-impersonate]')!.click();

      const dialog2 = root2.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      expect(dialog2.querySelector<HTMLInputElement>('input[value="as"]')?.checked).toBe(true);
      expect(dialog2.querySelector<HTMLInputElement>('[data-input-uid]')?.value).toBe('persistent-user');
      expect(dialog2.querySelector<HTMLInputElement>('[data-input-tenant]')?.value).toBe('tenant-enterprise');
      expect(dialog2.querySelector<HTMLTextAreaElement>('[data-input-claims]')?.value).toContain('"tier": "gold"');

      // In Page 2, switch to Admin Bypass
      const adminRadio2 = dialog2.querySelector<HTMLInputElement>('input[value="admin"]')!;
      adminRadio2.click();
      adminRadio2.checked = true;

      const form2 = dialog2.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
      form2.dispatchEvent(new (dom2.window.Event)('submit', { bubbles: true, cancelable: true }));

      expect(freshCore2.getLens()).toEqual({ mode: 'admin' });
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify({ mode: 'admin' }));

      root2.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
      expect(root2.querySelector('[data-identity-badge]')?.textContent).toBe('admin');
      chip2.dispose();

      // ── Page Lifecycle 3: Simulated Browser Reload #2 ──
      const freshCore3 = await import(`../../../src/serve/worker/client/core.js?sim=3-${Date.now()}`);
      expect(freshCore3.getLens()).toEqual({ mode: 'admin' });

      const dom3 = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      polyfillDialog(dom3);

      const runtime3 = createPyricRuntimeStatus(manifest);
      const chip3 = mountPyricRuntimeChip({
        runtime: runtime3,
        document: dom3.window.document,
        getLens: freshCore3.getLens,
        setLens: freshCore3.setLens,
        subscribeLens: freshCore3.subscribeLens,
      });
      const root3 = chip3.element.shadowRoot!;

      // Collapsed badge on Page 3 must mount directly as admin
      expect(root3.querySelector('[data-identity-badge]')?.textContent).toBe('admin');

      // Reset to App Session in Page 3
      root3.querySelector<HTMLButtonElement>('[data-expand]')!.click();
      root3.querySelector<HTMLButtonElement>('[data-open-impersonate]')!.click();
      const dialog3 = root3.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      dialog3.querySelector<HTMLButtonElement>('[data-clear-lens]')!.click();

      expect(freshCore3.getLens()).toBeUndefined();
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();
      chip3.dispose();

      // ── Page Lifecycle 4: Simulated Browser Reload #3 ──
      const freshCore4 = await import(`../../../src/serve/worker/client/core.js?sim=4-${Date.now()}`);
      expect(freshCore4.getLens()).toBeUndefined();

      const dom4 = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      polyfillDialog(dom4);

      const runtime4 = createPyricRuntimeStatus(manifest);
      const chip4 = mountPyricRuntimeChip({
        runtime: runtime4,
        document: dom4.window.document,
        getLens: freshCore4.getLens,
        setLens: freshCore4.setLens,
        subscribeLens: freshCore4.subscribeLens,
      });
      const root4 = chip4.element.shadowRoot!;

      expect(root4.querySelector('[data-identity-badge]')).toBeNull();
      chip4.dispose();
    });
  });

  describe('Adversarial & Boundary Stress Tests', () => {
    it('sanitizes XSS payloads in UID and Tenant to prevent DOM injection', () => {
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      polyfillDialog(dom);

      const runtime = createPyricRuntimeStatus(manifest);
      const chip = mountPyricRuntimeChip({
        runtime,
        document: dom.window.document,
      });
      const root = chip.element.shadowRoot!;

      setLens({
        mode: 'as',
        uid: '<img src=x onerror=alert(1)>',
        tenant: '<script>alert("pwnd")</script>',
      });

      const badge = root.querySelector('[data-identity-badge]');
      expect(badge).not.toBeNull();

      // Ensure no script or img elements were injected into the DOM
      expect(badge?.querySelector('img')).toBeNull();
      expect(badge?.querySelector('script')).toBeNull();
      expect(root.querySelector('img')).toBeNull();
      expect(root.querySelector('script')).toBeNull();

      // Ensure text content is faithfully preserved
      expect(badge?.textContent).toBe('as: <img src=x onerror=alert(1)> (<script>alert("pwnd")</script>)');

      chip.dispose();
    });

    it('handles rapid sequential transitions without state desynchronization', () => {
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      polyfillDialog(dom);

      const runtime = createPyricRuntimeStatus(manifest);
      const chip = mountPyricRuntimeChip({
        runtime,
        document: dom.window.document,
      });
      const root = chip.element.shadowRoot!;

      for (let i = 0; i < 30; i++) {
        const uid = `rapid_user_${i}`;
        const tenant = `tenant_${i % 3}`;
        setLens({ mode: 'as', uid, tenant });

        expect(getLens()).toEqual({ mode: 'as', uid, tenant });
        expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify({ mode: 'as', uid, tenant }));
        expect(root.querySelector('[data-identity-badge]')?.textContent).toBe(`as: ${uid} (${tenant})`);

        setLens({ mode: 'admin' });
        expect(getLens()).toEqual({ mode: 'admin' });
        expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify({ mode: 'admin' }));
        expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('admin');

        setLens(undefined);
        expect(getLens()).toBeUndefined();
        expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();
        expect(root.querySelector('[data-identity-badge]')).toBeNull();
      }

      chip.dispose();
    });

    it('rejects invalid JSON in custom claims, preserves existing state, and recovers on fix', () => {
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      polyfillDialog(dom);

      const runtime = createPyricRuntimeStatus(manifest);
      const chip = mountPyricRuntimeChip({
        runtime,
        document: dom.window.document,
        initiallyOpen: true,
      });
      const root = chip.element.shadowRoot!;

      // Start with initial lens
      setLens({ mode: 'as', uid: 'initial-user', tenant: 'tenant-1' });

      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
      const errorEl = dialog.querySelector<HTMLElement>('[data-dialog-error]')!;
      const claimsInput = dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!;

      impersonateBtn.click();
      expect(dialog.hasAttribute('open')).toBe(true);

      // Attempt to submit broken JSON
      claimsInput.value = '{ malformed: json, without quotes }';
      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

      // Modal must remain open and display error
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(errorEl.style.display).not.toBe('none');
      expect(errorEl.textContent).toContain('Invalid JSON in custom claims');

      // State must remain unmutated
      expect(getLens()).toEqual({ mode: 'as', uid: 'initial-user', tenant: 'tenant-1' });

      // Fix the JSON
      claimsInput.value = '{"fixed": true}';
      form.dispatchEvent(new (dom.window.Event)('submit', { bubbles: true, cancelable: true }));

      // Modal must close and update lens
      expect(dialog.hasAttribute('open')).toBe(false);
      expect(getLens()).toEqual({
        mode: 'as',
        uid: 'initial-user',
        tenant: 'tenant-1',
        token: { fixed: true },
      });

      chip.dispose();
    });

    it('recovers gracefully when sessionStorage contains corrupted or invalid lens payload', () => {
      // 1. Malformed JSON string
      memoryStorage.setItem(AUTH_LENS_STORAGE_KEY, '{ broken json payload');
      expect(hydrateLensFromStorage()).toBeUndefined();
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();

      // 2. JSON with mode: 'app-session'
      memoryStorage.setItem(AUTH_LENS_STORAGE_KEY, JSON.stringify({ mode: 'app-session' }));
      expect(hydrateLensFromStorage()).toBeUndefined();
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();

      // 3. JSON with non-object
      memoryStorage.setItem(AUTH_LENS_STORAGE_KEY, JSON.stringify(12345));
      expect(hydrateLensFromStorage()).toBeUndefined();
      expect(memoryStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();
    });

    it('synchronizes multiple independent chips mounted on the same page', () => {
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      polyfillDialog(dom);

      const runtime1 = createPyricRuntimeStatus(manifest);
      const runtime2 = createPyricRuntimeStatus(manifest);

      const chip1 = mountPyricRuntimeChip({ runtime: runtime1, document: dom.window.document });
      const chip2 = mountPyricRuntimeChip({ runtime: runtime2, document: dom.window.document });

      const root1 = chip1.element.shadowRoot!;
      const root2 = chip2.element.shadowRoot!;

      expect(root1.querySelector('[data-identity-badge]')).toBeNull();
      expect(root2.querySelector('[data-identity-badge]')).toBeNull();

      // Update lens
      setLens({ mode: 'as', uid: 'shared-user', tenant: 'tenant-shared' });

      expect(root1.querySelector('[data-identity-badge]')?.textContent).toBe('as: shared-user (tenant-shared)');
      expect(root2.querySelector('[data-identity-badge]')?.textContent).toBe('as: shared-user (tenant-shared)');

      // Admin bypass
      setLens({ mode: 'admin' });
      expect(root1.querySelector('[data-identity-badge]')?.textContent).toBe('admin');
      expect(root2.querySelector('[data-identity-badge]')?.textContent).toBe('admin');

      // Clear
      setLens(undefined);
      expect(root1.querySelector('[data-identity-badge]')).toBeNull();
      expect(root2.querySelector('[data-identity-badge]')).toBeNull();

      chip1.dispose();
      chip2.dispose();
    });
  });
});
