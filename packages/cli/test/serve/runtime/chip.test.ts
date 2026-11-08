import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { createAppForSandbox } from 'pyric/app/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { createSdkActivityJournal, createSdkRateMonitor, observedCallEvent, readObservedCall } from 'pyric/sandbox/internal';
import { getStorage, getStorageSandbox, ref, uploadBytes } from 'pyric/storage';
import { createListenerMode, type ListenerMode } from '../../../src/serve/runtime/listener-mode.js';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mountPyricRuntimeChip, type PyricRuntimeChipOptions } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import { profileClientId } from '../../../src/serve/worker/client/client-id.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { AuthLens, EventCaller, SandboxEvent } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';
import type { RuntimeIdentity } from '../../../src/serve/runtime/identity.js';
import type { LiveIdentity } from '../../../src/serve/runtime/live-identity.js';
import type { RuntimeIdentityBindings } from '../../../src/serve/runtime/identity.js';
import type { ChipTab } from '../../../src/serve/runtime/chip-tab.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

function user(uid: string, email?: string): AuthUserRecord {
  return { uid, ...(email === undefined ? {} : { email }) } as AuthUserRecord;
}

function setup(options: {
  initiallyOpen?: boolean;
  studioUrl?: string | null;
  initialLens?: AuthLens;
  initialUser?: RuntimeIdentity | null;
  listUsers?: () => Promise<AuthUserRecord[]> | AuthUserRecord[];
  getCurrentUser?: () => RuntimeIdentity | null;
  subscribeAuth?: (listener: (user: RuntimeIdentity | null) => void) => () => void;
  switchUser?: (uid: string) => void;
  signOut?: () => void;
  openCreateUser?: () => void;
  setLens?: (lens: AuthLens | undefined) => void;
  subscribeLens?: (listener: (lens: AuthLens | undefined) => void) => () => void;
  aiConfiguration?: PyricRuntimeChipOptions['aiConfiguration'];
  withSandboxEvents?: boolean;
  clipboard?: Pick<Clipboard, 'writeText'>;
  useRealClient?: boolean;
  manifest?: PyricRuntimeManifest;
  liveStatus?: PyricRuntimeChipOptions['liveStatus'];
  liveStatusTimers?: PyricRuntimeChipOptions['liveStatusTimers'];
  liveIdentity?: PyricRuntimeChipOptions['liveIdentity'];
} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const runtime = createPyricRuntimeStatus(options.manifest ?? manifest);

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
  if (options.switchUser) identity.switchUser = options.switchUser;
  if (options.signOut) identity.signOut = options.signOut;
  if (options.openCreateUser) identity.openCreateUser = options.openCreateUser;
  if (options.listUsers) identity.listUsers = options.listUsers;

  // Each mounted test page owns its rates; other suites share the process journal.
  const journal = createSdkActivityJournal();
  const rates = createSdkRateMonitor(journal);
  cleanups.push(() => { rates.dispose(); journal.dispose(); });
  const chipOptions: PyricRuntimeChipOptions = {
    rates,
    runtime,
    ...(options.aiConfiguration ? { aiConfiguration: options.aiConfiguration } : {}),
    document: dom.window.document,
    identity,
  };
  if (!options.useRealClient) {
    chipOptions.getLens = () => currentLens;
    chipOptions.setLens = options.setLens ?? setLensMock;
    chipOptions.subscribeLens = options.subscribeLens ?? subscribeLensMock;
  }
  if (options.initiallyOpen !== undefined) {
    chipOptions.initiallyOpen = options.initiallyOpen;
  }
  if ('studioUrl' in options) {
    chipOptions.studioUrl = options.studioUrl;
  }
  if (options.liveStatus) chipOptions.liveStatus = options.liveStatus;
  if (options.liveStatusTimers) chipOptions.liveStatusTimers = options.liveStatusTimers;
  if (options.liveIdentity) chipOptions.liveIdentity = options.liveIdentity;
  if (options.clipboard) {
    chipOptions.clipboard = options.clipboard;
  }
  // Every subscriber gets each batch, as the page's event source delivers it: Traffic and the capture both read it.
  const subscribers = new Set<(events: readonly SandboxEvent[], batch: { history: boolean; pageId?: string }) => void>();
  if (options.withSandboxEvents) {
    chipOptions.sandboxEvents = (callback) => {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    };
  }

  const chip = mountPyricRuntimeChip(chipOptions);
  cleanups.push(() => { chip.dispose(); dom.window.close(); });
  const root = chip.element.shadowRoot!;
  return {
    dom,
    runtime,
    chip,
    root,
    setLensMock,
    push: (events: readonly SandboxEvent[], batch: { history: boolean; pageId?: string } = { history: false }) => { for (const subscriber of [...subscribers]) subscriber(events, batch); },
    showTab(tab: ChipTab) {
      root.querySelector<HTMLButtonElement>(`[data-chip-tab="${tab}"]`)!.click();
    },
    setCurrentLens(lens: AuthLens | undefined) {
      currentLens = lens;
      for (const l of lensListeners) l(lens);
    },
    setCurrentUser(next: RuntimeIdentity | null) {
      currentUser = next;
      for (const l of authListeners) l(next);
    },
  };
}


function texts(root: ShadowRoot, selector: string): string[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

describe('the collapsed pill', () => {
  it('is the word alone, in one fixed box, with the page state on its border', () => {
    const { root, runtime } = setup();
    const chip = root.querySelector<HTMLButtonElement>('.chip')!;
    expect(chip.textContent).toBe('pyric');
    expect(chip.children.length).toBe(0);
    expect(chip.classList.contains('error')).toBe(false);
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(root.querySelector('.chip')!.classList.contains('warning')).toBe(true);
    runtime.reportError('write to conversations denied', 'sandbox');
    const failed = root.querySelector('.chip')!;
    expect(failed.classList.contains('error')).toBe(true);
    expect(failed.classList.contains('warning')).toBe(false);
    expect(failed.textContent).toBe('pyric');
  });

  it('plays the enter animation on the first mount only, and the panel one on each open', () => {
    const { root } = setup();
    const view = root.querySelector('[data-view]')!;
    expect(view.classList.contains('entering')).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.querySelector('.panel')!.classList.contains('entering')).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.querySelector('.chip')).not.toBeNull();
  });

  it('moves focus with the collapsed and open controls', () => {
    const { root } = setup();
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.activeElement).toBe(root.querySelector('[data-collapse]'));
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.activeElement).toBe(root.querySelector('[data-expand]'));
  });

  it('reattaches the same host after an Astro document swap', () => {
    const { dom, chip } = setup();
    chip.element.remove();
    dom.window.document.dispatchEvent(new dom.window.Event('astro:after-swap'));
    expect(chip.element.isConnected).toBe(true);
  });
});

