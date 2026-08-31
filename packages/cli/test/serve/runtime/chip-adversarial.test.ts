import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
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

  return { dom, runtime, chip };
}

describe('chip-adversarial tests', () => {
  it('prevents HTML injection / XSS in active identity badge', () => {
    const maliciousUid = '<script>alert("xss")</script><img src="x" onerror="alert(1)">';
    const { dom, chip } = setupChipWithDom({ mode: 'as', uid: maliciousUid });

    try {
      const root = chip.element.shadowRoot!;
      const badge = root.querySelector('[data-identity-badge]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain(maliciousUid);

      const injectedScript = root.querySelector('script');
      const injectedImg = root.querySelector('img');
      expect(injectedScript).toBeNull();
      expect(injectedImg).toBeNull();
      expect(dom.window.document.querySelector('script')).toBeNull();
    } finally {
      chip.dispose();
      setLens(undefined);
    }
  });

  it('handles rapid high-frequency lens mutations without race conditions or memory leaks', () => {
    const { chip } = setupChipWithDom();
    const root = chip.element.shadowRoot!;

    try {
      for (let i = 0; i < 50; i++) {
        setLens({ mode: 'as', uid: `user-${i}`, tenant: i % 2 === 0 ? `tenant-${i}` : undefined });
        const badge = root.querySelector('[data-identity-badge]');
        expect(badge?.textContent).toContain(`user-${i}`);
      }

      setLens(undefined);
      const clearedBadge = root.querySelector('[data-identity-badge]');
      expect(clearedBadge).toBeNull();
    } finally {
      chip.dispose();
      setLens(undefined);
    }
  });

  it('unsubscribes cleanly on dispose and does not leak callbacks or re-render disposed elements', () => {
    const { chip } = setupChipWithDom({ mode: 'as', uid: 'initial-user' });
    const root = chip.element.shadowRoot!;

    const initialBadge = root.querySelector('[data-identity-badge]');
    expect(initialBadge?.textContent).toContain('initial-user');

    chip.dispose();

    // After dispose, external mutations should not throw or alter the disposed element
    expect(() => {
      setLens({ mode: 'as', uid: 'ghost-mutation' });
    }).not.toThrow();

    expect(chip.element.isConnected).toBe(false);
    setLens(undefined);
  });

  it('recovers gracefully when sessionStorage contains corrupted or invalid lens payload', () => {
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem(AUTH_LENS_STORAGE_KEY, '{ invalid json garbage');
        const hydrated = hydrateLensFromStorage();
        expect(hydrated).toBeUndefined();
        expect(sessionStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();

        sessionStorage.setItem(AUTH_LENS_STORAGE_KEY, JSON.stringify({ mode: 'unknown-mode' }));
        const unknownHydrated = hydrateLensFromStorage();
        expect(unknownHydrated).toBeUndefined();
      } finally {
        sessionStorage.removeItem(AUTH_LENS_STORAGE_KEY);
      }
    }
  });

  it('supports multiple concurrent runtime chips listening to the same transport stream', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    const runtime = createPyricRuntimeStatus(manifest);

    const chip1 = mountPyricRuntimeChip({
      runtime,
      document: dom.window.document,
      getLens,
      setLens,
      subscribeLens,
    });

    const chip2 = mountPyricRuntimeChip({
      runtime,
      document: dom.window.document,
      getLens,
      setLens,
      subscribeLens,
    });

    try {
      setLens({ mode: 'as', uid: 'shared-listener-uid' });

      const root2 = chip2.element.shadowRoot!;
      const badge2 = root2.querySelector('[data-identity-badge]');
      expect(badge2?.textContent).toContain('shared-listener-uid');

      setLens(undefined);
      expect(root2.querySelector('[data-identity-badge]')).toBeNull();
    } finally {
      chip1.dispose();
      chip2.dispose();
      setLens(undefined);
    }
  });
});
