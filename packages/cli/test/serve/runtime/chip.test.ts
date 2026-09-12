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

describe('the collapsed pill', () => {
  it('is the chip by default and carries errors and worker updates as colour on the name', () => {
    const { runtime, root } = setup();
    expect(root.querySelector('[data-expand]')).not.toBeNull();
    const name = () => root.querySelector('.brand-label')!;
    expect(name().textContent).toBe('pyric');
    expect(name().getAttribute('class')).toBe('brand-label');
    expect(name().getAttribute('title')).toBeNull();

    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(name().classList.contains('warning')).toBe(true);
    expect(name().getAttribute('title')).toBe('New worker available');

    // An error is about the page as it runs, so it takes the name's colour.
    runtime.reportError('write denied', 'sandbox');
    expect(name().classList.contains('error')).toBe(true);
    expect(name().classList.contains('warning')).toBe(false);
    expect(name().getAttribute('title')).toBe('1 error');

    // The chip says all of that without a word of it.
    expect(root.querySelector('.chip')!.textContent).toBe('pyric');
  });

  it('holds only the identity icon, the name, and the listener count', () => {
    const { root } = setup();
    const chip = root.querySelector('.chip')!;
    expect([...chip.children].map((child) => child.getAttribute('class'))).toEqual(['identity', 'brand-label']);
    expect(chip.querySelector('.dot')).toBeNull();
    expect(chip.querySelector('.chevron')).toBeNull();
    expect(chip.querySelector('.signal')).toBeNull();
    expect(chip.querySelector('.signals')).toBeNull();
  });

  it('draws both identity glyphs from one path, the signed-out one stroked', () => {
    const { root, setCurrentLens } = setup();
    const glyph = () => root.querySelector('[data-identity-icon] svg')!;
    const out = glyph();
    const outPath = out.querySelector('path')!.getAttribute('d');
    expect(out.getAttribute('fill')).toBe('none');
    expect(out.getAttribute('stroke-width')).toBe('1.5');

    setCurrentLens({ mode: 'as', uid: 'alice' });
    const filled = glyph();
    expect(filled.querySelector('path')!.getAttribute('d')).toBe(outPath);
    expect(filled.getAttribute('viewBox')).toBe(out.getAttribute('viewBox'));
    expect(filled.getAttribute('fill')).toBe('currentColor');
    expect(filled.getAttribute('stroke')).toBeNull();
  });

  it('switches the identity slot between the session states without text', () => {
    const { root, setCurrentLens } = setup({
      initialLens: { mode: 'as', uid: 'alice' },
    });

    const icon = () => root.querySelector('[data-identity-icon]')!;
    expect(icon().getAttribute('data-state')).toBe('in');
    expect(icon().getAttribute('title')).toBe('alice');

    setCurrentLens({ mode: 'admin' });
    expect(icon().getAttribute('data-state')).toBe('admin');
    expect(icon().getAttribute('title')).toBe('bypass rules');

    setCurrentLens(undefined);
    expect(icon().getAttribute('data-state')).toBe('out');
    expect(icon().getAttribute('title')).toBe('Signed out');
    expect(root.querySelector('.chip')!.textContent).toBe('pyric');
  });

  it('reads the identity slot from the authenticated client user when no lens overrides it', () => {
    let activeUser: RuntimeIdentity | null = { uid: 'sam-uid', displayName: 'Sam Altman' };
    const { root, setCurrentUser } = setup({
      getCurrentUser: () => activeUser,
    });

    expect(root.querySelector('[data-identity-icon]')?.getAttribute('data-state')).toBe('in');
    expect(root.querySelector('[data-identity-icon]')?.getAttribute('title')).toBe('sam-uid');

    activeUser = null;
    setCurrentUser(null);
    expect(root.querySelector('[data-identity-icon]')?.getAttribute('data-state')).toBe('out');
    expect(root.querySelector('[data-identity-icon]')?.getAttribute('title')).toBe('Signed out');
  });

  it('keeps an authenticated session under a rules bypass in the one slot', () => {
    const { root } = setup({
      initialUser: { uid: 'sam-uid' },
      initialLens: { mode: 'admin' },
    });

    const icons = root.querySelectorAll('[data-identity-icon]');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('data-state')).toBe('admin');
    expect(icons[0]?.getAttribute('title')).toBe('bypass rules · sam-uid');
  });

  it('plays the enter animation on the first mount only, and the panel one on each open', () => {
    const { runtime, root } = setup();
    // The chip's arrival belongs to the container, which the renders do not rebuild.
    expect(root.querySelector('[data-view]')?.classList.contains('entering')).toBe(true);
    expect(root.querySelector('.chip')?.classList.contains('entering')).toBe(false);

    // A state change rebuilds the chip; it must not arrive a second time.
    runtime.reportError('write denied', 'sandbox');
    expect(root.querySelector('.chip')?.classList.contains('entering')).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(true);

    // A state change rebuilds the view while it stays open; the panel must not re-enter.
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(root.querySelector('.panel')).not.toBeNull();
    expect(root.querySelector('.panel')?.classList.contains('entering')).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.querySelector('.chip')?.classList.contains('entering')).toBe(false);
  });

  it('moves focus with the collapsed and open controls', () => {
    const { root } = setup();
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.activeElement?.hasAttribute('data-collapse')).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.activeElement?.hasAttribute('data-expand')).toBe(true);
  });

  it('renders hostile identity values as text', () => {
    const maliciousUid = '<script>alert("xss")</script><img data-injected src=x>';
    const { root } = setup({ initialLens: { mode: 'as', uid: maliciousUid } });

    expect(root.querySelector('[data-identity-icon]')?.getAttribute('title')).toContain(maliciousUid);
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('[data-injected]')).toBeNull();
  });

  it('handles rapid lens publications and stops reacting after disposal', () => {
    const { chip, root, setCurrentLens } = setup();
    for (let index = 0; index < 50; index += 1) {
      setCurrentLens({ mode: 'as', uid: `user-${index}` });
      expect(root.querySelector('[data-identity-icon]')?.getAttribute('title')).toContain(`user-${index}`);
    }

    chip.dispose();
    setCurrentLens({ mode: 'as', uid: 'detached-user' });
    expect(root.textContent).not.toContain('detached-user');
  });

  it('reactively updates the identity slot without reload using the default client transport', () => {
    const { root, setCurrentLens } = setup({ initiallyOpen: false });
    expect(root.querySelector('[data-identity-icon]')?.getAttribute('data-state')).toBe('out');

    setCurrentLens({ mode: 'as', uid: 'charlie' });
    expect(root.querySelector('[data-identity-icon]')?.getAttribute('title')).toBe('charlie');

    setCurrentLens(undefined);
    expect(root.querySelector('[data-identity-icon]')?.getAttribute('data-state')).toBe('out');
  });
});