describe('the panel shell', () => {
  it('holds the name and two buttons in its header, and four plain tabs under it', () => {
    const { root } = setup({ initiallyOpen: true });
    expect(root.querySelector('.panel-name')!.textContent).toBe('pyric');
    expect(texts(root, '.panel-header .btn')).toEqual(['Studio', 'Close']);
    expect(texts(root, '[data-chip-tab]')).toEqual(['Identity', 'Data', 'Traffic', 'Sandbox']);
    expect(texts(root, '[data-chip-tab]').some((label) => /\d/.test(label))).toBe(false);
  });

  it('shows the chosen view and remembers it for the next open', () => {
    const { root, showTab } = setup({ initiallyOpen: true });
    showTab('sandbox');
    expect(root.querySelector('[data-chip-view]')!.getAttribute('data-chip-view')).toBe('sandbox');
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.querySelector('[data-chip-view]')!.getAttribute('data-chip-view')).toBe('sandbox');
  });

  it('points the Studio button at the section the selected tab is about', () => {
    const { root, showTab } = setup({ initiallyOpen: true });
    expect(root.querySelector('[data-open-studio]')!.getAttribute('href')).toContain('/auth');
    showTab('traffic');
    expect(root.querySelector('[data-open-studio]')!.getAttribute('href')).toContain('/traffic');
  });

  it('points the Studio button at absolute studioUrl from runtime manifest', () => {
    const customManifest: PyricRuntimeManifest = {
      studioUrl: 'http://localhost:3473/__pyric/ui/studio',
      worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
    };
    const { root, showTab } = setup({ initiallyOpen: true, manifest: customManifest });
    expect(root.querySelector('[data-open-studio]')!.getAttribute('href'))
      .toBe('http://localhost:3473/__pyric/ui/auth/');
    showTab('traffic');
    expect(root.querySelector('[data-open-studio]')!.getAttribute('href'))
      .toBe('http://localhost:3473/__pyric/ui/traffic/');
  });

  it('keeps a disabled Studio button in place when Studio is unavailable', () => {
    const { root } = setup({ initiallyOpen: true, studioUrl: null });
    expect(root.querySelector('[data-open-studio]')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('supports arrow navigation between tabs and exposes a minimize control', () => {
    const { root, dom } = setup({ initiallyOpen: true });
    const identity = root.querySelector<HTMLButtonElement>('[data-chip-tab="identity"]')!;
    identity.focus();
    identity.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(root.activeElement).toBe(root.querySelector('[data-chip-tab="listeners"]'));
    expect(root.querySelectorAll('[role="tab"][tabindex="0"]').length).toBe(1);
    expect(root.querySelector('[data-collapse]')!.getAttribute('aria-label')).toBe('Minimize pyric');
  });

  it('preserves the scroll position on live updates and starts a different tab at the top', async () => {
    const { root, runtime, showTab } = setup({ initiallyOpen: true });
    await Promise.resolve();
    root.querySelector('.view')!.scrollTop = 90;
    runtime.reportError('test error', 'runtime');
    expect(root.querySelector('.view')!.scrollTop).toBe(90);
    showTab('traffic');
    expect(root.querySelector('.view')!.scrollTop).toBe(0);
  });

  it('keeps the view nodes when a render repeats the markup, so an in-flight scroll lands on them', () => {
    const { root, showTab, setCurrentLens } = setup({ initiallyOpen: true });
    showTab('sandbox');
    const view = root.querySelector('[data-chip-view]');
    setCurrentLens(undefined);
    expect(root.querySelector('[data-chip-view]')).toBe(view);
  });

  it('rebuilds a view edited outside render even when the markup repeats', () => {
    const { root, showTab, setCurrentLens, dom } = setup({ initiallyOpen: true });
    showTab('sandbox');
    const view = root.querySelector('[data-chip-view]');
    root.querySelector('.view-content')!.append(dom.window.document.createElement('hr'));
    setCurrentLens(undefined);
    expect(root.querySelector('[data-chip-view]')).not.toBe(view);
    expect(root.querySelector('.view-content hr')).toBeNull();
  });

  it('colours the tab whose view holds the problem, and opens on it', () => {
    const { root, runtime } = setup();
    runtime.reportError('write to conversations denied', 'sandbox');
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.querySelector('[data-chip-view]')!.getAttribute('data-chip-view')).toBe('traffic');
    expect(root.querySelector('[data-chip-tab="traffic"]')!.classList.contains('problem')).toBe(true);
    expect(root.querySelectorAll('.tab.problem, .tab.pending').length).toBe(1);
  });

  it('uses shared row cells or configuration facts and keeps controls in action slots', () => {
    const { root, showTab, runtime } = setup({ initiallyOpen: true, initialUser: { uid: 'u1', email: 'a@example.com' } });
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    for (const tab of ['identity', 'listeners', 'traffic', 'sandbox'] as const) {
      showTab(tab);
      for (const row of root.querySelectorAll('.row')) {
        const isConfigurationRecord = row.hasAttribute('data-ai-row');
        if (isConfigurationRecord) {
          expect(row.querySelectorAll('dt').length).toBeGreaterThan(0);
          expect(row.querySelectorAll('dd').length).toBe(row.querySelectorAll('dt').length);
          expect(row.querySelectorAll('button, a, input').length).toBe(0);
          continue;
        }
        expect(row.querySelector('.c1')).not.toBeNull();
        expect(row.querySelector('.slot')).not.toBeNull();
        // The slot may hold the row's one button; nothing else in the row may.
        expect(row.querySelectorAll('button, a, input').length).toBeLessThanOrEqual(row.querySelectorAll('.slot > .btn').length);
      }
      // Identity holds its one switch in the view, so it has no bar until it offers Create user.
      if (tab !== 'identity') expect(root.querySelector('[data-action-bar]')).not.toBeNull();
      expect(root.querySelector('.view [data-action-bar]')).toBeNull();
    }
  });

  it('never prints a dot separator or a status word', () => {
    const { root, showTab } = setup({ initiallyOpen: true, initialUser: { uid: 'u1', email: 'a@example.com' } });
    for (const tab of ['identity', 'listeners', 'traffic', 'sandbox'] as const) {
      showTab(tab);
      const text = root.querySelector('.panel')!.textContent ?? '';
      expect(text).not.toContain('·');
      expect(text).not.toMatch(/running|shared worker|in-page|AI engine/);
    }
  });
});

describe('the Identity view', () => {
  it('reads Signed out with no button when there is no session, and still offers the bypass', () => {
    const { root } = setup({ initiallyOpen: true });
    expect(root.querySelector('[data-identity-row] .c1')!.textContent).toBe('Signed out');
    expect(root.querySelector('[data-identity-row] .btn')).toBeNull();
    expect(root.querySelector('.view [data-toggle-bypass][role="switch"]')).not.toBeNull();
    expect(root.querySelector('[data-action-bar]')).toBeNull();
  });

  it('names the session, keeps the email and providers in the sub-row, and signs out from the slot', () => {
    const signOut = mock(() => {});
    const { root } = setup({
      initiallyOpen: true,
      initialUser: { uid: 'u1', email: 'a@example.com', displayName: 'Alice' },
      listUsers: () => [{ uid: 'u1', email: 'a@example.com', displayName: 'Alice', providerUserInfo: [{ providerId: 'google.com' }] } as AuthUserRecord],
      signOut,
    });
    const row = root.querySelector('[data-identity-row]')!;
    expect(row.querySelector('.c1')!.textContent).toBe('Alice');
    expect(row.querySelector('.s1')!.textContent).toContain('a@example.com');
    expect(row.getAttribute('title')).toBe('u1');
    row.querySelector<HTMLButtonElement>('[data-sign-out]')!.click();
    expect(signOut).toHaveBeenCalled();
  });

  it('lists the sandbox users as sign-in rows, filters them as one types, and switches on click', async () => {
    const switchUser = mock((_uid: string) => {});
    const { root } = setup({
      initiallyOpen: true,
      initialUser: { uid: 'u1', email: 'a@example.com' },
      listUsers: () => [user('u1', 'a@example.com'), user('u2', 'bob@example.com'), user('u3', 'carol@example.com')],
      switchUser,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelectorAll('[data-switch-user]').length).toBe(2);
    const input = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    input.value = 'bob';
    input.dispatchEvent(new (root.host.ownerDocument.defaultView as typeof globalThis).Event('input'));
    expect(texts(root, '[data-switch-user] .c1')).toEqual(['bob@example.com']);
    root.querySelector<HTMLButtonElement>('[data-switch-user="u2"]')!.click();
    expect(switchUser).toHaveBeenCalledWith('u2');
  });

  it('shows session photos immediately and keeps an initials fallback when an image fails', () => {
    const { root, dom } = setup({ initiallyOpen: true, initialUser: { uid: 'u1', displayName: 'Alice Chen', photoURL: '/avatars/alice.png' } });
    const image = root.querySelector<HTMLImageElement>('[data-identity-row] img')!;
    expect(image.getAttribute('src')).toBe('/avatars/alice.png');
    expect(root.querySelector('.avatar')!.textContent).toBe('AC');
    image.dispatchEvent(new dom.window.Event('error'));
    expect(image.hidden).toBe(true);
  });

  it('shows the impersonated profile and accessible provider marks instead of borrowing the app profile', async () => {
    const { root } = setup({
      initiallyOpen: true,
      initialUser: { uid: 'app-user', displayName: 'App user', photoURL: '/app-user.png' },
      initialLens: { mode: 'as', uid: 'u2' },
      listUsers: () => [{ uid: 'u2', displayName: 'Bob', email: 'bob@example.com', photoUrl: '/bob.png', providerUserInfo: [{ providerId: 'google.com' }, { providerId: 'github.com' }] } as AuthUserRecord],
    });
    await Promise.resolve();
    const row = root.querySelector('[data-identity-row]')!;
    expect(row.querySelector('.c1')!.textContent).toBe('Bob');
    expect(row.querySelector('img')!.getAttribute('src')).toBe('/bob.png');
    expect([...row.querySelectorAll('.provider')].map((provider) => provider.getAttribute('aria-label'))).toEqual(['google.com', 'github.com']);
    expect(row.querySelectorAll('svg').length).toBe(2);
    expect(root.querySelector('.view')!.textContent).toContain('Impersonating');
  });

  it('distinguishes an unavailable directory from an empty one and retries when Identity reopens', async () => {
    let attempts = 0;
    const { root, showTab } = setup({ initiallyOpen: true, listUsers: () => {
      if (++attempts === 1) throw new Error('offline');
      return [user('u2', 'bob@example.com')];
    } });
    await Promise.resolve();
    expect(root.querySelector('.view')!.textContent).toContain('Could not load users');
    showTab('sandbox');
    showTab('identity');
    await Promise.resolve();
    expect(root.querySelector('[data-switch-user="u2"]')).not.toBeNull();
  });

  it('bounds provider icons and reveals all ten providers without signing the user in', async () => {
    const switchUser = mock(() => {});
    const providers = ['google.com', 'github.com', 'password', 'phone', 'microsoft.com', 'apple.com', 'facebook.com', 'twitter.com', 'oidc.example', 'saml.example'];
    const { root, runtime } = setup({ initiallyOpen: true, switchUser, listUsers: () => [{ uid: 'many', email: 'many@example.com', providerUserInfo: providers.map(providerId => ({ providerId })) } as AuthUserRecord] });
    await Promise.resolve();
    expect(root.querySelectorAll('[data-switch-user="many"] .provider').length).toBe(3);
    const details = root.querySelector<HTMLDetailsElement>('[data-user-providers="many"]')!;
    expect(details.querySelector('summary')!.textContent).toContain('+7 providers');
    details.open = true;
    expect([...details.querySelectorAll('.provider-entry')].map(el => el.textContent)).toEqual(providers);
    runtime.reportError('update', 'runtime');
    expect(root.querySelector<HTMLDetailsElement>('[data-user-providers="many"]')!.open).toBe(true);
    expect(switchUser).not.toHaveBeenCalled();
  });

  it('searches all 10,000 users while rendering only one page and makes later pages reachable', async () => {
    const directory = Array.from({ length: 10_000 }, (_, i) => user(`user-${i}`, `user-${i}@example.com`));
    const listUsers = mock(() => directory);
    const { root, dom } = setup({ initiallyOpen: true, listUsers });
    await Promise.resolve();
    expect(root.querySelectorAll('[data-switch-user]').length).toBe(20);
    expect(root.querySelector('[data-user-range]')!.textContent).toBe('1–20 of 10,000');
    root.querySelector<HTMLButtonElement>('[data-user-next]')!.click();
    expect(root.querySelector('[data-user-range]')!.textContent).toBe('21–40 of 10,000');
    expect(root.querySelector('[data-switch-user="user-20"]')).not.toBeNull();
    const search = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    search.value = 'user-9999';
    search.dispatchEvent(new dom.window.Event('input'));
    expect(root.querySelectorAll('[data-switch-user]').length).toBe(1);
    expect(root.querySelector('[data-switch-user="user-9999"]')).not.toBeNull();
    expect(root.querySelector('[data-user-next]')).toBeNull();
    expect(listUsers).toHaveBeenCalledTimes(1);
  });

  it('turns the rules bypass on and off from its switch', () => {
    const { root, setLensMock } = setup({ initiallyOpen: true, initialUser: { uid: 'u1' } });
    const bypass = root.querySelector<HTMLButtonElement>('[data-toggle-bypass]')!;
    expect(bypass.getAttribute('role')).toBe('switch');
    expect(bypass.getAttribute('aria-checked')).toBe('false');
    bypass.click();
    expect(setLensMock).toHaveBeenCalledWith({ mode: 'admin' });
    expect(root.querySelector('[data-toggle-bypass]')!.getAttribute('aria-checked')).toBe('true');
    root.querySelector<HTMLButtonElement>('[data-toggle-bypass]')!.click();
    expect(setLensMock).toHaveBeenLastCalledWith(undefined);
    expect(root.querySelector('[data-toggle-bypass]')!.getAttribute('aria-checked')).toBe('false');
  });

  it('offers to create the user nobody in the sandbox answers to', async () => {
    const openCreateUser = mock(() => {});
    const { root } = setup({ initiallyOpen: true, listUsers: () => [user('u1', 'a@example.com')], openCreateUser });
    await Promise.resolve();
    const input = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    input.value = 'zed';
    input.dispatchEvent(new (root.host.ownerDocument.defaultView as typeof globalThis).Event('input'));
    root.querySelector<HTMLButtonElement>('[data-create-user]')!.click();
    expect(openCreateUser).toHaveBeenCalled();
  });

  it('puts a pending worker update first, in the warning colour, with its button in the slot', () => {
    const updateWorker = mock(() => Promise.resolve());
    const { root, runtime } = setup({ initiallyOpen: true });
    runtime.setWorkerUpdater(updateWorker);
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    const first = root.querySelector('.rows .row')!;
    expect(first.getAttribute('data-update-row')).not.toBeNull();
    expect(first.classList.contains('pending')).toBe(true);
    expect(first.querySelector('.s1')!.textContent).toBe('bbbbbbbb');
    expect(root.querySelector('[data-chip-tab="identity"]')!.classList.contains('pending')).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-update-worker]')!.click();
    expect(updateWorker).toHaveBeenCalled();
  });
});

describe('the Sandbox view', () => {
  it('lists the model, the running worker, and the theme, and nothing about running state', () => {
    const { root, showTab, runtime } = setup({ initiallyOpen: true });
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'bbbbbbbbbbbbbbbb' });
    showTab('sandbox');
    expect(texts(root, '[data-ai-row] dt')).toEqual(['Model', 'Routed model']);
    expect(texts(root, '.row .c1')).toEqual(['Worker', 'Theme']);
    expect(root.querySelector('[data-running-epoch]')!.textContent).toBe('bbbbbbbb');
    expect(root.querySelector('[data-theme-row] [data-open-overlay-theme]')).not.toBeNull();
    expect(texts(root, '[data-action-bar] .btn')).toEqual(['Hide']);
  });

  it('reports live host configuration and in-page execution without inventing a pending worker', () => {
    let configuration = { backend: 'Scripted', requestedModel: 'gemini-2.5-flash', route: 'No model invoked' };
    const listeners = new Set<() => void>();
    const { root, showTab, runtime, chip } = setup({ initiallyOpen: true, aiConfiguration: {
      getSnapshot: () => configuration,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    } });
    runtime.setWorker({ mode: 'in-page' });
    showTab('sandbox');
    expect(root.querySelector('[data-ai-requested-row]')!.textContent).toContain('gemini-2.5-flash');
    expect(root.querySelector('[data-ai-route-row]')!.textContent).toContain('No model invoked');
    configuration = { ...configuration, backend: 'OpenAI-compatible', route: 'ornith:9b' };
    for (const listener of listeners) listener();
    expect(root.querySelector('[data-ai-row]')!.textContent).not.toContain('OpenAI-compatible');
    expect(root.querySelector('[data-ai-route-row]')!.textContent).toContain('ornith:9b');
    expect(root.querySelector('[data-runtime-row]')!.textContent).toContain('In-page');
    expect(root.querySelector('[data-worker-row]')).toBeNull();
    chip.dispose();
    expect(listeners.size).toBe(0);
  });

  it('does not infer scripted execution from missing AI configuration', () => {
    const { root, showTab } = setup({ initiallyOpen: true });
    showTab('sandbox');
    expect(root.querySelector('[data-ai-row]')!.textContent).toContain('Not reported');
  });

  it('hides the chip from the page from the bar', () => {
    const { root, showTab, chip } = setup({ initiallyOpen: true });
    showTab('sandbox');
    root.querySelector<HTMLButtonElement>('[data-dismiss-chip]')!.click();
    expect(chip.element.style.display).toBe('none');
  });
});

