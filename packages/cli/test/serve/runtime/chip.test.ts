import { JSDOM } from 'jsdom';
import { describe, expect, it, mock } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import { setLens } from '../../../src/serve/worker/client.js';
import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

function setup(options: {
  initiallyOpen?: boolean;
  clipboard?: Pick<Clipboard, 'writeText'> | null;
  studioUrl?: string | null;
  initialLens?: AuthLens | undefined;
  setLens?: (lens: AuthLens | undefined) => void;
  subscribeLens?: (listener: (lens: AuthLens | undefined) => void) => () => void;
  listUsers?: () => Promise<AuthUserRecord[]> | AuthUserRecord[];
  getCurrentUser?: () => { uid: string; email?: string | null; displayName?: string | null } | null;
  subscribeAuth?: (listener: (user: { uid: string; email?: string | null; displayName?: string | null } | null) => void) => () => void;
  useRealClient?: boolean;
} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  if (typeof dom.window.HTMLDialogElement !== 'undefined') {
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
  }

  let currentLens = options.initialLens;
  const lensListeners = new Set<(lens: AuthLens | undefined) => void>();
  const setLensMock = mock((lens: AuthLens | undefined) => {
    currentLens = lens;
    for (const l of lensListeners) l(lens);
  });
  const subscribeLensMock = mock((listener: (lens: AuthLens | undefined) => void) => {
    lensListeners.add(listener);
    return () => lensListeners.delete(listener);
  });

  const authListeners = new Set<(user: any) => void>();
  let currentUser = options.getCurrentUser ? options.getCurrentUser() : null;
  const subscribeAuthMock = mock((listener: (user: any) => void) => {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  });

  const runtime = createPyricRuntimeStatus(manifest);
  const writeText = mock(() => Promise.resolve());
  const clipboard = options.clipboard === null
    ? undefined
    : options.clipboard ?? { writeText };

  const chipOptions: PyricRuntimeChipOptions = {
    runtime,
    document: dom.window.document,
    subscribeAuth: options.subscribeAuth ?? subscribeAuthMock,
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
    chipOptions.listUsers = options.listUsers;
  }
  if (options.getCurrentUser) {
    chipOptions.getCurrentUser = () => currentUser;
  }
  if ('studioUrl' in options) {
    chipOptions.studioUrl = options.studioUrl;
  }

  const chip = mountPyricRuntimeChip(chipOptions);

  const root = chip.element.shadowRoot!;
  return {
    chip,
    root,
    runtime,
    writeText,
    dom,
    setLensMock,
    setCurrentLens(lens: AuthLens | undefined) {
      currentLens = lens;
      for (const l of lensListeners) l(lens);
    },
    setCurrentUser(user: any) {
      currentUser = user;
      for (const l of authListeners) l(user);
    },
  };
}

describe('PyricRuntimeChip', () => {
  it('is collapsed by default and opens/closes via controls', () => {
    const { root } = setup({ initiallyOpen: false });
    const bar = root.querySelector<HTMLElement>('[data-toggle-open]')!;
    expect(bar).not.toBeNull();

    // Click bar to expand panel
    bar.click();
    expect(root.querySelector('.panel')).not.toBeNull();

    // Click minimize to collapse
    root.querySelector<HTMLElement>('[data-toggle-close]')!.click();
    expect(root.querySelector('[data-toggle-open]')).not.toBeNull();
  });

  it('hides the host element from the page when dismiss button is clicked', () => {
    const { root, chip } = setup({ initiallyOpen: true });
    expect(chip.element.style.display).not.toBe('none');

    root.querySelector<HTMLElement>('[data-dismiss]')!.click();
    expect(chip.element.style.display).toBe('none');
  });

  it('surfaces runtime errors and updates error count badge', () => {
    const { runtime, root } = setup({ initiallyOpen: false });
    expect(root.querySelector('.bar-badge.error')).toBeNull();

    runtime.reportError('first error', 'sandbox');
    const badge = root.querySelector('.bar-badge.error')!;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('1 error');

    runtime.reportError('second error', 'sandbox');
    expect(root.querySelector('.bar-badge.error')!.textContent).toContain('2 errors');
  });

  it('displays identity badge in collapsed bar when lens is active and omits it when unauthenticated', () => {
    const { root, setCurrentLens } = setup({
      initialLens: { mode: 'as', uid: 'alice' },
    });

    const badge = root.querySelector('[data-identity-badge]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('as: alice');

    setCurrentLens({ mode: 'admin' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('⚡ RULES BYPASS');

    setCurrentLens(undefined);
    expect(root.querySelector('[data-identity-badge]')).toBeNull();
  });

  it('displays identity badge from authenticated client user when no lens override is active', () => {
    let activeUser: any = { uid: 'sam-uid', email: 'sam@example.com' };
    const { root, setCurrentUser } = setup({
      getCurrentUser: () => activeUser,
    });

    const badge = root.querySelector('[data-identity-badge]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('as: sam-uid');

    // Sign out client user
    activeUser = null;
    setCurrentUser(null);
    expect(root.querySelector('[data-identity-badge]')).toBeNull();
  });

  it('clicking Identity button opens impersonate dialog inside Shadow Root', () => {
    const { root } = setup({ initiallyOpen: true });
    const identityBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    expect(dialog.hasAttribute('open')).toBe(false);

    identityBtn.click();
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('Studio button opens Studio URL when clicked', () => {
    const { root, dom } = setup({ initiallyOpen: true, studioUrl: '/__pyric/ui/custom' });
    const studioBtn = root.querySelector<HTMLButtonElement>('[data-open-studio]')!;

    let openedUrl: string | null = null;
    dom.window.open = (url: string) => {
      openedUrl = url;
      return null;
    };

    studioBtn.click();
    expect(openedUrl).toBe('/__pyric/ui/custom');
  });

  it('disables Studio button when studioUrl is null', () => {
    const { root } = setup({ initiallyOpen: true, studioUrl: null });
    const studioBtn = root.querySelector<HTMLButtonElement>('[data-open-studio]')!;
    expect(studioBtn.disabled).toBe(true);
  });

  it('reactively updates badge without reload using default client transport', () => {
    setLens(undefined);
    const { root, chip } = setup({ useRealClient: true });
    expect(root.querySelector('[data-identity-badge]')).toBeNull();

    setLens({ mode: 'as', uid: 'charlie' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('as: charlie');

    setLens({ mode: 'admin' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('⚡ RULES BYPASS');

    setLens(undefined);
    expect(root.querySelector('[data-identity-badge]')).toBeNull();

    chip.dispose();
  });
});
