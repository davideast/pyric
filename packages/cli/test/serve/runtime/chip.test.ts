import { JSDOM } from 'jsdom';
import { describe, expect, it, mock } from 'bun:test';
import { mountPyricRuntimeChip, type PyricRuntimeChipOptions } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';
import type { RuntimeIdentity } from '../../../src/serve/runtime/identity.js';
import type { RuntimeIdentityBindings } from '../../../src/serve/runtime/identity.js';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

function setup(options: {
  initiallyOpen?: boolean;
  clipboard?: Pick<Clipboard, 'writeText'> | null;
  studioUrl?: string | null;
  initialLens?: AuthLens;
  initialUser?: RuntimeIdentity | null;
  listUsers?: () => Promise<AuthUserRecord[]> | AuthUserRecord[];
  getCurrentUser?: () => RuntimeIdentity | null;
  subscribeAuth?: (listener: (user: RuntimeIdentity | null) => void) => () => void;
  setLens?: (lens: AuthLens | undefined) => void;
  subscribeLens?: (listener: (lens: AuthLens | undefined) => void) => () => void;
  useRealClient?: boolean;
} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const runtime = createPyricRuntimeStatus(manifest);
  const writeText = mock(() => Promise.resolve());
  const clipboard = options.clipboard === null
    ? undefined
    : options.clipboard ?? { writeText };

  let currentLens: AuthLens | undefined = options.initialLens;
  let currentUser: RuntimeIdentity | null = options.initialUser ?? null;
  const lensListeners = new Set<(lens: AuthLens | undefined) => void>();
  const authListeners = new Set<(user: RuntimeIdentity | null) => void>();

  const setLensMock = mock((lens: AuthLens | undefined) => {
    currentLens = lens;
    for (const l of lensListeners) l(lens);
  });
  const subscribeLensMock = mock((listener: (lens: AuthLens | undefined) => void) => {
    lensListeners.add(listener);
    return () => lensListeners.delete(listener);
  });
  const subscribeAuthMock = mock((listener: (user: RuntimeIdentity | null) => void) => {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  });

  const identity: Partial<RuntimeIdentityBindings> = {
    subscribeAuth: options.subscribeAuth ?? subscribeAuthMock,
    getCurrentUser: options.getCurrentUser ?? (() => currentUser),
  };
  const chipOptions: PyricRuntimeChipOptions = {
    runtime,
    document: dom.window.document,
    identity,
  };

  if (!options.useRealClient) {
    chipOptions.getLens = () => currentLens;
    chipOptions.setLens = options.setLens ?? setLensMock;
    chipOptions.subscribeLens = options.subscribeLens ?? subscribeLensMock;
  }
  if (clipboard) {
    chipOptions.clipboard = clipboard;
  }
  if (options.initiallyOpen !== undefined) {
    chipOptions.initiallyOpen = options.initiallyOpen;
  }
  if (options.listUsers) {
    identity.listUsers = options.listUsers;
  }
  if ('studioUrl' in options) {
    chipOptions.studioUrl = options.studioUrl;
  }

  const chip = mountPyricRuntimeChip(chipOptions);
  const root = chip.element.shadowRoot!;
  return {
    dom,
    runtime,
    chip,
    root,
    writeText,
    setLensMock,
    setCurrentLens(lens: AuthLens | undefined) {
      currentLens = lens;
      for (const l of lensListeners) l(lens);
    },
    setCurrentUser(user: RuntimeIdentity | null) {
      currentUser = user;
      for (const l of authListeners) l(user);
    },
  };
}