describe('the Traffic view', () => {
  const request = (id: string, at: number, path: string, result: 'allow' | 'deny', auth: unknown = null): SandboxEvent => ({
    kind: 'request',
    id,
    at,
    service: 'firestore',
    method: 'set',
    path,
    result,
    auth,
  } as unknown as SandboxEvent);

  it('hydrates synchronous history before rendering the initial Traffic view', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    const runtime = createPyricRuntimeStatus(manifest);
    const initialEvents = [request('hydrated', Date.now(), 'conversations/c1', 'deny')];
    const chip = mountPyricRuntimeChip({
      document: dom.window.document,
      runtime,
      initiallyOpen: true,
      sandboxEvents(callback) {
        callback(initialEvents);
        return () => {};
      },
    });
    cleanups.push(() => { chip.dispose(); dom.window.close(); });
    const root = chip.element.shadowRoot;
    expect(root?.querySelector('[data-chip-tab="traffic"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root?.querySelector('[data-request-row="hydrated"]')?.textContent).toContain('Denied');
  });

  it('gives every request the same cells: call and time in column one, path and reason in column two, verdict in the slot', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    push([request('r1', now - 2000, 'conversations/c0', 'allow'), request('r2', now - 1000, 'conversations/c1', 'deny')]);
    showTab('traffic');
    const rows = root.querySelectorAll('[data-request-row]');
    expect(rows.length).toBe(2);
    const denied = rows[0]!;
    expect(denied.getAttribute('data-request-row')).toBe('r2');
    expect(denied.classList.contains('problem')).toBe(true);
    expect(denied.querySelector('.c1')!.textContent).toBe('firestore.set');
    expect(denied.querySelector('.c2')!.textContent).toBe('conversations/c1');
    expect(denied.querySelector('.s1')!.textContent).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(denied.querySelector('.s2')!.textContent).toBe('signed out');
    expect(denied.querySelector('.slot')!.textContent).toBe('Denied');
    const ok = rows[1]!;
    expect(ok.querySelector('.s2')!.textContent).toBe('');
    expect(ok.querySelector('.slot')!.textContent).toBe('Allowed');
  });

  it('drills into the selected request and returns through its breadcrumb', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const path = 'conversations/long-conversation-id/messages/long-message-id';
    push([request('r1', Date.now(), path, 'allow')]);
    showTab('traffic');
    root.querySelector<HTMLButtonElement>('[data-request-row="r1"]')!.click();
    const expanded = root.querySelector<HTMLElement>('[data-traffic-detail]')!;
    expect(root.querySelector('[data-traffic-rows]')).toBeNull();
    expect(expanded.querySelector('.c2')!.textContent).toBe(path);
    expect(root.querySelector('[data-chip-view="traffic"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-request-back]')!.click();
    expect(root.querySelector('[data-traffic-detail]')).toBeNull();
    expect(root.querySelector('[data-request-row="r1"]')).not.toBeNull();
  });

  it('keeps Reason aligned with request facts and preserves open rule details during new activity', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    push([{
      kind: 'request', id: 'original', at: Date.now(), evalMs: 1, method: 'get', path: 'docs/a',
      auth: null, result: 'deny', reasons: [],
      rulesEvidence: {
        version: 'private-debug-id', scope: 'request', decision: 'DENY', truncated: false, paths: [],
        rules: [{ expression: 'false', verdict: 'DENY', checks: [] }],
      },
    }]);
    showTab('traffic');
    root.querySelector<HTMLButtonElement>('[data-request-row="original"]')!.click();
    expect(texts(root, '.request-facts dt')).toContain('Reason');
    expect(root.textContent).not.toContain('private-debug-id');
    const details = root.querySelector<HTMLDetailsElement>('[data-rule-details]')!;
    details.open = true;
    details.querySelector('summary')!.focus();
    push([request('new', Date.now(), 'docs/b', 'allow')]);
    expect(root.querySelector<HTMLDetailsElement>('[data-rule-details]')!.open).toBe(true);
    expect(root.activeElement?.tagName).toBe('SUMMARY');
    expect(root.querySelector('[data-traffic-detail]')!.getAttribute('data-request-row')).toBe('original');
  });

  it('flips the scope, denied and auto-update switches and their effects, and keeps only the view picker in the footer', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    const from = (event: SandboxEvent, caller: EventCaller): SandboxEvent => ({ ...event, caller } as SandboxEvent);
    push([
      from(request('mine', now - 3000, 'notes/mine', 'allow'), { kind: 'page', pageId: 'tab-1' }),
      from(request('tab', now - 2000, 'notes/tab', 'deny'), { kind: 'page', pageId: 'tab-2' }),
    ], { history: true, pageId: 'tab-1' });
    showTab('traffic');
    const control = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!;
    const checked = (selector: string) => control(selector).getAttribute('aria-checked');
    const rowIds = () => [...root.querySelectorAll<HTMLElement>('[data-request-row]')].map((row) => row.dataset.requestRow).sort();
    for (const selector of ['[data-traffic-scope]', '[data-traffic-denied]', '[data-request-pause]']) {
      expect(control(selector).getAttribute('role')).toBe('switch');
      expect(control(selector).closest('[data-action-bar]')).toBeNull();
    }
    const footer = [...root.querySelectorAll<HTMLElement>('[data-action-bar] button')];
    expect(footer.map(button => button.getAttribute('role'))).toEqual(['tab', 'tab']);
    expect(footer.map(button => button.dataset.trafficDisplay)).toEqual(['requests', 'rates']);
    expect(footer.map(button => button.getAttribute('aria-selected'))).toEqual(['true', 'false']);

    expect(checked('[data-traffic-scope]')).toBe('false');
    expect(rowIds()).toEqual(['mine']);
    control('[data-traffic-scope]').click();
    expect(checked('[data-traffic-scope]')).toBe('true');
    expect(rowIds()).toEqual(['mine', 'tab']);

    expect(checked('[data-traffic-denied]')).toBe('false');
    control('[data-traffic-denied]').click();
    expect(checked('[data-traffic-denied]')).toBe('true');
    expect(rowIds()).toEqual(['tab']);
    control('[data-traffic-denied]').click();
    expect(checked('[data-traffic-denied]')).toBe('false');

    expect(checked('[data-request-pause]')).toBe('true');
    control('[data-request-pause]').click();
    expect(checked('[data-request-pause]')).toBe('false');
    push([request('later', Date.now(), 'notes/later', 'allow')]);
    expect(rowIds()).toEqual(['mine', 'tab']);
    control('[data-request-pause]').click();
    expect(checked('[data-request-pause]')).toBe('true');
    expect(rowIds()).toEqual(['later', 'mine', 'tab']);

    control('[data-traffic-scope]').click();
    expect(checked('[data-traffic-scope]')).toBe('false');
    expect(rowIds()).toEqual(['later', 'mine']);
  });

  it('narrows to the denials from its switch, and copies the rows it is showing', async () => {
    const written: string[] = [];
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true, clipboard: { writeText: async (text) => { written.push(text); } } });
    const now = Date.now();
    push([request('r1', now - 2000, 'conversations/c0', 'allow'), request('r2', now - 1000, 'conversations/c1', 'deny', { uid: 'u9' })]);
    showTab('traffic');
    root.querySelector<HTMLButtonElement>('[data-traffic-denied]')!.click();
    expect(root.querySelectorAll('[data-request-row]').length).toBe(1);
    expect(root.querySelector('[data-traffic-denied]')!.getAttribute('aria-checked')).toBe('true');
    root.querySelector<HTMLButtonElement>('[data-copy-traffic]')!.click();
    await Promise.resolve();
    expect(written[0]).toContain('firestore.set  conversations/c1  Denied');
    expect(written[0]).toContain('u9');
  });

  it("lists this page's own requests by default, and every source with its label in the All view", () => {
    const { root, showTab, push, runtime } = setup({ initiallyOpen: true, withSandboxEvents: true });
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    const now = Date.now();
    const from = (event: SandboxEvent, caller: EventCaller): SandboxEvent => ({ ...event, caller } as SandboxEvent);
    push([
      from(request('mine', now - 5000, 'notes/mine', 'allow'), { kind: 'page', pageId: 'tab-1' }),
      from(request('tab', now - 4000, 'notes/tab', 'allow'), { kind: 'page', pageId: 'tab-2' }),
      from(request('server', now - 3000, 'notes/server', 'allow'), { kind: 'node' }),
      from(request('admin', now - 2000, 'notes/admin', 'deny'), { kind: 'admin' }),
      from(request('agent', now - 1000, 'notes/agent', 'allow'), { kind: 'mcp' }),
    ], { history: true, pageId: 'tab-1' });
    showTab('traffic');
    const scope = () => root.querySelector<HTMLButtonElement>('[data-traffic-scope]')!;
    expect(scope().getAttribute('aria-checked')).toBe('false');
    const rowIds = () => [...root.querySelectorAll<HTMLElement>('[data-request-row]')].map((row) => row.dataset.requestRow);
    expect(rowIds()).toEqual(['mine']);
    expect(root.querySelector('[data-traffic-row-source]')).toBeNull();
    expect(root.querySelector('[data-traffic-hosted-note]')).toBeNull();

    scope().click();
    expect(scope().getAttribute('aria-checked')).toBe('true');
    expect(rowIds().sort()).toEqual(['admin', 'agent', 'mine', 'server', 'tab']);
    const sourceOf = (id: string) => root.querySelector<HTMLElement>(`[data-request-row="${id}"] [data-traffic-row-source]`)?.dataset.trafficRowSource;
    expect(sourceOf('mine')).toBe('page');
    expect(sourceOf('tab')).toBe('tab');
    expect(sourceOf('server')).toBe('node');
    expect(sourceOf('admin')).toBe('admin');
    expect(sourceOf('agent')).toBe('mcp');
    const admin = root.querySelector(`[data-request-row="admin"]`)!;
    expect(admin.querySelector('.slot')!.textContent).toBe('Bypassed');
    expect(admin.classList.contains('problem')).toBe(false);
    expect(root.querySelector('[data-traffic-hosted-note]')!.textContent).toContain('pyric sandbox --hosted');

    root.querySelector<HTMLButtonElement>('[data-traffic-denied]')!.click();
    expect(rowIds()).toEqual([]);
  });

  it('marks a call production served apart from the calls the sandbox served', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    const observed = observedCallEvent({
      service: 'firestore', method: 'getDoc', path: 'rooms/r1', at: now - 1000,
      outcome: { status: 'error', code: 'permission-denied' }, account: { uid: 'alice' },
    });
    push([
      request('served', now - 2000, 'rooms/r2', 'allow'),
      { ...observed, caller: { kind: 'page', pageId: 'tab-1' } } as SandboxEvent,
    ], { history: true, pageId: 'tab-1' });
    showTab('traffic');
    const served = root.querySelector(`[data-request-row="served"]`)!;
    expect(served.querySelector('[data-traffic-row-production]')).toBeNull();
    expect(served.querySelector('.slot')!.textContent).toBe('Allowed');
    const row = root.querySelector(`[data-request-row="${observed.id}"]`)!;
    expect(row.querySelector('[data-traffic-row-production]')!.textContent).toBe('Production');
    expect(row.getAttribute('data-traffic-row-call')).toBe('firestore.getDoc');
    expect(row.getAttribute('data-traffic-row-identity')).toBe('alice');
    // The call has the first line to itself; production's mark sits on the second.
    expect(row.querySelector('.c1 [data-traffic-row-production]')).toBeNull();
    expect(row.querySelector('.s2 [data-traffic-row-production]')).not.toBeNull();
    expect(row.querySelector('[data-verdict-production]')!.getAttribute('title')).toBe('Production denied');
    expect(row.querySelector('.slot')!.textContent).toBe('Denied');

    root.querySelector<HTMLButtonElement>(`[data-request-row="${observed.id}"]`)!.click();
    const facts = root.querySelector<HTMLElement>('[data-traffic-detail]')!.textContent!;
    expect(facts).toContain('Served byProduction');
    expect(facts).toContain('Denied in production (permission-denied)');
    expect(facts).toContain('Pyric observed it and did not check it against local rules.');
    // The details name the call by its rules operation; the row keeps the SDK name.
    const methodFact = root.querySelector('[data-traffic-detail] .request-fact');
    expect(methodFact?.querySelector('dd')?.textContent).toBe('get');
  });

  it("gives production's missing index the index badge kind, and another failed-precondition the failed one", () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    const query = { scope: 'collection', filters: [{ field: 'status', op: '==' }], orderBy: [{ field: 'publishedAt', direction: 'desc' }] };
    const listed = (path: string, at: number, message: string): SandboxEvent => ({
      ...observedCallEvent(readObservedCall({
        service: 'firestore', method: 'getDocs', path, at, query, account: { uid: 'alice' },
        outcome: { status: 'error', code: 'failed-precondition', message },
      })),
      caller: { kind: 'page', pageId: 'tab-1' },
    }) as SandboxEvent;
    const missing = listed('posts', now - 2000, 'The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/p/firestore/indexes?create_composite=x');
    const terminated = listed('notes', now - 1000, 'The client has already been terminated.');
    push([missing, terminated], { history: true, pageId: 'tab-1' });
    showTab('traffic');
    const badgeOf = (event: SandboxEvent) => root.querySelector(`[data-request-row="${event.id}"] [data-verdict-production]`)!;
    expect(badgeOf(missing).classList.contains('index-warning')).toBe(true);
    expect(badgeOf(missing).getAttribute('data-verdict-production')).toBe('failed');
    expect(root.querySelector(`[data-request-row="${missing.id}"]`)!.classList.contains('pending')).toBe(true);
    expect(badgeOf(terminated).classList.contains('index-warning')).toBe(false);
    expect(badgeOf(terminated).getAttribute('data-verdict-production')).toBe('failed');
    expect(root.querySelector(`[data-request-row="${terminated.id}"]`)!.classList.contains('problem')).toBe(true);
  });

  it('marks only the production row whose local rules disagree, and opens the rules view from the local trace', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    const trace = (decision: 'ALLOW' | 'DENY') => ({
      version: 'local-rules', scope: 'request', decision, truncated: false,
      rules: [{ expression: 'request.auth != null', verdict: decision, line: 5, path: '/rooms/{room}', checks: [
        { expression: 'request.auth != null', parent: null, operator: '!=', state: 'value', value: decision === 'ALLOW' },
      ] }],
      paths: [{ path: '/rooms/{room}', matched: true, line: 4 }],
    });
    const observedWith = (path: string, at: number, code: string | null, local: unknown): SandboxEvent => {
      const event = observedCallEvent({
        service: 'firestore', method: 'getDoc', path, at,
        outcome: code === null ? { status: 'ok' } : { status: 'error', code }, account: { uid: 'alice' },
      });
      return { ...event, production: { ...event.production, local }, caller: { kind: 'page', pageId: 'tab-1' } } as SandboxEvent;
    };
    const rule = { line: 5, expression: 'request.auth != null' };
    const agreeing = observedWith('rooms/r1', now - 3000, null, { result: 'allow', rule, trace: trace('ALLOW') });
    const drifting = observedWith('rooms/r2', now - 2000, 'permission-denied', { result: 'allow', rule, drift: true, trace: trace('ALLOW') });
    const untraced = observedWith('rooms/r3', now - 1000, null, { result: 'unevaluated', needs: ['stored-document'] });
    push([agreeing, drifting, untraced], { history: true, pageId: 'tab-1' });
    showTab('traffic');
    const rowOf = (event: SandboxEvent) => root.querySelector<HTMLButtonElement>(`[data-request-row="${event.id}"]`)!;
    expect(rowOf(agreeing).querySelector('[data-traffic-row-drift]')).toBeNull();
    expect(rowOf(untraced).querySelector('[data-traffic-row-drift]')).toBeNull();
    expect(rowOf(drifting).querySelector('[data-traffic-row-drift]')).not.toBeNull();
    expect(rowOf(drifting).querySelector('[data-verdict-production="denied"]')).not.toBeNull();

    const openDetail = (event: SandboxEvent) => {
      root.querySelector<HTMLButtonElement>('[data-request-back]')?.click();
      rowOf(event).click();
      const detail = root.querySelector<HTMLElement>('[data-traffic-detail]')!;
      expect(detail.getAttribute('data-request-row')).toBe(event.id);
      return detail;
    };
    for (const traced of [agreeing, drifting]) {
      const detail = openDetail(traced);
      const disclosure = detail.querySelector<HTMLElement>(`[data-rule-details="${traced.id}"]`)!;
      expect(disclosure).not.toBeNull();
      disclosure.querySelector<HTMLElement>('summary')!.click();
      expect(disclosure.querySelector('.rule-expression')!.textContent).toBe('request.auth != null');
    }
    expect(openDetail(untraced).querySelector('[data-rule-details]')).toBeNull();
  });

  it("shows an AI call production served with production's answer and its tokens", () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    const model = 'models/gemini-flash-lite-latest';
    const answered = observedCallEvent({
      service: 'ai', method: 'generateContent', at: now - 2000, durationMs: 80, outcome: { status: 'ok' },
      ai: { model, reportedModel: 'gemini-flash-lite-001', usage: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 } },
    });
    const refused = observedCallEvent({
      service: 'ai', method: 'generateContent', at: now - 1000, durationMs: 20,
      outcome: { status: 'error', code: 'unauthenticated' }, ai: { model },
    });
    push([answered, refused].map(event => ({ ...event, caller: { kind: 'page', pageId: 'tab-1' } }) as SandboxEvent), { history: true, pageId: 'tab-1' });
    showTab('traffic');
    const row = root.querySelector(`[data-request-row="${answered.id}"]`)!;
    expect(row.getAttribute('data-traffic-row-call')).toBe('ai.generateContent');
    expect(row.querySelector('.c2')!.textContent).toBe('Requestedgemini-flash-lite-latestRouted togemini-flash-lite-001');
    expect(row.querySelector('[data-verdict-production]')!.getAttribute('title')).toBe('Production succeeded');
    const failed = root.querySelector(`[data-request-row="${refused.id}"]`)!;
    expect(failed.querySelector('[data-verdict-production]')!.getAttribute('title')).toBe('Production failed');
    expect(failed.querySelector('.c2')!.textContent).toContain('Routed toNot reported');

    root.querySelector<HTMLButtonElement>(`[data-request-row="${answered.id}"]`)!.click();
    const facts = root.querySelector<HTMLElement>('[data-traffic-detail]')!.textContent!;
    expect(facts).toContain('Served byProduction');
    expect(facts).toContain('OutcomeSucceeded in production');
    expect(facts).toContain('Routed togemini-flash-lite-001');
    expect(facts).toContain('Input tokens9');
    expect(facts).toContain('Output tokens2');
    expect(facts).toContain('Response content was not recorded for this request.');

    root.querySelector<HTMLButtonElement>('[data-request-back]')!.click();
    root.querySelector<HTMLButtonElement>(`[data-request-row="${refused.id}"]`)!.click();
    const refusal = root.querySelector<HTMLElement>('[data-traffic-detail]')!.textContent!;
    expect(refusal).toContain('OutcomeFailed in production (unauthenticated)');
  });

  /** Timers the test runs by hand, and a clock that moves with them. */
  function manualTimers() {
    let clock = 0;
    let next = 0;
    const due = new Map<number, { at: number; run: () => void }>();
    return {
      timers: {
        setTimeout: (run: () => void, ms: number) => { next += 1; due.set(next, { at: clock + ms, run }); return next; },
        clearTimeout: (handle: unknown) => { due.delete(handle as number); },
        now: () => clock,
      },
      async advance(ms: number) {
        clock += ms;
        for (const [handle, timer] of [...due]) {
          if (timer.at > clock) continue;
          due.delete(handle);
          timer.run();
        }
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      },
      pending: () => due.size,
    };
  }

  const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

  function liveStatus(billed: { reads: number; writes: number; deliveries: number }, appProjectIds: string[] = ['my-project']) {
    return {
      projectId: appProjectIds.join(', ') || 'my-project',
      configProjectId: 'my-project',
      configSource: '.firebaserc',
      appProjectIds,
      billed,
    };
  }

  /** The header's brand row, by part: "pyric", then the live label, and nothing else. */
  function headerParts(root: ShadowRoot): string[] {
    return [...root.querySelector('.panel-header .brand')!.children].map((child) => child.className);
  }

  /** The collapsed chip's parts after its own text: the live label and nothing else. */
  function collapsedParts(root: ShadowRoot): string[] {
    return [...root.querySelector('[data-expand]')!.children].map((child) => child.className);
  }

  it("shows the host's live label after pyric, and reads the status again after traffic", async () => {
    const clock = manualTimers();
    const statuses = [
      liveStatus({ reads: 0, writes: 0, deliveries: 0 }, []),
      liveStatus({ reads: 1, writes: 1, deliveries: 1 }, ['prod']),
    ];
    let reads = 0;
    const { root, push, runtime, showTab } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => statuses[Math.min(reads++, statuses.length - 1)]!,
    });
    // A sandbox page never asks: only a hosted page can be on a live host.
    expect(reads).toBe(0);
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    expect(reads).toBe(1);
    expect(headerParts(root)).toEqual(['panel-name', 'live-label']);

    const now = Date.now();
    const observed = observedCallEvent({ service: 'firestore', method: 'getDoc', at: now, outcome: { status: 'ok' } });
    push([
      { ...observed, caller: { kind: 'page', pageId: 'tab-1' } } as SandboxEvent,
      request('served', now - 1000, 'rooms/r2', 'allow'),
    ], { history: true, pageId: 'tab-1' });
    await clock.advance(150);
    expect(reads).toBe(2);
    expect(headerParts(root)).toEqual(['panel-name', 'live-label']);

    showTab('traffic');
    const served = root.querySelector('[data-request-row="served"]')!;
    expect(served.querySelector('[data-traffic-row-sandbox]')).not.toBeNull();
    expect(served.querySelector('[data-traffic-row-production]')).toBeNull();
    const production = root.querySelector(`[data-request-row="${observed.id}"]`)!;
    expect(production.querySelector('[data-traffic-row-production]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-request-row="served"]')!.click();
    // The detail opened is the sandbox row's.
    expect(root.querySelector('[data-traffic-detail]')!.getAttribute('data-request-row')).toBe('served');

    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(collapsedParts(root)).toEqual(['live-label']);
  });

  it('scopes Traffic and Rates with a select on a live host in place of the All traffic switch', async () => {
    const clock = manualTimers();
    const now = Date.now();
    const clients = [
      { kind: 'browser' as const, clientId: profileClientId(), label: '/', user: 'u1', lastSeen: now },
      { kind: 'browser' as const, clientId: 'profile-b', label: '/dashboard', user: 'u2', email: 'b@example.com', lastSeen: now },
      { kind: 'node' as const, clientId: 'journey-1', label: 'server.mjs', user: 'u1', lastSeen: now },
    ];
    const { root, push, runtime, showTab } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => ({ ...liveStatus({ reads: 0, writes: 0, deliveries: 0 }), clients }),
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    // A read from this page, profile B, the Node process and Studio, each billed a different number of documents.
    const read = (caller: EventCaller, uid: string | null, documentReads: number, ago: number): SandboxEvent => ({
      ...observedCallEvent({
        service: 'firestore', method: 'getDoc', path: 'rooms/r1', at: now - ago, outcome: { status: 'ok' },
        ...(uid === null ? {} : { account: { uid } }), usage: { documentReads },
      }),
      caller,
    } as SandboxEvent);
    const events = {
      mine: read({ kind: 'page', pageId: 'tab-1', clientId: profileClientId() }, 'u1', 1, 4000),
      b: read({ kind: 'page', pageId: 'tab-b', clientId: 'profile-b' }, 'u2', 2, 3000),
      node: read({ kind: 'node', clientId: 'journey-1' }, 'u1', 4, 2000),
      studio: read({ kind: 'studio' }, null, 8, 1000),
    };
    push(Object.values(events), { history: true, pageId: 'tab-1' });
    await clock.advance(150);
    showTab('traffic');
    const from = () => root.querySelector<HTMLSelectElement>('[data-traffic-from]')!;
    const choose = (select: HTMLSelectElement, value: string) => {
      select.value = value;
      select.dispatchEvent(new root.ownerDocument.defaultView!.Event('change'));
    };
    const rowIds = () => [...root.querySelectorAll<HTMLElement>('[data-request-row]')].map((row) => row.dataset.requestRow).sort();
    const idsOf = (...names: Array<keyof typeof events>) => names.map((name) => events[name].id).sort();
    expect(root.querySelector('[data-traffic-scope]')).toBeNull();
    expect(from().closest('.request-controls')!.querySelector('[data-request-service]')).not.toBeNull();
    expect(from().value).toBe('page');
    expect(rowIds()).toEqual(idsOf('mine'));
    // A live host names this page's rows as this page's, too.
    expect([...root.querySelectorAll<HTMLElement>('[data-traffic-row-source]')].map((source) => source.dataset.trafficRowSource)).toEqual(['page']);

    choose(from(), 'all');
    expect(rowIds()).toEqual(idsOf('mine', 'b', 'node', 'studio'));
    expect(root.querySelectorAll('[data-traffic-row-source]').length).toBe(4);
    choose(from(), 'client:page:profile-b');
    expect(rowIds()).toEqual(idsOf('b'));
    choose(from(), 'client:node:journey-1');
    expect(rowIds()).toEqual(idsOf('node'));
    choose(from(), 'agents');
    expect(rowIds()).toEqual(idsOf('studio'));
    choose(from(), 'user:u1');
    expect(rowIds()).toEqual(idsOf('mine', 'node'));
    choose(from(), 'signed-out');
    expect(rowIds()).toEqual(idsOf('studio'));
    // The select's values name uids, never the email the host listed.
    expect([...from().options].map((option) => option.value).join(' ')).not.toContain('@');

    root.querySelector<HTMLButtonElement>('[data-traffic-display="rates"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-inspect-rates="firestore"]')!.click();
    const reads = (value: string) => {
      choose(root.querySelector<HTMLSelectElement>('[data-rates-from]')!, value);
      return Number(root.querySelector('[data-history-total="reads"]')!.textContent);
    };
    // Rates count every client until the select narrows them.
    expect(root.querySelector<HTMLSelectElement>('[data-rates-from]')!.value).toBe('all');
    expect(reads('all')).toBe(15);
    expect(reads('page')).toBe(1);
    expect(reads('client:page:profile-b')).toBe(2);
    expect(reads('user:u1')).toBe(5);
    expect(reads('agents')).toBe(8);
  });

  it('keeps the All traffic switch and no From select on a sandbox host', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    push([request('mine', Date.now(), 'notes/mine', 'allow')], { history: true, pageId: 'tab-1' });
    showTab('traffic');
    expect(root.querySelector('[data-traffic-scope]')).not.toBeNull();
    expect(root.querySelector('[data-traffic-from]')).toBeNull();
  });

  it("adds nothing to the header or the collapsed chip when the app's Firebase config names another project", async () => {
    const clock = manualTimers();
    const { root, runtime } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => ({ ...liveStatus({ reads: 0, writes: 0, deliveries: 0 }, ['prod']), projectId: 'prod', configProjectId: 'staging' }),
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    expect(headerParts(root)).toEqual(['panel-name', 'live-label']);
    expect(root.querySelector('.panel-header [role="status"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(collapsedParts(root)).toEqual(['live-label']);
  });

  it('keeps the header to pyric and the live label when imports pass through and the project id is long', async () => {
    const clock = manualTimers();
    const projectId = 'live-header-worst-case-project';
    const { root, runtime } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => ({
        ...liveStatus({ reads: 3, writes: 2, deliveries: 7 }, [projectId]),
        configProjectId: 'live-header-staging-project-01',
        passThrough: ['firebase/analytics', 'firebase/functions', 'firebase/performance', 'firebase/remote-config'],
      }),
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    expect(headerParts(root)).toEqual(['panel-name', 'live-label']);
    expect(root.querySelector('.panel-header [role="status"]')).toBeNull();
    expect(root.querySelector('.panel-header .actions [data-open-studio]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('.panel-header .actions [data-collapse]')!.click();
    expect(collapsedParts(root)).toEqual(['live-label']);
  });

  /** A live identity store the test drives: the app's Auth signs in and out through `set`. */
  function fakeLiveIdentity(initial: LiveIdentity | null, recent: LiveIdentity[]) {
    let current = initial;
    const listeners = new Set<(user: LiveIdentity | null) => void>();
    const signOut = mock(async () => { store.set(null); });
    const store = {
      current: () => current,
      recent: () => [...recent],
      subscribe(listener: (user: LiveIdentity | null) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      signOut,
      set(user: LiveIdentity | null) {
        current = user;
        for (const listener of listeners) listener(user);
      },
    };
    return store;
  }

  const ADA: LiveIdentity = { uid: 'prod-ada', email: 'ada@example.com', displayName: 'Ada Lovelace', providerId: 'google.com' };
  const GRACE: LiveIdentity = { uid: 'prod-grace', email: 'grace@example.com', displayName: null, providerId: 'password' };

  it('shows the production user on a live host, with Sign out and the recent users, and none of the sandbox controls', async () => {
    const clock = manualTimers();
    const liveIdentity = fakeLiveIdentity(ADA, [ADA, GRACE]);
    const { root, runtime, showTab } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      listUsers: () => [user('sandbox-user', 'sandbox@example.com')],
      liveStatusTimers: clock.timers,
      liveStatus: async () => liveStatus({ reads: 0, writes: 0, deliveries: 0 }),
      liveIdentity,
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    showTab('identity');
    await settle();
    expect(root.querySelector('[data-live-identity-view]')).not.toBeNull();
    expect(root.querySelector('[data-live-identity]')!.getAttribute('data-live-identity')).toBe('signed-in');
    // The current user is not listed again among the recent ones.
    const recent = [...root.querySelectorAll<HTMLElement>('[data-live-recent-user]')].map((row) => row.dataset.liveRecentUser);
    expect(recent).toEqual(['prod-grace']);
    // The sandbox directory, search, Create user and Bypass rules stay out.
    for (const selector of ['[data-identity-query]', '[data-switch-user]', '[data-create-user]', '[data-toggle-bypass]', '[data-sign-out]']) {
      expect(root.querySelector(selector)).toBeNull();
    }

    root.querySelector<HTMLButtonElement>('[data-live-sign-out]')!.click();
    await settle();
    expect(liveIdentity.signOut).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-live-identity]')!.getAttribute('data-live-identity')).toBe('signed-out');
    expect(root.querySelector('[data-live-sign-out]')).toBeNull();
    expect([...root.querySelectorAll<HTMLElement>('[data-live-recent-user]')].map((row) => row.dataset.liveRecentUser)).toEqual(['prod-ada', 'prod-grace']);

    // The app's own sign-in reaches the tab through the store.
    liveIdentity.set(GRACE);
    await settle();
    expect(root.querySelector('[data-live-identity]')!.getAttribute('data-live-identity')).toBe('signed-in');
  });

  it('shows signed out with no recent users when the app has signed no one in', async () => {
    const clock = manualTimers();
    const { root, runtime, showTab } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => liveStatus({ reads: 0, writes: 0, deliveries: 0 }),
      liveIdentity: fakeLiveIdentity(null, []),
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    showTab('identity');
    expect(root.querySelector('[data-live-identity]')!.getAttribute('data-live-identity')).toBe('signed-out');
    expect(root.querySelectorAll('[data-live-recent-user]').length).toBe(0);
    expect(root.querySelector('[data-live-identity-view] .empty')).not.toBeNull();
  });

  it('keeps the sandbox Identity tab on a sandbox host', async () => {
    const { root, showTab } = setup({ initiallyOpen: true, withSandboxEvents: true, liveIdentity: fakeLiveIdentity(ADA, [ADA]) });
    showTab('identity');
    expect(root.querySelector('[data-live-identity-view]')).toBeNull();
    expect(root.querySelector('[data-identity-query]')).not.toBeNull();
  });

  /** The Live tab's sections, in order, by their data key. */
  function liveSections(root: ShadowRoot): string[] {
    return [...root.querySelectorAll<HTMLElement>('[data-live-section]')].map((section) => section.dataset.liveSection!);
  }

  it('replaces the Sandbox tab body with the Live tab on a live host', async () => {
    const clock = manualTimers();
    const projectId = 'live-tab-project';
    const now = Date.now();
    const clients = [
      { kind: 'node' as const, clientId: 'journey-1', user: 'node-uid', lastSeen: now - 12_000 },
      { kind: 'browser' as const, clientId: profileClientId(), label: '/dashboard', user: 'u1', email: 'ada@example.com', lastSeen: now },
      { kind: 'service-worker' as const, clientId: 'sw-1', user: null, lastSeen: now - 120_000 },
      { kind: 'browser' as const, clientId: 'profile-other', label: '/settings', user: 'u2', email: 'grace@example.com', lastSeen: now - 8_000 },
    ];
    const { root, runtime, showTab, chip } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => ({
        ...liveStatus({ reads: 12, writes: 3, deliveries: 48 }, [projectId]),
        passThrough: ['firebase/database', 'firebase/storage'],
        observed: ['firebase/app', 'firebase/auth'],
        clients,
      }),
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    showTab('sandbox');
    expect(root.querySelector('[data-live-view]')).not.toBeNull();
    expect(root.querySelector('[data-worker-row]')).toBeNull();
    expect(liveSections(root)).toEqual(['project', 'clients', 'coverage', 'billed', 'overlays']);

    const project = root.querySelector<HTMLElement>('[data-live-project]')!;
    expect(project.dataset.liveProject).toBe(projectId);
    const consoleLink = root.querySelector<HTMLAnchorElement>('[data-open-console]')!;
    expect(consoleLink.getAttribute('href')).toContain(`/project/${projectId}/`);
    expect(consoleLink.getAttribute('target')).toBe('_blank');

    // This page first, then each other client the host lists, by kind; this page's profile is not listed twice.
    const listed = [...root.querySelectorAll<HTMLElement>('[data-live-client]')].map((row) => [row.dataset.liveClient, row.dataset.liveClientUser]);
    expect(listed).toEqual([['self', 'ada@example.com'], ['browser', 'grace@example.com'], ['service-worker', ''], ['node', 'node-uid']]);

    const coverage = [...root.querySelectorAll<HTMLElement>('[data-coverage-import]')].map((row) => [row.dataset.coverageImport, row.dataset.coverageState]);
    expect(coverage).toEqual([
      ['firebase/database', 'not-observed'],
      ['firebase/storage', 'not-observed'],
      ['firebase/app', 'observed'],
      ['firebase/auth', 'observed'],
    ]);

    const billed = root.querySelector<HTMLElement>('[data-live-billed]')!;
    expect([billed.dataset.billedReads, billed.dataset.billedWrites, billed.dataset.billedDeliveries]).toEqual(['12', '3', '48']);

    const theme = root.querySelector<HTMLButtonElement>('[data-live-section="overlays"] [data-open-overlay-theme]')!;
    // This page has no listener source, so the editor is disabled as on the Sandbox tab.
    expect(theme.disabled).toBe(true);
    const hide = root.querySelector<HTMLButtonElement>('[data-action-bar] [data-dismiss-chip]')!;
    hide.click();
    expect(chip.element.style.display).toBe('none');
  });

  it('labels the tab differently on a live host and keeps the Sandbox tab on a sandbox host', async () => {
    const clock = manualTimers();
    const live = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => liveStatus({ reads: 0, writes: 0, deliveries: 0 }),
    });
    const sandbox = setup({ initiallyOpen: true, withSandboxEvents: true });
    const sandboxLabel = sandbox.root.querySelector('[data-chip-tab="sandbox"]')!.textContent;
    live.runtime.setWorker({ mode: 'hosted' });
    await settle();
    expect(live.root.querySelector('[data-chip-tab="sandbox"]')!.textContent).not.toBe(sandboxLabel);

    sandbox.showTab('sandbox');
    expect(sandbox.root.querySelector('[data-live-view]')).toBeNull();
    expect(sandbox.root.querySelector('[data-live-section]')).toBeNull();
    expect(sandbox.root.querySelector('[data-worker-row]')).not.toBeNull();
  });

  it('lists only this page, signed out, and no imports when the host reports none', async () => {
    const clock = manualTimers();
    const { root, runtime, showTab } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => liveStatus({ reads: 0, writes: 0, deliveries: 0 }),
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    showTab('sandbox');
    expect(root.querySelectorAll('[data-coverage-import]').length).toBe(0);
    expect([...root.querySelectorAll<HTMLElement>('[data-live-client]')].map((row) => row.dataset.liveClient)).toEqual(['self']);
    expect(root.querySelector<HTMLElement>('[data-live-client="self"]')!.dataset.liveClientUser).toBe('');
  });

  it('reads the live status again after a failed read, until one succeeds', async () => {
    const clock = manualTimers();
    let reads = 0;
    const { root, runtime } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => {
        reads += 1;
        if (reads < 3) throw new Error('host restarting');
        return liveStatus({ reads: 0, writes: 0, deliveries: 0 });
      },
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    expect(root.querySelector('[data-chip-live]')).toBeNull();
    await clock.advance(250);
    await clock.advance(500);
    expect(reads).toBe(3);
    expect(root.querySelector('.panel-header [data-chip-live]')).not.toBeNull();
  });

  it('shows no live line on a hosted sandbox host, and stops reading', async () => {
    const clock = manualTimers();
    let reads = 0;
    const { root, runtime } = setup({
      initiallyOpen: true,
      withSandboxEvents: true,
      liveStatusTimers: clock.timers,
      liveStatus: async () => { reads += 1; return null; },
    });
    runtime.setWorker({ mode: 'hosted' });
    await settle();
    expect(root.querySelector('[data-chip-live]')).toBeNull();
    await clock.advance(10_000);
    expect(reads).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it('leaves out the hosted note when the sandbox is hosted', () => {
    const { root, showTab, push, runtime } = setup({ initiallyOpen: true, withSandboxEvents: true });
    runtime.setWorker({ mode: 'hosted' });
    push([request('mine', Date.now(), 'notes/mine', 'allow')], { history: true, pageId: 'tab-1' });
    showTab('traffic');
    root.querySelector<HTMLButtonElement>('[data-traffic-scope]')!.click();
    expect(root.querySelector('[data-traffic-hosted-note]')).toBeNull();
  });

  it('carries the failures that are not requests from the runtime error feed', () => {
    const { root, showTab, runtime } = setup({ initiallyOpen: true });
    runtime.reportError('worker crashed', 'sandbox');
    showTab('traffic');
    const row = root.querySelector('[data-request-row]')!;
    expect(row.querySelector('.c1')!.textContent).toBe('runtime');
    expect(row.querySelector('.c2')!.textContent).toBe('worker crashed');
    expect(row.querySelector('.slot')!.textContent).toBe('Failed');
  });
});

describe('the Identity view when switching fails', () => {
  const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
  const announced = (root: ShadowRoot) => root.querySelector('.announcer')!.textContent;

  it('names a rejected sign-in in the Switch user section and announces it', async () => {
    const switchUser = mock(async (_uid: string) => { throw new Error('directory unavailable'); });
    const { root } = setup({
      initiallyOpen: true,
      initialUser: { uid: 'u1', email: 'a@example.com' },
      listUsers: () => [user('u1', 'a@example.com'), user('u2', 'bob@example.com')],
      switchUser,
    });
    await flush();
    root.querySelector<HTMLButtonElement>('[data-switch-user="u2"]')!.click();
    await flush();
    const empty = root.querySelector('[data-identity-error]')!;
    expect(empty.textContent).toContain('Could not sign in');
    expect(empty.textContent).toContain('directory unavailable');
    expect(announced(root)).toContain('Could not sign in');
    // The rows stay: the failure adds one message, not a second action zone.
    expect(root.querySelectorAll('[data-switch-user]').length).toBe(1);
  });

  it('names a thrown sign-out and keeps the session shown', async () => {
    const signOut = mock(() => { throw new Error('sign-out refused'); });
    const { root } = setup({
      initiallyOpen: true,
      initialUser: { uid: 'u1', email: 'a@example.com' },
      listUsers: () => [user('u1', 'a@example.com')],
      signOut,
    });
    await flush();
    root.querySelector<HTMLButtonElement>('[data-sign-out]')!.click();
    await flush();
    expect(root.querySelector('[data-identity-error]')!.textContent).toContain('Could not sign out');
    expect(root.querySelector('[data-identity-row] .c1')!.textContent).toBe('a@example.com');
  });

  it('announces the new identity as plain text after a successful switch and sign-out', async () => {
    let current: RuntimeIdentity | null = { uid: 'u1', email: 'a@example.com' };
    const { root } = setup({
      initiallyOpen: true,
      initialUser: current,
      listUsers: () => [user('u1', 'a@example.com'), { uid: 'u2', email: 'bob@example.com', displayName: 'Bob' } as AuthUserRecord],
      getCurrentUser: () => current,
      switchUser: async (uid) => { current = { uid, email: 'bob@example.com', displayName: 'Bob' }; },
      signOut: async () => { current = null; },
    });
    await flush();
    root.querySelector<HTMLButtonElement>('[data-switch-user="u2"]')!.click();
    await flush();
    expect(announced(root)).toContain('Signed in as Bob.');
    expect(root.querySelector('[data-identity-error]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-sign-out]')!.click();
    await flush();
    expect(announced(root)).toContain('Signed out.');
  });
});

describe('Storage traffic by its activity source', () => {
  const APP_BUCKET = 'demo-app.appspot.com';
  // Reads are open; a write of more than one byte is denied.
  const SMALL_WRITES_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read: if true; allow write: if request.resource.size < 2; }
  }
}`;

  /** A sandboxed app with a default bucket, and the chip serving its page with the Data view. */
  function storagePage() {
    const dom = new JSDOM('<!doctype html><body><div id="gallery"><img id="photo"></div></body>', { url: 'http://localhost/' });
    const document = dom.window.document;
    const photo = document.querySelector('#photo')!;
    // React's fiber for the photo, so a render after a result has a region.
    Reflect.set(photo, '__reactFiber$k', { tag: 5, type: 'img', stateNode: photo, return: null, child: null });
    const sandbox = initializeSandbox({});
    const unique = Math.random().toString(36).slice(2, 10);
    getStorageSandbox(sandbox, { dbName: `pyric-chip-storage-${unique}`, rules: SMALL_WRITES_RULES });
    const app = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: APP_BUCKET }, `chip-storage-${unique}`);
    let pushEvents: ((events: readonly SandboxEvent[], batch: { history: boolean }) => void) | null = null;
    const stopEvents = sandbox.onEvent(event => pushEvents?.([event], { history: false }));
    let commit: (() => void) | null = null;
    let delivered: ((listenerId: string) => void) | null = null;
    let changedNodes: unknown[] = [];
    let mode: ListenerMode | null = null;
    const chip = mountPyricRuntimeChip({
      document,
      runtime: createPyricRuntimeStatus(manifest),
      initiallyOpen: true,
      sandboxEvents: (callback) => { pushEvents = callback; return () => { pushEvents = null; }; },
      listeners: (onChange) => (mode = createListenerMode({
        document, onChange, paintStorage: null, attributionEnabled: () => true,
        commits: { available: () => true, reason: () => null, subscribe: (listener) => { commit = listener; return () => { commit = null; }; }, dispose: () => {} },
        flow: {
          subscribeDeliveries: (listener) => { delivered = listener; return () => { delivered = null; }; },
          changedNodes: () => ({ drain: () => changedNodes.splice(0), discard: () => { changedNodes = []; }, stop: () => {} }),
        },
        subscribeEvents: (callback) => { callback([], { history: true }); return () => {}; },
      })),
    });
    cleanups.push(() => { chip.dispose(); stopEvents(); dom.window.close(); });
    const root = chip.element.shadowRoot!;
    return {
      document,
      root,
      storage: getStorage(app),
      mode: () => mode!,
      /** The page renders the photo after an activity's result. */
      rendered: (listenerId: string) => { delivered?.(listenerId); changedNodes = [photo]; commit?.(); },
      showTab: (tab: ChipTab) => root.querySelector<HTMLButtonElement>(`[data-chip-tab="${tab}"]`)!.click(),
    };
  }

  it('lists a Storage row under the activity source that made it', async () => {
    const page = storagePage();
    await uploadBytes(ref(page.storage, 'avatars/alice.png'), new Uint8Array([1]));
    page.showTab('traffic');
    expect(texts(page.root, '[data-request-row] .c2')).toContain(`gs://${APP_BUCKET}/avatars/alice.png`);
    page.showTab('listeners');
    const source = [...page.root.querySelectorAll<HTMLButtonElement>('[data-listener-row]')]
      .find(row => row.textContent?.includes('avatars/alice.png'))!;
    source.click();
    page.root.querySelector<HTMLAnchorElement>('[data-source-traffic]')!.click();
    expect(page.root.querySelector('.breadcrumb-target')!.textContent).toBe(`gs://${APP_BUCKET}/avatars/alice.png`);
    expect(texts(page.root, '[data-request-row] .c2')).toEqual([`gs://${APP_BUCKET}/avatars/alice.png`]);
  });

  it('marks the region a denied upload would have changed', async () => {
    const page = storagePage();
    page.mode().setMode('flow');
    page.mode().setEnabled(true);
    // The page's activity journal is the process's, so this test's object is its own.
    const target = ref(page.storage, 'avatars/bob.png');
    const allowed = uploadBytes(target, new Uint8Array([1]));
    const upload = page.mode().outlines().find(outline => outline.target.endsWith('avatars/bob.png'))!;
    await allowed;
    page.rendered(upload.listenerId);
    await expect(uploadBytes(target, new Uint8Array([1, 2, 3]))).rejects.toThrow();
    const badge = page.document.querySelector('[data-pyric-denials] [data-pyric-listener-badge]');
    expect(badge?.textContent).toBe(`⚠ Write denied — related region: gs://${APP_BUCKET}/avatars/bob.png`);
  });
});
