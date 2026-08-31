import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';
import {
  createUserSearchController,
  userDisplayLabel,
  type UserSearchController,
} from './chip-user-search.js';

export interface ChipDialogUser {
  uid: string;
  email?: string | null;
  displayName?: string | null;
}

export interface ChipDialogOptions {
  shadowRoot: ShadowRoot;
  listUsers?: () => Promise<AuthUserRecord[]> | AuthUserRecord[];
  onSwitchUser: (uid: string) => Promise<void> | void;
  onSignOut: () => Promise<void> | void;
  onOpenCreateUser: () => void;
  onToggleAdminBypass: (enable: boolean) => void;
  getCurrentUser: () => ChipDialogUser | null;
  getLens: () => AuthLens | undefined;
}

export interface ChipDialogController {
  element: HTMLDialogElement;
  open(triggerElement?: HTMLElement): Promise<void>;
  close(): void;
  updateState(): void;
  dispose(): void;
}

export const DIALOG_STYLES = `
  .impersonate-dialog:not([open]) {
    display: none !important;
  }
  .impersonate-dialog {
    all: initial; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    margin: 0; padding: 0; border: 1px solid var(--pyric-border, #33333f); border-radius: 12px;
    background: var(--pyric-content, #16161a); color: var(--pyric-text, #fbfbfe);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; line-height: 1.45; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
    width: min(460px, 92vw); max-height: 88vh; overflow: hidden; z-index: 2147483647;
  }
  .impersonate-dialog::backdrop { background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(2px); }
  .impersonate-dialog-panel { display: flex; flex-direction: column; max-height: 88vh; overflow-y: auto; padding: 20px; box-sizing: border-box; }
  .impersonate-dialog header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .impersonate-dialog h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .current-identity-banner {
    display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;
    border-radius: 8px; background: rgba(255, 255, 255, 0.04); border: 1px solid var(--pyric-border-soft, #2a2a35);
    margin-bottom: 14px; gap: 8px;
  }
  .current-identity-info { display: flex; align-items: center; gap: 8px; overflow: hidden; }
  .identity-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .identity-status-dot.online { background: var(--pyric-accent, #19cc61); box-shadow: 0 0 6px rgba(25, 204, 97, 0.4); }
  .identity-status-dot.offline { background: var(--pyric-muted, #89899f); }
  .current-identity-text { display: flex; flex-direction: column; overflow: hidden; }
  .current-identity-name { font-weight: 500; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .current-identity-uid { font-size: 10px; color: var(--pyric-muted, #89899f); font-family: ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btn-signout {
    padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(240, 160, 160, 0.3);
    background: rgba(240, 160, 160, 0.08); color: var(--pyric-error, #f0a0a0); font-size: 11px;
    cursor: pointer; white-space: nowrap; transition: all 0.15s ease;
  }
  .btn-signout:hover { background: rgba(240, 160, 160, 0.2); border-color: var(--pyric-error, #f0a0a0); }
  .admin-bypass-banner {
    display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;
    border-radius: 8px; background: rgba(230, 199, 156, 0.12); border: 1px solid rgba(230, 199, 156, 0.4);
    color: var(--pyric-warning, #e6c79c); margin-bottom: 14px; font-size: 11px;
  }
  .admin-bypass-toggle {
    cursor: pointer; font-weight: 600; padding: 3px 8px; border-radius: 4px;
    background: rgba(230, 199, 156, 0.2); border: 1px solid var(--pyric-warning, #e6c79c); color: #fff; font-size: 10px;
  }
  .section-heading { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--pyric-muted, #89899f); margin-bottom: 8px; font-weight: 600; }
  .user-search-container { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .user-search-box {
    display: flex; align-items: center; gap: 8px; background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--pyric-border-soft, #2a2a35); border-radius: 8px; padding: 6px 10px; box-sizing: border-box;
  }
  .user-search-box:focus-within { border-color: #4a4a58; }
  .user-search-icon { font-size: 14px; color: var(--pyric-muted, #89899f); }
  .user-search-input { all: initial; flex: 1; color: var(--pyric-text, #fbfbfe); font-family: inherit; font-size: 12px; }
  .user-search-clear-btn { all: initial; color: var(--pyric-muted, #89899f); font-size: 12px; cursor: pointer; padding: 2px 4px; }
  .user-search-clear-btn:hover { color: var(--pyric-text, #fbfbfe); }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .filter-chip {
    all: initial; font-family: inherit; font-size: 10px; font-weight: 500; padding: 3px 8px; border-radius: 12px;
    background: rgba(255, 255, 255, 0.04); border: 1px solid var(--pyric-border-soft, #2a2a35);
    color: var(--pyric-muted, #89899f); cursor: pointer; transition: all 0.15s ease;
  }
  .filter-chip:hover { border-color: var(--pyric-muted, #89899f); color: var(--pyric-text, #fbfbfe); }
  .filter-chip.selected { background: rgba(255, 255, 255, 0.1); border-color: #555566; color: var(--pyric-text, #fbfbfe); }
  .user-search-listbox {
    all: initial; list-style: none; max-height: 180px; overflow-y: auto;
    border: 1px solid var(--pyric-border-soft, #2a2a35); border-radius: 8px; background: #121215;
    padding: 4px; display: flex; flex-direction: column; gap: 3px; box-sizing: border-box;
  }
  .user-search-item {
    all: initial; display: flex; align-items: center; justify-content: space-between; padding: 6px 8px;
    border-radius: 6px; color: var(--pyric-text, #fbfbfe); font-family: inherit; font-size: 12px;
    cursor: pointer; box-sizing: border-box; transition: background 0.1s ease;
  }
  .user-search-item:hover, .user-search-item.highlighted { background: rgba(255, 255, 255, 0.08); }
  .user-item-main { display: flex; flex-direction: column; overflow: hidden; }
  .user-item-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .user-item-email, .user-item-uid { font-size: 10px; color: var(--pyric-muted, #89899f); font-family: ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .user-item-badges { display: flex; gap: 4px; flex-shrink: 0; }
  .badge { font-size: 9px; font-weight: 500; padding: 1px 5px; border-radius: 4px; text-transform: uppercase; }
  .badge-provider { background: rgba(255, 255, 255, 0.06); border: 1px solid var(--pyric-border-soft, #2a2a35); color: #b0b0cc; }
  .badge-tenant { background: rgba(100, 160, 255, 0.1); border: 1px solid rgba(100, 160, 255, 0.3); color: #82b1ff; }
  .badge-claims { background: rgba(230, 199, 156, 0.1); border: 1px solid rgba(230, 199, 156, 0.3); color: var(--pyric-warning, #e6c79c); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .user-search-empty { all: initial; display: block; padding: 14px; text-align: center; color: var(--pyric-muted, #89899f); font-family: inherit; font-size: 11px; }
  .dialog-footer-actions { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--pyric-border-soft, #2a2a35); padding-top: 14px; margin-top: 6px; }
  .btn-create-user {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px;
    border: 1px dashed var(--pyric-border, #33333f); background: rgba(255, 255, 255, 0.04);
    color: var(--pyric-text, #fbfbfe); font-size: 11px; font-weight: 500; cursor: pointer; transition: all 0.15s ease;
  }
  .btn-create-user:hover { background: rgba(255, 255, 255, 0.08); border-color: #4a4a58; }
  .btn-admin-bypass {
    padding: 6px 10px; border-radius: 6px; border: 1px solid var(--pyric-border-soft, #2a2a35);
    background: transparent; color: var(--pyric-muted, #89899f); font-size: 11px; cursor: pointer; transition: all 0.15s ease;
  }
  .btn-admin-bypass:hover { color: var(--pyric-warning, #e6c79c); border-color: var(--pyric-warning, #e6c79c); }
  .btn-admin-bypass.active { background: rgba(230, 199, 156, 0.15); border-color: var(--pyric-warning, #e6c79c); color: var(--pyric-warning, #e6c79c); font-weight: 600; }
`;