describe('the panel shell', () => {
  it('holds the name, a Studio control, and a minimize control in its header and nothing else', () => {
    const { root } = setup({ initiallyOpen: true });
    const header = root.querySelector('.panel-header')!;
    expect(header.querySelector('.panel-name')?.textContent).toBe('pyric');
    expect(header.querySelector('[data-open-studio]')).not.toBeNull();
    expect(header.querySelector('[data-collapse]')).not.toBeNull();
    // The terminal mark and the dismiss control are both gone from the header;
    // hiding the chip is a Sandbox row now.
    expect(header.querySelector('.brand-mark')).toBeNull();
    expect(header.textContent).not.toContain('>_');
    expect(header.querySelector('[data-dismiss-chip]')).toBeNull();
    expect(root.querySelector('[data-panel-facts]')).toBeNull();
  });

  it('offers four labelled tabs with no counts in them', () => {
    const { root } = setup({ initiallyOpen: true });
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Identity', 'Listeners', 'Traffic', 'Sandbox']);
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
    for (const tab of tabs) expect(/\d/.test(tab.textContent ?? '')).toBe(false);
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });

  it('shows the chosen view and remembers it for the next open', () => {
    const { root, showTab } = setup({ initiallyOpen: true });
    expect(root.querySelector('[data-chip-view]')?.getAttribute('data-chip-view')).toBe('identity');

    showTab('sandbox');
    expect(root.querySelector('[data-chip-view]')?.getAttribute('data-chip-view')).toBe('sandbox');
    expect(root.querySelector('[data-chip-tab="sandbox"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('[data-chip-tab="identity"]')?.getAttribute('aria-selected')).toBe('false');

    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.querySelector('[data-chip-view]')?.getAttribute('data-chip-view')).toBe('sandbox');
  });

  it('points the Studio control at the section the selected tab is about', () => {
    const { root, showTab } = setup({ initiallyOpen: true });
    const href = (): string | null => root.querySelector('[data-open-studio]')!.getAttribute('href');
    expect(href()).toBe('/__pyric/ui/auth/');

    showTab('listeners');
    expect(href()).toBe('/__pyric/ui/traffic/?view=listeners');

    showTab('traffic');
    expect(href()).toBe('/__pyric/ui/traffic/');

    showTab('sandbox');
    expect(href()).toBe('/__pyric/ui/settings/');
  });

  it('keeps a disabled Studio control in place when Studio is unavailable', () => {
    const { root } = setup({ initiallyOpen: true, studioUrl: null });
    const studio = root.querySelector('[data-open-studio]');
    expect(studio?.tagName).toBe('SPAN');
    expect(studio?.getAttribute('aria-disabled')).toBe('true');
  });

  it('colours the tab whose view holds the problem, and leaves a clean strip alone', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    const tab = (id: string): Element => root.querySelector(`[data-chip-tab="${id}"]`)!;
    expect(tab('traffic').classList.contains('problem')).toBe(false);
    expect(tab('sandbox').classList.contains('pending')).toBe(false);

    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(tab('sandbox').classList.contains('pending')).toBe(true);
    expect(tab('traffic').classList.contains('problem')).toBe(false);

    // A failure outranks a waiting worker, and takes the colour with it.
    runtime.reportError('write denied', 'sandbox');
    expect(tab('traffic').classList.contains('problem')).toBe(true);
    expect(tab('sandbox').classList.contains('pending')).toBe(false);
  });

  it('builds every row of every view from the same three cells', () => {
    const { runtime, root, showTab } = setup({ initiallyOpen: true, initialUser: { uid: 'u_8f2a' } });
    runtime.reportError('write denied', 'sandbox');
    for (const view of ['identity', 'traffic', 'sandbox'] as const) {
      showTab(view);
      const rows = [...root.querySelectorAll('.row')];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const cells = [...row.children].map((child) => child.getAttribute('class'));
        expect(cells[0]).toBe('row-mark');
        // A control row's field takes the primary and fact tracks together.
        expect(cells.length === 3 || (cells.length === 2 && cells[1] === 'row-field')).toBe(true);
      }
    }
  });

  it('reattaches the same host after an Astro document swap', () => {
    const { dom, chip, root } = setup({ initiallyOpen: true });
    const host = chip.element;
    const shadowRoot = host.shadowRoot;

    host.remove();
    dom.window.document.dispatchEvent(new dom.window.Event('astro:after-swap'));

    expect(dom.window.document.body.contains(host)).toBe(true);
    expect(host.shadowRoot).toBe(shadowRoot);
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();

    chip.dispose();
    dom.window.document.dispatchEvent(new dom.window.Event('astro:after-swap'));
    expect(dom.window.document.body.contains(host)).toBe(false);
  });
});