describe('PyricRuntimeChip', () => {
  it('is collapsed by default and surfaces errors and worker updates compactly', () => {
    const { runtime, root } = setup();
    expect(root.querySelector('[data-expand]')).not.toBeNull();
    expect(root.textContent).toContain('pyric');

    runtime.reportError('write denied', 'sandbox');
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });

    expect(root.textContent).toContain('update');
    expect(root.textContent).toContain('1 error');
  });

  it('keeps worker and Studio controls stable while update availability changes', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    const initialUpdate = root.querySelector<HTMLButtonElement>('[data-update-worker]')!;
    expect(initialUpdate.disabled).toBe(true);
    expect(root.querySelector('[data-open-studio]')?.getAttribute('href')).toBe('/__pyric/ui/studio');
    expect(root.querySelector('[data-open-studio]')?.getAttribute('target')).toBe('_blank');

    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(root.querySelector<HTMLButtonElement>('[data-update-worker]')!.disabled).toBe(false);
  });

  it('keeps a disabled Studio action in place when Studio is unavailable', () => {
    const { root } = setup({ initiallyOpen: true, studioUrl: null });
    const studio = root.querySelector('[data-open-studio]');
    expect(studio?.tagName).toBe('SPAN');
    expect(studio?.getAttribute('aria-disabled')).toBe('true');
  });

  it('moves focus with the compact and expanded controls', () => {
    const { root } = setup();
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.activeElement?.hasAttribute('data-collapse')).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.activeElement?.hasAttribute('data-expand')).toBe(true);
  });

  it('preserves the focused control across runtime publications', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    const announcer = root.querySelector('.announcer');
    const update = root.querySelector<HTMLButtonElement>('[data-update-worker]')!;
    update.focus();

    runtime.reportError('a new sandbox error', 'sandbox');

    expect(root.activeElement?.hasAttribute('data-update-worker')).toBe(true);
    expect(root.querySelector('.announcer')).toBe(announcer);
    expect(announcer?.textContent).toContain('1 runtime error');
  });

  it('preserves the error viewport position across runtime publications', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    runtime.reportError('first', 'sandbox');
    const viewport = root.querySelector<HTMLElement>('[data-error-viewport]')!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 300 },
      clientHeight: { value: 100 },
    });
    viewport.scrollTop = 40;

    runtime.reportError('second', 'sandbox');

    expect(root.querySelector<HTMLElement>('[data-error-viewport]')!.scrollTop).toBe(40);
  });

  it('renders a scrollable error viewport and copies the selected error', async () => {
    const { runtime, root, writeText } = setup({ initiallyOpen: true });
    runtime.reportError(Object.assign(new Error('listener failed'), { code: 'permission-denied' }), 'sandbox');

    expect(root.querySelector('[data-error-viewport]')).not.toBeNull();
    expect(root.querySelector('.error-body')?.textContent).toContain('listener failed');
    root.querySelector<HTMLButtonElement>('[data-copy-error]')!.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('listener failed');
    expect(writeText.mock.calls[0]?.[0]).toContain('permission-denied');
  });

  it('disables copy when the Clipboard API is unavailable', () => {
    const { runtime, root } = setup({ initiallyOpen: true, clipboard: null });
    runtime.reportError('listener failed', 'sandbox');

    const copy = root.querySelector<HTMLButtonElement>('[data-copy-error]')!;
    expect(copy.disabled).toBe(true);
    expect(copy.getAttribute('aria-label')).toBe('Copy unavailable');
  });

  it('handles a rejected clipboard write and exposes failure on the control', async () => {
    const writeText = mock(() => Promise.reject(new Error('permission denied')));
    const { runtime, root } = setup({ initiallyOpen: true, clipboard: { writeText } });
    runtime.reportError('listener failed', 'sandbox');
    const copy = root.querySelector<HTMLButtonElement>('[data-copy-error]')!;
    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(copy.hasAttribute('data-copy-failed')).toBe(true);
    expect(copy.getAttribute('aria-label')).toBe('Copy failed');
  });

  it('invokes the runtime updater and disposes its host', async () => {
    const { runtime, root, chip, dom } = setup({ initiallyOpen: true });
    const update = mock(() => Promise.resolve());
    runtime.setWorkerUpdater(update);
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    const button = root.querySelector<HTMLButtonElement>('[data-update-worker]')!;
    button.focus();
    button.click();
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(1);
    expect(root.activeElement?.hasAttribute('data-update-worker')).toBe(true);
    expect(root.querySelector('[data-update-worker]')?.getAttribute('aria-disabled')).toBe('true');
    chip.dispose();
    expect(dom.window.document.querySelector('[data-pyric-runtime-chip-host]')).toBeNull();
  });

  it('clears all errors when the header Clear button is clicked', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    runtime.reportError('first error', 'sandbox');
    runtime.reportError('second error', 'sandbox');
    expect(root.querySelectorAll('.error-row')).toHaveLength(2);

    root.querySelector<HTMLButtonElement>('[data-clear-errors]')!.click();
    expect(root.querySelectorAll('.error-row')).toHaveLength(0);
  });

  it('dismisses an individual error when its dismiss button is clicked', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    runtime.reportError('first error', 'sandbox');
    runtime.reportError('second error', 'sandbox');
    expect(root.querySelectorAll('.error-row')).toHaveLength(2);

    const firstDismiss = root.querySelector<HTMLButtonElement>('[data-dismiss-error]')!;
    firstDismiss.click();
    expect(root.querySelectorAll('.error-row')).toHaveLength(1);
    expect(root.textContent).toContain('second error');
    expect(root.textContent).not.toContain('first error');
  });

  it('hides the host element from the page when the dismiss-chip X button is clicked', () => {
    const { root, chip } = setup({ initiallyOpen: true });
    expect(chip.element.style.display).not.toBe('none');

    root.querySelector<HTMLButtonElement>('[data-dismiss-chip]')!.click();
    expect(chip.element.style.display).toBe('none');
  });

  it('displays identity badge in collapsed bar when lens is active and omits it when unauthenticated', () => {
    const { root, setCurrentLens } = setup({
      initialLens: { mode: 'as', uid: 'alice' },
    });

    const badge = root.querySelector('[data-identity-badge]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('as: alice');

    setCurrentLens({ mode: 'admin' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('bypass rules');

    setCurrentLens(undefined);
    expect(root.querySelector('[data-identity-badge]')).toBeNull();
  });

  it('displays identity badge from authenticated client user when no lens override is active', () => {
    let activeUser: RuntimeIdentity | null = { uid: 'sam-uid', displayName: 'Sam Altman' };
    const { root, setCurrentUser } = setup({
      getCurrentUser: () => activeUser,
    });

    const badge = root.querySelector('[data-identity-badge]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('as: sam-uid');

    activeUser = null;
    setCurrentUser(null);
    expect(root.querySelector('[data-identity-badge]')).toBeNull();
  });

  it('shows authenticated identity and rules bypass as independent collapsed signals', () => {
    const { root } = setup({
      initialUser: { uid: 'sam-uid' },
      initialLens: { mode: 'admin' },
    });

    const signals = [...root.querySelectorAll('[data-identity-badge]')]
      .map((element) => element.textContent);
    expect(signals).toEqual(['as: sam-uid', 'bypass rules']);
  });

  it('keeps a dedicated Identity row mounted across authentication changes', () => {
    const { root, setCurrentUser } = setup({ initiallyOpen: true });
    const initialRows = root.querySelectorAll('.worker-state');
    const initialIdentityRow = root.querySelector('[data-identity-state]');

    expect(initialIdentityRow?.textContent).toBe('App session');

    setCurrentUser({ uid: 'alice' });

    expect(root.querySelectorAll('.worker-state')).toHaveLength(initialRows.length);
    expect(root.querySelector('[data-identity-state]')?.textContent).toBe('as: alice');
  });

  it('reattaches the same host after an Astro document swap', () => {
    const { dom, chip, root } = setup({ initiallyOpen: true });
    const host = chip.element;
    const shadowRoot = host.shadowRoot;

    host.remove();
    dom.window.document.dispatchEvent(new dom.window.Event('astro:after-swap'));

    expect(dom.window.document.body.contains(host)).toBe(true);
    expect(host.shadowRoot).toBe(shadowRoot);
    expect(root.querySelector('[data-open-impersonate]')).not.toBeNull();

    chip.dispose();
    dom.window.document.dispatchEvent(new dom.window.Event('astro:after-swap'));
    expect(dom.window.document.body.contains(host)).toBe(false);
  });

  it('clicking Identity button opens impersonate dialog inside Shadow Root', () => {
    const { root } = setup({ initiallyOpen: true });
    const identityBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    expect(identityBtn).not.toBeNull();

    identityBtn.click();
    const dialog = root.querySelector('dialog[data-impersonate-dialog]')!;
    expect(dialog).not.toBeNull();
  });

  it('reactively updates badge without reload using default client transport', () => {
    const { root, setCurrentLens } = setup({ initiallyOpen: false });
    expect(root.querySelector('[data-identity-badge]')).toBeNull();

    setCurrentLens({ mode: 'as', uid: 'charlie' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('as: charlie');

    setCurrentLens(undefined);
    expect(root.querySelector('[data-identity-badge]')).toBeNull();
  });

  it('renders hostile identity values as text', () => {
    const maliciousUid = '<script>alert("xss")</script><img data-injected src=x>';
    const { root } = setup({ initialLens: { mode: 'as', uid: maliciousUid } });

    expect(root.querySelector('[data-identity-badge]')?.textContent).toContain(maliciousUid);
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('[data-injected]')).toBeNull();
  });

  it('handles rapid lens publications and stops reacting after disposal', () => {
    const { chip, root, setCurrentLens } = setup();
    for (let index = 0; index < 50; index += 1) {
      setCurrentLens({ mode: 'as', uid: `user-${index}` });
      expect(root.querySelector('[data-identity-badge]')?.textContent).toContain(`user-${index}`);
    }

    chip.dispose();
    setCurrentLens({ mode: 'as', uid: 'detached-user' });
    expect(root.textContent).not.toContain('detached-user');
  });
});