export function createChipDialogController(options: ChipDialogOptions): ChipDialogController {
  const {
    shadowRoot,
    listUsers,
    onSwitchUser,
    onSignOut,
    onOpenCreateUser,
    onToggleAdminBypass,
    getCurrentUser,
    getLens,
  } = options;

  const dialog = document.createElement('dialog');
  dialog.className = 'impersonate-dialog';
  dialog.setAttribute('data-impersonate-dialog', '');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-labelledby', 'dialog-identity-title');

  dialog.innerHTML = `
    <div class="impersonate-dialog-panel">
      <header>
        <h2 id="dialog-identity-title">Identity & Permissions</h2>
        <button type="button" class="dialog-close" data-close-impersonate aria-label="Close dialog">✕</button>
      </header>

      <div class="current-identity-banner" data-current-identity-banner>
        <div class="current-identity-info">
          <span class="identity-status-dot offline" data-identity-dot></span>
          <div class="current-identity-text">
            <span class="current-identity-name" data-identity-name>Unauthenticated Guest</span>
            <span class="current-identity-uid" data-identity-uid>No active session</span>
          </div>
        </div>
        <button type="button" class="btn-signout" data-action-signout style="display: none;">Sign Out</button>
      </div>

      <div class="admin-bypass-banner" data-admin-banner style="display: none;">
        <span>⚡ <strong>RULES BYPASS ACTIVE</strong> (Firebase Admin SDK)</span>
        <button type="button" class="admin-bypass-toggle" data-admin-disable>Disable</button>
      </div>

      <div class="section-heading">Switch Sandbox Identity</div>
      <div class="user-search-container" data-user-search-container></div>

      <footer class="dialog-footer-actions">
        <button type="button" class="btn-create-user" data-action-create-user>
          <span>+</span> Create New User
        </button>
        <button type="button" class="btn-admin-bypass" data-action-toggle-admin>
          ⚡ Rules Bypass
        </button>
      </footer>
    </div>
  `;

  shadowRoot.appendChild(dialog);

  const searchContainer = dialog.querySelector<HTMLElement>('[data-user-search-container]')!;
  const closeButton = dialog.querySelector<HTMLButtonElement>('[data-close-impersonate]')!;
  const identityDot = dialog.querySelector<HTMLElement>('[data-identity-dot]')!;
  const identityName = dialog.querySelector<HTMLElement>('[data-identity-name]')!;
  const identityUid = dialog.querySelector<HTMLElement>('[data-identity-uid]')!;
  const signOutBtn = dialog.querySelector<HTMLButtonElement>('[data-action-signout]')!;
  const adminBanner = dialog.querySelector<HTMLElement>('[data-admin-banner]')!;
  const adminDisableBtn = dialog.querySelector<HTMLButtonElement>('[data-admin-disable]')!;
  const createUserBtn = dialog.querySelector<HTMLButtonElement>('[data-action-create-user]')!;
  const toggleAdminBtn = dialog.querySelector<HTMLButtonElement>('[data-action-toggle-admin]')!;

  let recordedTriggerSelector: string | null = null;
  let recordedTriggerNode: HTMLElement | null = null;

  const searchController: UserSearchController = createUserSearchController({
    container: searchContainer,
    onSelect: async (user) => {
      await onSwitchUser(user.uid);
      close();
    },
  });

  const updateState = (): void => {
    const user = getCurrentUser();
    const lens = getLens();
    const isAdmin = lens?.mode === 'admin';

    if (user) {
      identityDot.className = 'identity-status-dot online';
      identityName.textContent = userDisplayLabel(user as AuthUserRecord);
      identityUid.textContent = user.uid;
      signOutBtn.style.display = 'inline-block';
    } else {
      identityDot.className = 'identity-status-dot offline';
      identityName.textContent = 'Unauthenticated Guest';
      identityUid.textContent = 'No active session';
      signOutBtn.style.display = 'none';
    }

    if (isAdmin) {
      adminBanner.style.display = 'flex';
      toggleAdminBtn.classList.add('active');
      toggleAdminBtn.textContent = '⚡ Bypass Active';
    } else {
      adminBanner.style.display = 'none';
      toggleAdminBtn.classList.remove('active');
      toggleAdminBtn.textContent = '⚡ Rules Bypass';
    }
  };

  const close = (): void => {
    if (dialog.open) {
      dialog.close();
    }
    searchController.reset();

    // Focus restoration: re-query the trigger element freshly in shadowRoot
    // to avoid focusing a detached node if the chip re-rendered.
    const liveTrigger = recordedTriggerSelector
      ? shadowRoot.querySelector<HTMLElement>(recordedTriggerSelector)
      : recordedTriggerNode;

    if (liveTrigger && typeof liveTrigger.focus === 'function' && liveTrigger.isConnected) {
      liveTrigger.focus();
    }
  };

  const open = async (triggerElement?: HTMLElement): Promise<void> => {
    if (triggerElement) {
      recordedTriggerNode = triggerElement;
      if (triggerElement.dataset.openImpersonate !== undefined) {
        recordedTriggerSelector = '[data-open-impersonate]';
      } else if (triggerElement.id) {
        recordedTriggerSelector = `#${triggerElement.id}`;
      } else {
        recordedTriggerSelector = null;
      }
    }

    updateState();
    searchController.reset();

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }

    if (listUsers) {
      try {
        const users = await listUsers();
        searchController.setUsers(users);
      } catch {
        searchController.setUsers([]);
      }
    }

    searchController.focus();
  };

  closeButton.addEventListener('click', () => close());

  dialog.addEventListener('click', (e: MouseEvent) => {
    if (e.target === dialog) {
      close();
    }
  });

  dialog.addEventListener('cancel', (e: Event) => {
    e.preventDefault();
    close();
  });

  dialog.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }

    if (e.key === 'Tab') {
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);

      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey && shadowRoot.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && shadowRoot.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  signOutBtn.addEventListener('click', async () => {
    await onSignOut();
    updateState();
    close();
  });

  adminDisableBtn.addEventListener('click', () => {
    onToggleAdminBypass(false);
    updateState();
  });

  toggleAdminBtn.addEventListener('click', () => {
    const lens = getLens();
    const isAdmin = lens?.mode === 'admin';
    onToggleAdminBypass(!isAdmin);
    updateState();
  });

  createUserBtn.addEventListener('click', () => {
    close();
    onOpenCreateUser();
  });

  return {
    element: dialog,
    open,
    close,
    updateState,
    dispose() {
      searchController.dispose?.();
      dialog.remove();
    },
  };
}