describe('the Identity view', () => {
  it('reads Signed out with the outline mark and no action when there is no session', () => {
    const { root } = setup({ initiallyOpen: true });
    const row = root.querySelector('[data-identity-row]')!;
    expect(row.querySelector('.row-primary')?.textContent).toBe('Signed out');
    expect(row.querySelector('[data-panel-identity]')?.getAttribute('data-state')).toBe('out');
    expect(row.querySelector('[data-sign-out]')).toBeNull();
  });

  it('names the session by email, keeps the uid as the fact, and signs out from the row', () => {
    const signOut = mock(() => {});
    const { root } = setup({
      initiallyOpen: true,
      initialUser: { uid: 'u_8f2a', email: 'alice@example.com' },
      signOut,
    });
    const row = root.querySelector('[data-identity-row]')!;
    expect(row.querySelector('.row-primary')?.textContent).toBe('alice@example.com');
    expect(row.querySelector('[data-identity-uid]')?.textContent).toBe('u_8f2a');
    expect(row.querySelector('[data-panel-identity]')?.getAttribute('data-state')).toBe('in');

    row.querySelector<HTMLButtonElement>('[data-sign-out]')!.click();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('falls back to the uid as the primary when the session has no email', () => {
    const { root } = setup({ initiallyOpen: true, initialUser: { uid: 'u_8f2a' } });
    const row = root.querySelector('[data-identity-row]')!;
    expect(row.querySelector('.row-primary')?.textContent).toBe('u_8f2a');
    expect(row.querySelector('[data-identity-uid]')).toBeNull();
  });

  it('turns the rules bypass on and off from its own row', () => {
    const { root, setLensMock } = setup({ initiallyOpen: true });
    const toggle = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-toggle-bypass]')!;
    expect(toggle().textContent).toBe('off');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    toggle().click();
    expect(setLensMock).toHaveBeenCalledWith({ mode: 'admin' });
    expect(toggle().textContent).toBe('on');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    toggle().click();
    expect(setLensMock).toHaveBeenLastCalledWith(undefined);
    expect(toggle().textContent).toBe('off');
  });

  it('filters the sandbox users as one types, and switches to the row that is clicked', async () => {
    const switchUser = mock(() => {});
    const { root } = setup({
      initiallyOpen: true,
      listUsers: () => [user('u_alice', 'alice@example.com'), user('u_bob', 'bob@example.com')],
      switchUser,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelectorAll('[data-switch-user]')).toHaveLength(0);

    const input = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    input.value = 'bob';
    input.dispatchEvent(new root.ownerDocument.defaultView!.Event('input'));

    const matches = [...root.querySelectorAll('[data-switch-user]')];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.querySelector('.row-primary')?.textContent).toBe('bob@example.com');
    (matches[0] as HTMLButtonElement).click();
    expect(switchUser).toHaveBeenCalledWith('u_bob');
  });

  it('keeps the caret in the field across the rebuild each keystroke causes', async () => {
    const { root } = setup({
      initiallyOpen: true,
      listUsers: () => [user('u_alice', 'alice@example.com')],
    });
    await Promise.resolve();
    await Promise.resolve();
    const input = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    input.focus();
    input.value = 'ali';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new root.ownerDocument.defaultView!.Event('input'));

    const after = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    expect(after.value).toBe('ali');
    expect(root.activeElement).toBe(after);
    expect(after.selectionStart).toBe(3);
  });

  it('never prints the uid twice on a candidate the uid is the only name for', async () => {
    const { root } = setup({
      initiallyOpen: true,
      listUsers: () => [user('u_nameless')],
    });
    await Promise.resolve();
    await Promise.resolve();
    const input = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    input.value = 'nameless';
    input.dispatchEvent(new root.ownerDocument.defaultView!.Event('input'));

    const candidate = root.querySelector('[data-switch-user]')!;
    expect(candidate.querySelector('.row-primary')?.textContent).toBe('u_nameless');
    expect(candidate.querySelector('.row-fact')?.textContent).toBe('');
  });

  it('offers to create the user nobody in the sandbox answers to', async () => {
    const openCreateUser = mock(() => {});
    const { root } = setup({
      initiallyOpen: true,
      listUsers: () => [user('u_alice', 'alice@example.com')],
      openCreateUser,
    });
    await Promise.resolve();
    await Promise.resolve();
    const input = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    input.value = 'carol@example.com';
    input.dispatchEvent(new root.ownerDocument.defaultView!.Event('input'));

    const create = root.querySelector<HTMLButtonElement>('[data-create-user]')!;
    expect(create.querySelector('.row-primary')?.textContent).toBe('carol@example.com');
    create.click();
    expect(openCreateUser).toHaveBeenCalledTimes(1);
  });

  it('asks for the user directory only once the view that lists it is up', async () => {
    const listUsers = mock(() => [user('u_alice')]);
    const { root, showTab } = setup({ initiallyOpen: true, listUsers });
    await Promise.resolve();
    expect(listUsers).toHaveBeenCalledTimes(1);

    showTab('sandbox');
    showTab('identity');
    await Promise.resolve();
    expect(listUsers).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-identity-query]')).not.toBeNull();
  });

  it('never lists a disabled account as something the page could run as', async () => {
    const { root } = setup({
      initiallyOpen: true,
      listUsers: () => [
        { uid: 'u_gone', email: 'gone@example.com', disabled: true } as AuthUserRecord,
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    const input = root.querySelector<HTMLInputElement>('[data-identity-query]')!;
    input.value = 'gone';
    input.dispatchEvent(new root.ownerDocument.defaultView!.Event('input'));

    expect(root.querySelectorAll('[data-switch-user]')).toHaveLength(0);
    expect(root.querySelector('[data-create-user]')).not.toBeNull();
  });
});

describe('the Sandbox view', () => {
  it('states which runtime is running and the epoch it is running', () => {
    const { runtime, root, showTab } = setup({ initiallyOpen: true });
    runtime.setWorker({ mode: 'in-page', runningEpoch: '3f2a9c1e0000' });
    showTab('sandbox');

    const row = root.querySelector('[data-runtime-row]')!;
    expect(row.querySelector('.row-primary')?.textContent).toBe('in-page · running');
    expect(row.querySelector('[data-running-epoch]')?.textContent).toBe('3f2a9c1e');
  });

  it('carries the AI engine as the row fact, with the model mapping as its title', () => {
    const { root, showTab } = setup({ initiallyOpen: true });
    showTab('sandbox');
    const row = root.querySelector('[data-ai-row]')!;
    expect(row.querySelector('.row-fact')?.textContent).toBe('sandbox (scripted)');
  });

  it('shows the update row only while an update is pending, with both epochs before the action', async () => {
    const { runtime, root, showTab } = setup({ initiallyOpen: true });
    showTab('sandbox');
    expect(root.querySelector('[data-update-worker]')).toBeNull();

    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(root.querySelector('[data-worker-epochs]')?.textContent).toBe('aaaaaaaa → bbbbbbbb');

    const update = mock(() => Promise.resolve());
    runtime.setWorkerUpdater(update);
    const button = root.querySelector<HTMLButtonElement>('[data-update-worker]')!;
    button.focus();
    button.click();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    expect(root.activeElement?.hasAttribute('data-update-worker')).toBe(true);
  });

  it('hides the chip from the page from its own row', () => {
    const { root, chip, showTab } = setup({ initiallyOpen: true });
    showTab('sandbox');
    expect(chip.element.style.display).not.toBe('none');

    root.querySelector<HTMLButtonElement>('[data-dismiss-chip]')!.click();
    expect(chip.element.style.display).toBe('none');
  });

  it('keeps the focused row control across runtime publications', () => {
    const { runtime, root, showTab } = setup({ initiallyOpen: true });
    showTab('sandbox');
    const announcer = root.querySelector('.announcer');
    root.querySelector<HTMLButtonElement>('[data-open-overlay-theme]')!.focus();

    runtime.reportError('a new sandbox error', 'sandbox');

    expect(root.activeElement?.hasAttribute('data-open-overlay-theme')).toBe(true);
    expect(root.querySelector('.announcer')).toBe(announcer);
    expect(announcer?.textContent).toContain('1 runtime error');
  });
});

describe('the Traffic view', () => {
  const request = (id: string, at: number, path: string, result: 'allow' | 'deny'): SandboxEvent => ({
    kind: 'request',
    id,
    at,
    evalMs: 1,
    method: 'set',
    path,
    auth: null,
    result,
    reasons: [],
  } as unknown as SandboxEvent);

  it('lists the requests the page made, newest first, with the verdict as the fact', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    push([
      request('r1', now - 4000, 'conversations/c1', 'allow'),
      request('r2', now - 2000, 'conversations/c2', 'allow'),
    ]);
    showTab('traffic');

    const rows = [...root.querySelectorAll('[data-request-row]')];
    expect(rows.map((row) => row.getAttribute('data-request-row'))).toEqual(['r2', 'r1']);
    expect(rows[0]?.querySelector('.row-fact')?.textContent).toBe('ok');
    expect(rows[0]?.querySelector('.row-primary')?.textContent).toContain('firestore.set');
    expect(rows[0]?.querySelector('.row-primary')?.textContent).toContain('conversations/c2');
  });

  it('puts a denial from the last minute first and colours its row', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    push([
      request('denied', now - 30_000, 'conversations/c1', 'deny'),
      request('later', now - 1000, 'conversations/c2', 'allow'),
    ]);
    showTab('traffic');

    const rows = [...root.querySelectorAll('[data-request-row]')];
    expect(rows[0]?.getAttribute('data-request-row')).toBe('denied');
    expect(rows[0]?.querySelector('.row-fact')?.textContent).toBe('denied');
    expect(rows[0]?.classList.contains('problem')).toBe(true);
    expect(rows[1]?.classList.contains('problem')).toBe(false);
  });

  it('opens the request it stands for in Studio', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    push([request('r1', Date.now(), 'conversations/c1', 'allow')]);
    showTab('traffic');
    const row = root.querySelector('[data-request-row]')!;
    expect(row.tagName).toBe('A');
    expect(row.getAttribute('href')).toBe('/__pyric/ui/traffic/?request=r1');
  });

  it('carries the failures that are not requests from the runtime error feed', () => {
    const { runtime, root, showTab } = setup({ initiallyOpen: true });
    runtime.reportError('listener failed', 'sandbox');
    showTab('traffic');

    const rows = [...root.querySelectorAll('[data-request-row]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('.row-fact')?.textContent).toBe('error');
    expect(rows[0]?.classList.contains('problem')).toBe(true);
  });

  it('names a failure by its message when it names no call at all', () => {
    const { runtime, root, showTab } = setup({ initiallyOpen: true });
    runtime.reportError('the worker closed the port', 'runtime');
    showTab('traffic');

    const row = root.querySelector('[data-request-row]')!;
    expect(row.querySelector('.row-primary')?.textContent).toContain('the worker closed the port');
    expect(row.querySelector('.row-primary')?.textContent).not.toContain('undefined');
  });

  it('keeps one row for an operation both the request stream and the error feed reported', () => {
    const { runtime, root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const denial = request('shared-id', Date.now(), 'conversations/c1', 'deny');
    push([denial]);
    runtime.recordSandboxEvents([denial]);
    showTab('traffic');

    expect(root.querySelectorAll('[data-request-row]')).toHaveLength(1);
  });

  it('never draws more than eight rows', () => {
    const { root, showTab, push } = setup({ initiallyOpen: true, withSandboxEvents: true });
    const now = Date.now();
    push(Array.from({ length: 20 }, (_, index) => request(`r${index}`, now - index * 100, `c/${index}`, 'allow')));
    showTab('traffic');

    expect(root.querySelectorAll('[data-request-row]')).toHaveLength(8);
  });
});
