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
    font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px; line-height: 1.45; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
    width: min(440px, 92vw); height: 480px; overflow: hidden; z-index: 2147483647;
  }
  .impersonate-dialog::backdrop { background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(2px); }
  .impersonate-dialog-panel {
    display: flex; flex-direction: column; height: 100%; padding: 20px; box-sizing: border-box; overflow: hidden;
  }
  .impersonate-dialog header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .impersonate-dialog h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .dialog-close {
    align-items: center;
    background: transparent;
    border: 1px solid var(--pyric-border-soft, #2a2a35);
    border-radius: 50%;
    color: var(--pyric-muted, #89899f);
    cursor: pointer;
    display: inline-flex;
    height: 26px;
    width: 26px;
    justify-content: center;
    padding: 0;
    font-size: 11px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    line-height: 1;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .dialog-close:hover {
    border-color: #4a4a58;
    color: var(--pyric-text, #fbfbfe);
    background: rgba(255, 255, 255, 0.05);
  }
  .current-identity-banner {
    display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;
    border-radius: 8px; background: rgba(255, 255, 255, 0.04); border: 1px solid var(--pyric-border-soft, #2a2a35);
    margin-bottom: 12px; gap: 8px; height: 50px; min-height: 50px; max-height: 50px; box-sizing: border-box;
  }
  .current-identity-info { display: flex; align-items: center; gap: 8px; overflow: hidden; }
  .current-identity-text { display: flex; flex-direction: column; overflow: hidden; }
  .current-identity-name { font-weight: 500; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .current-identity-uid { font-size: 10px; color: var(--pyric-muted, #89899f); font-family: "JetBrains Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .section-heading { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pyric-muted, #89899f); margin-bottom: 8px; font-family: "JetBrains Mono", ui-monospace, monospace; font-weight: 600; }
  .user-search-container { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; margin-bottom: 12px; }
  .user-search-box {
    display: flex; align-items: center; gap: 8px; background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--pyric-border-soft, #2a2a35); border-radius: 6px; padding: 6px 10px; box-sizing: border-box;
  }
  .user-search-box:focus-within { border-color: #4a4a58; }
  .user-search-icon { font-size: 13px; color: var(--pyric-muted, #89899f); }
  .user-search-input { all: initial; flex: 1; color: var(--pyric-text, #fbfbfe); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px; }
  .user-search-clear-btn { all: initial; color: var(--pyric-muted, #89899f); font-size: 11px; cursor: pointer; padding: 2px 4px; font-family: "JetBrains Mono", ui-monospace, monospace; }
  .user-search-clear-btn:hover { color: var(--pyric-text, #fbfbfe); }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 5px; min-height: 24px; align-items: center; }
  .filter-chip {
    all: initial; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 10px; font-weight: 500; padding: 3px 8px; border-radius: 12px;
    background: rgba(255, 255, 255, 0.04); border: 1px solid var(--pyric-border-soft, #2a2a35);
    color: var(--pyric-muted, #89899f); cursor: pointer; transition: all 0.15s ease;
  }
  .filter-chip:hover { border-color: var(--pyric-muted, #89899f); color: var(--pyric-text, #fbfbfe); }
  .filter-chip.selected { background: rgba(255, 255, 255, 0.1); border-color: #555566; color: var(--pyric-text, #fbfbfe); }
  .user-search-listbox {
    list-style: none; flex: 1; min-height: 180px; max-height: 180px; overflow-y: auto;
    border: 1px solid var(--pyric-border-soft, #2a2a35); border-radius: 6px; background: #121215;
    padding: 4px; display: flex; flex-direction: column; gap: 3px; box-sizing: border-box; margin: 0;
  }
  .user-search-listbox::-webkit-scrollbar { width: 6px; }
  .user-search-listbox::-webkit-scrollbar-thumb { background: #33333f; border-radius: 3px; }
  .user-search-item {
    display: flex; align-items: center; justify-content: space-between; padding: 6px 8px;
    border-radius: 4px; color: var(--pyric-text, #fbfbfe); font-family: inherit; font-size: 12px;
    cursor: pointer; box-sizing: border-box; transition: background 0.1s ease;
  }
  .user-search-item:hover, .user-search-item.highlighted { background: rgba(255, 255, 255, 0.08); }
  .user-item-main { display: flex; flex-direction: column; overflow: hidden; }
  .user-item-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .user-item-email, .user-item-uid { font-size: 10px; color: var(--pyric-muted, #89899f); font-family: "JetBrains Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .user-item-badges { display: flex; gap: 4px; flex-shrink: 0; }
  .badge { font-size: 9px; font-weight: 500; padding: 1px 5px; border-radius: 4px; text-transform: uppercase; font-family: "JetBrains Mono", ui-monospace, monospace; }
  .badge-provider { background: rgba(255, 255, 255, 0.06); border: 1px solid var(--pyric-border-soft, #2a2a35); color: #b0b0cc; }
  .badge-tenant { background: rgba(100, 160, 255, 0.1); border: 1px solid rgba(100, 160, 255, 0.3); color: #82b1ff; }
  .badge-claims { background: rgba(143, 127, 232, 0.12); border: 1px solid rgba(143, 127, 232, 0.35); color: #8f7fe8; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .user-search-empty {
    display: flex; align-items: center; justify-content: center; height: 100%; width: 100%;
    text-align: center; color: var(--pyric-muted, #89899f); font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px; letter-spacing: 0.02em; padding: 14px; box-sizing: border-box;
  }
  .dialog-footer-actions {
    display: flex; align-items: center; justify-content: space-between;
    border-top: 1px solid var(--pyric-border-soft, #2a2a35); padding-top: 14px; margin-top: auto;
    height: 50px; min-height: 50px; max-height: 50px; box-sizing: border-box;
  }
  .dialog-footer-actions .button,
  .current-identity-banner .button {
    align-items: center; appearance: none; background: #24242c; border: 1px solid #2a2a35;
    border-radius: 6px; color: #fbfbfe; cursor: pointer; display: inline-flex;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px; justify-content: center;
    letter-spacing: .04em; min-height: 32px; padding: 6px 14px; text-decoration: none;
    text-transform: uppercase; transition: border-color 0.12s, color 0.12s, background 0.12s;
    min-width: 120px; box-sizing: border-box; text-align: center;
  }
  .dialog-footer-actions .button:hover:not(:disabled),
  .current-identity-banner .button:hover:not(:disabled) {
    border-color: #3a3a48; background: #2a2a34; color: #ffffff;
  }
  .dialog-footer-actions .button.active,
  .dialog-footer-actions .button[aria-pressed="true"] {
    background: #1e1b2e; border-color: rgba(143, 127, 232, 0.5); color: #8f7fe8; font-weight: 600;
  }
  .dialog-footer-actions .button.active:hover,
  .dialog-footer-actions .button[aria-pressed="true"]:hover {
    background: rgba(143, 127, 232, 0.18); border-color: #8f7fe8; color: #9f91ff;
  }
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

  const dialog = shadowRoot.ownerDocument.createElement('dialog');
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
          <div class="current-identity-text">
            <span class="current-identity-name" data-identity-name>Unauthenticated Guest</span>
            <span class="current-identity-uid" data-identity-uid>No active session</span>
          </div>
        </div>
        <button type="button" class="button" data-action-signout style="display: none;">Sign Out</button>
      </div>

      <div class="section-heading">Switch Sandbox Identity</div>
      <div class="user-search-container" data-user-search-container></div>

      <footer class="dialog-footer-actions">
        <button type="button" class="button" data-action-create-user>New User</button>
        <button type="button" class="button" data-action-toggle-admin>Bypass Rules</button>
      </footer>
    </div>
  `;

  shadowRoot.appendChild(dialog);

  const searchContainer = dialog.querySelector<HTMLElement>('[data-user-search-container]')!;
  const closeButton = dialog.querySelector<HTMLButtonElement>('[data-close-impersonate]')!;
  const identityName = dialog.querySelector<HTMLElement>('[data-identity-name]')!;
  const identityUid = dialog.querySelector<HTMLElement>('[data-identity-uid]')!;
  const signOutBtn = dialog.querySelector<HTMLButtonElement>('[data-action-signout]')!;
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

    identityName.textContent = user
      ? userDisplayLabel(user as AuthUserRecord)
      : 'Unauthenticated Guest';

    if (user) {
      identityUid.textContent = isAdmin ? `${user.uid} · rules bypassed` : user.uid;
      signOutBtn.style.display = 'inline-flex';
    } else {
      identityUid.textContent = isAdmin ? 'No active session · rules bypassed' : 'No active session';
      signOutBtn.style.display = 'none';
    }

    if (isAdmin) {
      toggleAdminBtn.classList.add('active');
      toggleAdminBtn.setAttribute('aria-pressed', 'true');
      toggleAdminBtn.textContent = 'Bypass Active';
    } else {
      toggleAdminBtn.classList.remove('active');
      toggleAdminBtn.setAttribute('aria-pressed', 'false');
      toggleAdminBtn.textContent = 'Bypass Rules';
    }
  };

  const close = (): void => {
    if (dialog.open) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
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
