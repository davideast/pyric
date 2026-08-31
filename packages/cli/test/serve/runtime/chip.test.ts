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
  const clipboard = options.clipboard === null
    ? undefined
    : options.clipboard ?? { writeText };
  const chip = mountPyricRuntimeChip({
    runtime,
    document: dom.window.document,
    ...(!options.useRealClient
      ? {
          getLens: () => currentLens,
          setLens: options.setLens ?? setLensMock,
          subscribeLens: options.subscribeLens ?? subscribeLensMock,
        }
      : {}),
    ...(clipboard ? { clipboard } : {}),
    ...(options.initiallyOpen === undefined ? {} : { initiallyOpen: options.initiallyOpen }),
    ...(options.listUsers ? { listUsers: options.listUsers } : {}),
    ...('studioUrl' in options ? { studioUrl: options.studioUrl } : {}),
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
    setCurrentLens(lens: AuthLens | undefined) {
      currentLens = lens;
      for (const l of listeners) l(lens);
    },
  };
}

describe('PyricRuntimeChip', () => {
  it('is collapsed by default and surfaces errors and worker updates compactly', () => {
    const { runtime, root } = setup();
    expect(root.querySelector('[data-expand]')).not.toBeNull();
    expect(root.textContent).toContain('ready');

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

  it('displays identity badge in collapsed bar when lens is active and omits it when default or app-session', () => {
    const { root, setCurrentLens } = setup({
      initialLens: { mode: 'as', uid: 'alice' },
    });

    const badge = root.querySelector('[data-identity-badge]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('as: alice');

    setCurrentLens({ mode: 'as', uid: 'alice', tenant: 'tenant-1' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('as: alice (tenant-1)');

    setCurrentLens({ mode: 'admin' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('admin');

    setCurrentLens({ mode: 'anon' } as AuthLens);
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('anon');

    setCurrentLens(undefined);
    expect(root.querySelector('[data-identity-badge]')).toBeNull();

    setCurrentLens({ mode: 'app-session' });
    expect(root.querySelector('[data-identity-badge]')).toBeNull();
  });

  it('clicking Impersonate opens dialog inside Shadow Root and focuses first interactive element', () => {
    const { root } = setup({ initiallyOpen: true });
    const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    expect(dialog.hasAttribute('open')).toBe(false);

    impersonateBtn.focus();
    impersonateBtn.click();

    expect(dialog.hasAttribute('open')).toBe(true);
    const closeBtn = dialog.querySelector('[data-close-impersonate]');
    expect(root.activeElement).toBe(closeBtn);
  });

  it('strictly contains keyboard focus within dialog upon Tab and Shift+Tab', () => {
    const { root } = setup({ initiallyOpen: true });
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

    // Focus last element and press Tab -> should cycle to first
    last.focus();
    expect(root.activeElement).toBe(last);
    const tabEvent = new (root.ownerDocument.defaultView!.KeyboardEvent)('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(first);

    // Focus first element and press Shift+Tab -> should cycle to last
    first.focus();
    expect(root.activeElement).toBe(first);
    const shiftTabEvent = new (root.ownerDocument.defaultView!.KeyboardEvent)('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(shiftTabEvent);
    expect(shiftTabEvent.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(last);
  });

  it('submitting impersonation form calls setLens and immediately updates chip visual indicator without reload', () => {
    const { root, setLensMock } = setup({ initiallyOpen: true });
    const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;

    impersonateBtn.click();
    expect(dialog.hasAttribute('open')).toBe(true);

    const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
    asRadio.click();
    asRadio.checked = true;
    const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;
    uidInput.value = 'alice';
    const tenantInput = dialog.querySelector<HTMLInputElement>('[data-input-tenant]')!;
    tenantInput.value = 'tenant-corp';
    const claimsInput = dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!;
    claimsInput.value = '{"role": "lead"}';

    form.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('submit', { bubbles: true, cancelable: true }));

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(setLensMock).toHaveBeenCalledWith({
      mode: 'as',
      uid: 'alice',
      tenant: 'tenant-corp',
      token: { role: 'lead' },
    });

    // Close panel to verify collapsed bar identity badge
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    const badge = root.querySelector('[data-identity-badge]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('as: alice (tenant-corp)');
  });

  it('closing dialog via close button or Escape restores focus to trigger element', () => {
    const { root } = setup({ initiallyOpen: true });
    const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    const closeBtn = dialog.querySelector<HTMLButtonElement>('[data-close-impersonate]')!;

    impersonateBtn.focus();
    impersonateBtn.click();
    expect(dialog.hasAttribute('open')).toBe(true);

    closeBtn.click();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(root.activeElement).toBe(impersonateBtn);

    // Reopen and test Escape
    impersonateBtn.focus();
    impersonateBtn.click();
    expect(dialog.hasAttribute('open')).toBe(true);

    const escEvent = new (root.ownerDocument.defaultView!.KeyboardEvent)('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(escEvent);
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(root.activeElement).toBe(impersonateBtn);
  });

  it('clearing lens removes identity badge and resets to app session', () => {
    const { root, setLensMock } = setup({
      initiallyOpen: true,
      initialLens: { mode: 'as', uid: 'alice' },
    });

    const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    const clearBtn = dialog.querySelector<HTMLButtonElement>('[data-clear-lens]')!;

    impersonateBtn.click();
    expect(dialog.hasAttribute('open')).toBe(true);

    clearBtn.click();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(setLensMock).toHaveBeenCalledWith(undefined);

    // Minimize and verify badge is gone
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.querySelector('[data-identity-badge]')).toBeNull();
  });

  it('reactively updates badge without reload using default client transport', () => {
    setLens(undefined);
    const { root, chip } = setup({ useRealClient: true });
    expect(root.querySelector('[data-identity-badge]')).toBeNull();

    setLens({ mode: 'as', uid: 'charlie' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('as: charlie');

    setLens({ mode: 'admin' });
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('admin');

    setLens(undefined);
    expect(root.querySelector('[data-identity-badge]')).toBeNull();

    chip.dispose();
  });

  it('submitting form with admin mode applies admin lens', () => {
    const { root, setLensMock } = setup({ initiallyOpen: true });
    const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;

    impersonateBtn.click();
    const adminRadio = dialog.querySelector<HTMLInputElement>('input[value="admin"]')!;
    adminRadio.click();
    adminRadio.checked = true;

    form.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('submit', { bubbles: true, cancelable: true }));

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(setLensMock).toHaveBeenCalledWith({ mode: 'admin' });

    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.querySelector('[data-identity-badge]')?.textContent).toBe('admin');
  });

  it('displays form error and blocks submission when custom claims JSON is malformed', () => {
    const { root, setLensMock } = setup({ initiallyOpen: true });
    const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
    const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
    const errorEl = dialog.querySelector<HTMLElement>('[data-dialog-error]')!;

    impersonateBtn.click();
    const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
    asRadio.click();
    asRadio.checked = true;

    dialog.querySelector<HTMLInputElement>('[data-input-uid]')!.value = 'alice';
    dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!.value = '{ not valid json }';

    form.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('submit', { bubbles: true, cancelable: true }));

    expect(dialog.hasAttribute('open')).toBe(true);
    expect(setLensMock).not.toHaveBeenCalled();
    expect(errorEl.style.display).not.toBe('none');
    expect(errorEl.textContent).toContain('Invalid JSON in custom claims');
  });

  it('closes dialog and restores focus when clicking backdrop directly', () => {
    const { root } = setup({ initiallyOpen: true });
    const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;

    impersonateBtn.focus();
    impersonateBtn.click();
    expect(dialog.hasAttribute('open')).toBe(true);

    const clickEvent = new (root.ownerDocument.defaultView!.MouseEvent)('click', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(clickEvent, 'target', { value: dialog });
    dialog.dispatchEvent(clickEvent);

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(root.activeElement).toBe(impersonateBtn);
  });

  it('pre-populates form fields when opening dialog with existing impersonation lens', () => {
    const { root } = setup({
      initiallyOpen: true,
      initialLens: {
        mode: 'as',
        uid: 'dana',
        tenant: 'tenant-42',
        token: { group: 'engineers' },
      },
    });

    const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
    const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;

    impersonateBtn.click();

    const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
    expect(asRadio.checked).toBe(true);

    const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;
    expect(uidInput.value).toBe('dana');

    const tenantInput = dialog.querySelector<HTMLInputElement>('[data-input-tenant]')!;
    expect(tenantInput.value).toBe('tenant-42');

    const claimsInput = dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!;
    expect(claimsInput.value).toContain('"group": "engineers"');
  });

  describe('User Typeahead & Smart Search Combobox', () => {
    const mockUsers: AuthUserRecord[] = [
      {
        uid: 'alice-1',
        email: 'alice@example.com',
        displayName: 'Alice Smith',
        phoneNumber: null,
        photoUrl: null,
        customClaims: { role: 'admin', tenant: 'tenant-alpha' },
        providerUserInfo: [{ providerId: 'google.com' }],
        isAnonymous: false,
        disabled: false,
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00Z',
        lastLoginAt: '2026-01-02T00:00:00Z',
      },
      {
        uid: 'bob-2',
        email: 'bob@example.com',
        displayName: 'Bob Jones',
        phoneNumber: null,
        photoUrl: null,
        customClaims: { role: 'member', tier: 'premium' },
        providerUserInfo: [{ providerId: 'password' }],
        isAnonymous: false,
        disabled: false,
        emailVerified: false,
        createdAt: '2026-01-01T00:00:00Z',
        lastLoginAt: null,
      },
      {
        uid: 'guest-3',
        email: null,
        displayName: null,
        phoneNumber: null,
        photoUrl: null,
        customClaims: {},
        providerUserInfo: [],
        isAnonymous: true,
        disabled: false,
        emailVerified: false,
        createdAt: '2026-01-01T00:00:00Z',
        lastLoginAt: null,
      },
    ];

    it('filters users by name, email, uid, provider, and custom claims', async () => {
      const { root } = setup({
        initiallyOpen: true,
        listUsers: () => Promise.resolve(mockUsers),
      });

      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      impersonateBtn.click();

      // Wait for users to load
      await Promise.resolve();

      const searchInput = dialog.querySelector<HTMLInputElement>('[data-user-search-input]')!;
      const listbox = dialog.querySelector<HTMLUListElement>('[data-user-search-listbox]')!;

      // 1. Search by name "Alice"
      searchInput.value = 'Alice';
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('input'));
      expect(listbox.style.display).toBe('block');
      let items = listbox.querySelectorAll('.user-search-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Alice Smith');

      // 2. Search by provider "provider:password"
      searchInput.value = 'provider:password';
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('input'));
      items = listbox.querySelectorAll('.user-search-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Bob Jones');

      // 3. Search by role "role:admin"
      searchInput.value = 'role:admin';
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('input'));
      items = listbox.querySelectorAll('.user-search-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Alice Smith');

      // 4. Search by claim "tier:premium"
      searchInput.value = 'tier:premium';
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('input'));
      items = listbox.querySelectorAll('.user-search-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Bob Jones');

      // 5. Search by tenant "tenant:tenant-alpha"
      searchInput.value = 'tenant:tenant-alpha';
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('input'));
      items = listbox.querySelectorAll('.user-search-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Alice Smith');

      // 6. Search for anonymous guest
      searchInput.value = 'anonymous';
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('input'));
      items = listbox.querySelectorAll('.user-search-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('guest-3');
    });

    it('selecting a user from dropdown auto-populates UID, tenant, and custom claims', async () => {
      const { root } = setup({
        initiallyOpen: true,
        listUsers: () => Promise.resolve(mockUsers),
      });

      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      impersonateBtn.click();
      await Promise.resolve();

      const searchInput = dialog.querySelector<HTMLInputElement>('[data-user-search-input]')!;
      const listbox = dialog.querySelector<HTMLUListElement>('[data-user-search-listbox]')!;
      const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;
      const tenantInput = dialog.querySelector<HTMLInputElement>('[data-input-tenant]')!;
      const claimsInput = dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!;
      const asRadio = dialog.querySelector<HTMLInputElement>('input[value="as"]')!;
      const selectedUserCard = dialog.querySelector<HTMLElement>('[data-selected-user-card]')!;
      const selectedUserLabel = dialog.querySelector<HTMLElement>('[data-selected-user-label]')!;

      // Search Alice and click
      searchInput.value = 'alice';
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('input'));

      const aliceItem = listbox.querySelector<HTMLElement>('.user-search-item')!;
      aliceItem.click();

      // Form should auto-populate
      expect(uidInput.value).toBe('alice-1');
      expect(tenantInput.value).toBe('tenant-alpha');
      expect(claimsInput.value).toContain('"role": "admin"');
      expect(claimsInput.value).toContain('"tenant": "tenant-alpha"');
      expect(asRadio.checked).toBe(true);

      // Selected user pill should appear
      expect(selectedUserCard.style.display).toBe('flex');
      expect(selectedUserLabel.textContent).toContain('Alice Smith');
      expect(listbox.style.display).toBe('none');

      // Clearing template card clears inputs
      const clearTemplateBtn = dialog.querySelector<HTMLButtonElement>('[data-clear-selected-user]')!;
      clearTemplateBtn.click();
      expect(selectedUserCard.style.display).toBe('none');
      expect(uidInput.value).toBe('');
      expect(tenantInput.value).toBe('');
      expect(claimsInput.value).toBe('');
    });

    it('quick filter chips render and filter candidates by category', async () => {
      const { root } = setup({
        initiallyOpen: true,
        listUsers: () => Promise.resolve(mockUsers),
      });

      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      impersonateBtn.click();
      await Promise.resolve();

      const filterChips = dialog.querySelector<HTMLElement>('[data-filter-chips]')!;
      const listbox = dialog.querySelector<HTMLUListElement>('[data-user-search-listbox]')!;

      expect(filterChips.style.display).toBe('flex');
      const chips = Array.from(filterChips.querySelectorAll<HTMLButtonElement>('.filter-chip'));
      expect(chips.map((c) => c.textContent?.trim())).toContain('Admins');
      expect(chips.map((c) => c.textContent?.trim())).toContain('Tenants');

      // Click Admins chip
      const adminChip = chips.find((c) => c.textContent?.trim() === 'Admins')!;
      adminChip.click();

      expect(listbox.style.display).toBe('block');
      const items = listbox.querySelectorAll('.user-search-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Alice Smith');
    });

    it('keyboard navigation (ArrowDown / Enter) selects candidate and populates fields', async () => {
      const { root } = setup({
        initiallyOpen: true,
        listUsers: () => Promise.resolve(mockUsers),
      });

      const impersonateBtn = root.querySelector<HTMLButtonElement>('[data-open-impersonate]')!;
      const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
      impersonateBtn.click();
      await Promise.resolve();

      const searchInput = dialog.querySelector<HTMLInputElement>('[data-user-search-input]')!;
      const listbox = dialog.querySelector<HTMLUListElement>('[data-user-search-listbox]')!;
      const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;

      // Trigger listbox with ArrowDown
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.KeyboardEvent)('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      }));
      expect(listbox.style.display).toBe('block');

      // ArrowDown to highlight first candidate (Alice)
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.KeyboardEvent)('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      }));

      // Press Enter to select
      searchInput.dispatchEvent(new (root.ownerDocument.defaultView!.KeyboardEvent)('keydown', {
        key: 'Enter',
        bubbles: true,
      }));

      expect(uidInput.value).toBe('alice-1');
      expect(listbox.style.display).toBe('none');
    });
  });
});

