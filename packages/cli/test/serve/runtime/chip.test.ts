import { JSDOM } from 'jsdom';
import { describe, expect, it, mock } from 'bun:test';
import { mountPyricRuntimeChip, type PyricRuntimeChipOptions } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { AuthLens, SandboxEvent } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';
import type { RuntimeIdentity } from '../../../src/serve/runtime/identity.js';
import type { RuntimeIdentityBindings } from '../../../src/serve/runtime/identity.js';
import type { ChipTab } from '../../../src/serve/runtime/chip-tab.js';

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
  withSandboxEvents?: boolean;
  clipboard?: Pick<Clipboard, 'writeText'>;
  useRealClient?: boolean;
} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const runtime = createPyricRuntimeStatus(manifest);

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
  if (options.initiallyOpen !== undefined) {
    chipOptions.initiallyOpen = options.initiallyOpen;
  }
  if ('studioUrl' in options) {
    chipOptions.studioUrl = options.studioUrl;
  }
  if (options.clipboard) {
    chipOptions.clipboard = options.clipboard;
  }
  let pushEvents: ((events: readonly SandboxEvent[]) => void) | null = null;
  if (options.withSandboxEvents) {
    chipOptions.sandboxEvents = (callback) => {
      pushEvents = callback;
      return () => {
        pushEvents = null;
      };
    };
  }

  const chip = mountPyricRuntimeChip(chipOptions);
  const root = chip.element.shadowRoot!;
  return {
    dom,
    runtime,
    chip,
    root,
    setLensMock,
    push: (events: readonly SandboxEvent[]) => pushEvents?.(events),
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
    expect(texts(root, '[data-chip-tab]')).toEqual(['Identity', 'Listeners', 'Traffic', 'Sandbox']);
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

  it('keeps a disabled Studio button in place when Studio is unavailable', () => {
    const { root } = setup({ initiallyOpen: true, studioUrl: null });
    expect(root.querySelector('[data-open-studio]')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('colours the tab whose view holds the problem, and opens on it', () => {
    const { root, runtime } = setup();
    runtime.reportError('write to conversations denied', 'sandbox');
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.querySelector('[data-chip-view]')!.getAttribute('data-chip-view')).toBe('traffic');
    expect(root.querySelector('[data-chip-tab="traffic"]')!.classList.contains('problem')).toBe(true);
    expect(root.querySelectorAll('.tab.problem, .tab.pending').length).toBe(1);
  });

  it('builds every row of every view from the same cells and keeps controls out of rows', () => {
    const { root, showTab, runtime } = setup({ initiallyOpen: true, initialUser: { uid: 'u1', email: 'a@example.com' } });
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    for (const tab of ['identity', 'listeners', 'traffic', 'sandbox'] as const) {
      showTab(tab);
      for (const row of root.querySelectorAll('.row')) {
        expect(row.querySelector('.c1')).not.toBeNull();
        expect(row.querySelector('.slot')).not.toBeNull();
        // The slot may hold the row's one button; nothing else in the row may.
        expect(row.querySelectorAll('button, a, input').length).toBeLessThanOrEqual(row.querySelectorAll('.slot > .btn').length);
      }
      expect(root.querySelector('[data-action-bar]')).not.toBeNull();
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
    expect(root.querySelector('[data-action-bar] [data-toggle-bypass]')).not.toBeNull();
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

  it('turns the rules bypass on and off from the bar', () => {
    const { root, setLensMock } = setup({ initiallyOpen: true, initialUser: { uid: 'u1' } });
    const bypass = root.querySelector<HTMLButtonElement>('[data-toggle-bypass]')!;
    expect(bypass.getAttribute('aria-pressed')).toBe('false');
    bypass.click();
    expect(setLensMock).toHaveBeenCalledWith({ mode: 'admin' });
    expect(root.querySelector('[data-toggle-bypass]')!.getAttribute('aria-pressed')).toBe('true');
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
    expect(texts(root, '.row .c1')).toEqual(['Model', 'Worker', 'Theme']);
    expect(root.querySelector('[data-running-epoch]')!.textContent).toBe('bbbbbbbb');
    expect(root.querySelector('[data-theme-row] [data-open-overlay-theme]')).not.toBeNull();
    expect(texts(root, '[data-action-bar] .btn')).toEqual(['Hide']);
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
    expect(denied.querySelector('.slot')!.textContent).toBe('denied');
    const ok = rows[1]!;
    expect(ok.querySelector('.s2')!.textContent).toBe('');
    expect(ok.querySelector('.slot')!.textContent).toBe('ok');
  });

  it('narrows to the denials from the bar, and copies the rows it is showing', async () => {
    const written: string[] = [];
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true, clipboard: { writeText: async (text) => { written.push(text); } } });
    const now = Date.now();
    push([request('r1', now - 2000, 'conversations/c0', 'allow'), request('r2', now - 1000, 'conversations/c1', 'deny', { uid: 'u9' })]);
    showTab('traffic');
    root.querySelector<HTMLButtonElement>('[data-traffic-denied]')!.click();
    expect(root.querySelectorAll('[data-request-row]').length).toBe(1);
    expect(root.querySelector('[data-traffic-denied]')!.getAttribute('aria-pressed')).toBe('true');
    root.querySelector<HTMLButtonElement>('[data-copy-traffic]')!.click();
    await Promise.resolve();
    expect(written[0]).toContain('firestore.set  conversations/c1  denied');
    expect(written[0]).toContain('denied for u9');
  });

  it('carries the failures that are not requests from the runtime error feed', () => {
    const { root, showTab, runtime } = setup({ initiallyOpen: true });
    runtime.reportError('worker crashed', 'sandbox');
    showTab('traffic');
    const row = root.querySelector('[data-request-row]')!;
    expect(row.querySelector('.c1')!.textContent).toBe('runtime');
    expect(row.querySelector('.c2')!.textContent).toBe('worker crashed');
    expect(row.querySelector('.slot')!.textContent).toBe('error');
  });
});
