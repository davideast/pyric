import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'bun:test';
import { createSdkActivityJournal, createSdkRateMonitor } from 'pyric/sandbox/internal';
import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { RuntimeIdentity } from '../../../src/serve/runtime/identity.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

function createHarness(initiallyOpen = false) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const runtime = createPyricRuntimeStatus(manifest);
  const journal = createSdkActivityJournal();
  const rates = createSdkRateMonitor(journal);

  let currentLens: AuthLens | undefined;
  let currentUser: RuntimeIdentity | null = null;
  const lensListeners = new Set<(lens: AuthLens | undefined) => void>();
  const authListeners = new Set<(user: RuntimeIdentity | null) => void>();

  const mounted = mountPyricRuntimeChip({
    rates,
    runtime,
    document: dom.window.document,
    initiallyOpen,
    thresholdConfig: null,
    indexConfig: null,
    getLens: () => currentLens,
    setLens: (next) => {
      currentLens = next;
      for (const listener of lensListeners) listener(next);
    },
    subscribeLens: (listener) => {
      lensListeners.add(listener);
      return () => lensListeners.delete(listener);
    },
    identity: {
      getCurrentUser: () => currentUser,
      subscribeAuth: (listener) => {
        authListeners.add(listener);
        return () => authListeners.delete(listener);
      },
      listUsers: () => [
        { uid: 'u1', email: 'alice@example.com', displayName: 'Alice' } as AuthUserRecord,
      ],
    },
  });

  cleanups.push(() => {
    mounted.dispose();
    rates.dispose();
    journal.dispose();
    dom.window.close();
  });

  const root = mounted.element.shadowRoot;
  if (!root) throw new Error('Expected open shadowRoot on mounted runtime chip');

  return {
    dom,
    runtime,
    mounted,
    root,
    setUser(user: RuntimeIdentity | null) {
      currentUser = user;
      for (const listener of authListeners) listener(user);
    },
    setLens(lens: AuthLens | undefined) {
      currentLens = lens;
      for (const listener of lensListeners) listener(lens);
    },
  };
}

describe('runtime chip entrance animation lifecycle (#600)', () => {
  it('scopes .entering to initial mount while collapsed updates mutate chip state without re-entering', () => {
    const { root, runtime, mounted, setUser, setLens } = createHarness(false);
    const hostBefore = mounted.element;
    const view = root.querySelector<HTMLElement>('[data-view]');
    const initialChip = root.querySelector<HTMLButtonElement>('.chip');
    expect(view).not.toBeNull();
    expect(initialChip).not.toBeNull();
    expect(view?.classList.contains('entering')).toBe(true);
    expect(initialChip?.classList.contains('entering')).toBe(false);

    // Simulate the initial 120ms entrance animation settling on the container.
    view?.classList.remove('entering');

    // Burst of no-op and meaningful status, worker, error, auth, and lens updates.
    runtime.clearErrors();
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(root.querySelector('.chip')?.classList.contains('warning')).toBe(true);

    runtime.reportError('write denied', 'sandbox');
    expect(root.querySelector('.chip')?.classList.contains('error')).toBe(true);

    setUser({ uid: 'u1', email: 'alice@example.com', displayName: 'Alice' });
    setLens({ mode: 'admin' });
    setLens(undefined);
    runtime.clearErrors();
    expect(root.querySelector('.chip')?.classList.contains('warning')).toBe(true);
    expect(root.querySelector('.chip')?.classList.contains('error')).toBe(false);

    expect(mounted.element).toBe(hostBefore);
    expect(view?.classList.contains('entering')).toBe(false);
    expect(root.querySelector('.chip')?.classList.contains('entering')).toBe(false);
  });

  it('animates .panel only on explicit open transitions, never on subsequent expanded updates', async () => {
    const { root, runtime, setUser, setLens } = createHarness(false);
    const view = root.querySelector<HTMLElement>('[data-view]');
    view?.classList.remove('entering');

    const expandButton = root.querySelector<HTMLButtonElement>('[data-expand]');
    expect(expandButton).not.toBeNull();
    expandButton?.click();
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(true);
    expect(root.activeElement).toBe(root.querySelector('[data-collapse]'));

    // Let async directory loading and initial panel entrance settle.
    await Promise.resolve();
    await Promise.resolve();
    root.querySelector('.panel')?.classList.remove('entering');

    // Meaningful and no-op updates while expanded update content without re-adding .entering.
    setUser({ uid: 'u1', email: 'alice@example.com', displayName: 'Alice' });
    expect(root.querySelector('[data-identity-row] .c1')?.textContent).toBe('Alice');
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(false);

    setLens({ mode: 'admin' });
    expect(root.querySelector('[data-toggle-bypass]')?.getAttribute('aria-checked')).toBe('true');
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(false);

    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(root.querySelector('[data-update-row]')).not.toBeNull();
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(false);

    runtime.reportError('denied read', 'sandbox');
    expect(root.querySelector('[data-chip-tab="traffic"]')?.classList.contains('problem')).toBe(true);
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(false);

    runtime.clearErrors();
    expect(view?.classList.contains('entering')).toBe(false);
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(false);

    // Collapse does not animate .chip; a deliberate re-open animates .panel again.
    root.querySelector<HTMLButtonElement>('[data-collapse]')?.click();
    expect(root.querySelector('.chip')?.classList.contains('entering')).toBe(false);
    expect(root.activeElement).toBe(root.querySelector('[data-expand]'));

    root.querySelector<HTMLButtonElement>('[data-expand]')?.click();
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(true);
  });
});
