import type {
  PyricRuntimeError,
  PyricRuntimeSnapshot,
  PyricRuntimeStatus,
} from './status.js';
import { getLens as defaultGetLens, setLens as defaultSetLens, subscribeLens as defaultSubscribeLens } from '../worker/client.js';
import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';
import {
  createChipDialogController,
  DIALOG_STYLES,
  type ChipDialogController,
  type ChipDialogUser,
} from './chip-dialog.js';

export interface PyricRuntimeChipOptions {
  runtime: PyricRuntimeStatus;
  document?: Document;
  clipboard?: Pick<Clipboard, 'writeText'>;
  initiallyOpen?: boolean;
  /** Override Studio availability. Omitted uses the runtime manifest URL. */
  studioUrl?: string | null;
  /** Optional auth lens getter override (defaults to worker client getLens). */
  getLens?: () => AuthLens | undefined;
  /** Optional auth lens setter override (defaults to worker client setLens). */
  setLens?: (lens: AuthLens | undefined) => void;
  /** Optional auth lens subscription override (defaults to worker client subscribeLens). */
  subscribeLens?: (listener: (lens: AuthLens | undefined) => void) => () => void;
  /** Optional user directory provider to power the search combobox. */
  listUsers?: () => Promise<AuthUserRecord[]> | AuthUserRecord[];
  /** Authentic client auth user switch callback. */
  switchUser?: (uid: string) => Promise<void> | void;
  /** Authentic client auth sign-out callback. */
  signOut?: () => Promise<void> | void;
  /** Triggers the existing Auth Helper Dialog (<dialog data-pyric-auth>). */
  openCreateUser?: () => void;
  /** Returns the active client user session. */
  getCurrentUser?: () => ChipDialogUser | null;
  /** Subscribes to client auth state transitions (onAuthStateChanged). */
  subscribeAuth?: (listener: (user: ChipDialogUser | null) => void) => () => void;
}

export interface PyricRuntimeChip {
  element: HTMLElement;
  dispose(): void;
}

interface AiEngineDisplay {
  primary: string;
  subline: string | null;
}

function aiEngineState(): AiEngineDisplay {
  const engine = (globalThis as { __PYRIC_AI_ENGINE__?: { kind?: string; model?: string } }).__PYRIC_AI_ENGINE__;
  if (engine?.kind === 'gemini') {
    return {
      primary: 'gemini (production)',
      subline: 'gemini-3.5-flash-lite → gemini-flash-lite-latest',
    };
  }
  if (engine?.kind === 'openai') {
    const modelLabel = engine.model ? ` (${engine.model})` : '';
    return {
      primary: `openai (proxy${modelLabel})`,
      subline: null,
    };
  }
  return {
    primary: 'sandbox (scripted)',
    subline: null,
  };
}

const styles = `
  :host {
    --pyric-bg: #1e1e24;
    --pyric-content: #16161a;
    --pyric-border: #33333f;
    --pyric-border-soft: #2a2a35;
    --pyric-text: #fbfbfe;
    --pyric-muted: #89899f;
    --pyric-accent: #19cc61;
    --pyric-warning: #e6c79c;
    --pyric-error: #f0a0a0;
    all: initial;
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.4;
    color: var(--pyric-text);
  }

  .host {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--pyric-bg);
    border: 1px solid var(--pyric-border);
    border-radius: 999px;
    padding: 4px 10px 4px 12px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, .38);
    cursor: pointer;
    user-select: none;
    transition: border-color 0.15s ease;
  }

  .bar:hover {
    background: #25252d;
    border-color: #4a4a5a;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pyric-accent);
    box-shadow: 0 0 6px rgba(25, 204, 97, 0.5);
  }

  .status-dot.error {
    background: var(--pyric-error);
    box-shadow: 0 0 6px rgba(240, 160, 160, 0.5);
  }

  .bar-title {
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  .bar-badge {
    font-size: 10px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--pyric-muted);
  }

  .bar-badge.identity {
    background: rgba(255, 255, 255, 0.06);
    color: var(--pyric-muted);
    border: 1px solid var(--pyric-border-soft);
    font-family: ui-monospace, monospace;
    font-size: 9.5px;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-badge.admin-bypass {
    background: rgba(230, 199, 156, 0.2);
    color: var(--pyric-warning);
    border: 1px solid var(--pyric-warning);
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .bar-badge.error {
    background: rgba(240, 160, 160, 0.15);
    color: var(--pyric-error);
    border: 1px solid rgba(240, 160, 160, 0.3);
  }

  .bar-toggle {
    color: var(--pyric-muted);
    font-size: 10px;
    margin-left: 2px;
  }

  .panel {
    width: 320px;
    background: var(--pyric-bg);
    border: 1px solid var(--pyric-border);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: slideUp 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--pyric-border-soft);
    background: var(--pyric-content);
  }

  .panel-title {
    font-weight: 600;
    font-size: 12px;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .panel-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .icon-button {
    all: initial;
    color: var(--pyric-muted);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .icon-button:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--pyric-text);
  }

  .panel-body {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .status-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .status-label {
    color: var(--pyric-muted);
    font-size: 11px;
  }

  .status-value {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    font-size: 11px;
  }

  .status-value-sub {
    font-size: 9.5px;
    color: var(--pyric-muted);
  }

  .error-box {
    background: rgba(240, 160, 160, 0.08);
    border: 1px solid rgba(240, 160, 160, 0.25);
    border-radius: 6px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .error-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .error-title {
    color: var(--pyric-error);
    font-weight: 500;
    font-size: 11px;
  }

  .error-list {
    max-height: 120px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
  }

  .error-item {
    color: #ffcccc;
    word-break: break-all;
  }

  .panel-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: var(--pyric-content);
    border-top: 1px solid var(--pyric-border-soft);
  }

  .button {
    align-items: center;
    background: #262630;
    border: 1px solid var(--pyric-border);
    border-radius: 6px;
    color: var(--pyric-muted);
    cursor: pointer;
    display: inline-flex;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    height: 28px;
    justify-content: center;
    line-height: 1;
    padding: 0 10px;
    text-decoration: none;
  }

  .button:hover:not(:disabled) {
    border-color: #3a3a48;
    color: var(--pyric-text);
  }

  .button:disabled {
    cursor: not-allowed;
    opacity: .42;
  }

  .dialog-close {
    all: initial;
    color: var(--pyric-muted);
    font-size: 14px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .dialog-close:hover {
    color: var(--pyric-text);
    background: rgba(255, 255, 255, 0.08);
  }

  ${DIALOG_STYLES}
`;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function mountPyricRuntimeChip(options: PyricRuntimeChipOptions): PyricRuntimeChip {
  const doc = options.document ?? document;
  const existingHost = doc.querySelector<HTMLElement>(
    '[data-pyric-runtime-chip-host], pyric-runtime-chip',
  );
  if (existingHost) {
    existingHost.remove();
  }

  const host = doc.createElement('pyric-runtime-chip');
  host.setAttribute('data-pyric-runtime-chip-host', '');
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = doc.createElement('style');
  styleEl.textContent = styles;
  shadow.appendChild(styleEl);

  const container = doc.createElement('div');
  container.className = 'host';
  shadow.appendChild(container);

  let isOpen = options.initiallyOpen ?? false;
  let currentSnapshot: PyricRuntimeSnapshot = options.runtime.getSnapshot();
  const getLensFn = options.getLens ?? defaultGetLens;
  const setLensFn = options.setLens ?? defaultSetLens;
  const subscribeLensFn = options.subscribeLens ?? defaultSubscribeLens;
  let activeLens: AuthLens | undefined = getLensFn();
  let clientUser: ChipDialogUser | null = options.getCurrentUser ? options.getCurrentUser() : null;

  const dialogController: ChipDialogController = createChipDialogController({
    shadowRoot: shadow,
    listUsers: options.listUsers,
    onSwitchUser: async (uid) => {
      if (options.switchUser) {
        await options.switchUser(uid);
      } else {
        setLensFn({ mode: 'as', uid });
      }
      activeLens = getLensFn();
      clientUser = options.getCurrentUser ? options.getCurrentUser() : null;
      render();
    },
    onSignOut: async () => {
      if (options.signOut) {
        await options.signOut();
      } else {
        setLensFn(undefined);
      }
      activeLens = getLensFn();
      clientUser = options.getCurrentUser ? options.getCurrentUser() : null;
      render();
    },
    onOpenCreateUser: () => {
      if (options.openCreateUser) {
        options.openCreateUser();
      }
    },
    onToggleAdminBypass: (enable) => {
      setLensFn(enable ? { mode: 'admin' } : undefined);
      activeLens = getLensFn();
      render();
    },
    getCurrentUser: () => (options.getCurrentUser ? options.getCurrentUser() : clientUser),
    getLens: () => getLensFn(),
  });

  const render = (): void => {
    const errors = currentSnapshot.errors ?? [];
    const hasError = errors.length > 0;
    const ai = aiEngineState();
    const lens = getLensFn();
    const user = options.getCurrentUser ? options.getCurrentUser() : clientUser;
    const isAdmin = lens?.mode === 'admin';

    let identityBadgeHtml = '';
    if (isAdmin) {
      identityBadgeHtml = '<span class="bar-badge admin-bypass" data-identity-badge>⚡ RULES BYPASS</span>';
    } else if (lens?.mode === 'as') {
      const safeUid = escapeHtml(lens.uid);
      identityBadgeHtml = `<span class="bar-badge identity" data-identity-badge title="as: ${safeUid}">as: ${safeUid}</span>`;
    } else if (user) {
      const safeUid = escapeHtml(user.uid);
      identityBadgeHtml = `<span class="bar-badge identity" data-identity-badge title="as: ${safeUid}">as: ${safeUid}</span>`;
    }

    if (!isOpen) {
      container.innerHTML = `
        <div class="bar" data-toggle-open tabindex="0" role="button" aria-expanded="false">
          <span class="status-dot ${hasError ? 'error' : ''}"></span>
          <span class="bar-title">Pyric</span>
          ${identityBadgeHtml}
          ${hasError ? `<span class="bar-badge error">${errors.length} error${errors.length > 1 ? 's' : ''}</span>` : ''}
          <span class="bar-toggle">▲</span>
        </div>
      `;
    } else {
      const studioAvailable = options.studioUrl !== null;
      container.innerHTML = `
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">
              <span class="status-dot ${hasError ? 'error' : ''}"></span>
              <span>Pyric runtime</span>
            </div>
            <div class="panel-controls">
              <button type="button" class="icon-button" data-toggle-close title="Minimize">▼</button>
              <button type="button" class="icon-button" data-dismiss title="Close chip">✕</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="status-row">
              <span class="status-label">Sandbox</span>
              <div class="status-value">
                <span>In-page sandbox</span>
                ${identityBadgeHtml ? `<div style="margin-top: 4px;">${identityBadgeHtml}</div>` : ''}
              </div>
            </div>
            <div class="status-row">
              <span class="status-label">AI engine</span>
              <div class="status-value">
                <span>${ai.primary}</span>
                ${ai.subline ? `<span class="status-value-sub">${ai.subline}</span>` : ''}
              </div>
            </div>
            ${
              hasError
                ? `
              <div class="error-box">
                <div class="error-header">
                  <span class="error-title">Errors (${errors.length})</span>
                </div>
                <div class="error-list">
                  ${errors.map((e) => `<div class="error-item">${e.message || String(e)}</div>`).join('')}
                </div>
              </div>
            `
                : '<div class="status-label" style="font-style: italic;">No sandbox errors.</div>'
            }
          </div>
          <div class="panel-footer">
            <button type="button" class="button" data-open-impersonate>Identity</button>
            <button
              type="button"
              class="button"
              data-open-studio
              ${!studioAvailable ? 'disabled' : ''}
            >Studio ↗</button>
          </div>
        </div>
      `;
    }

    const openBar = container.querySelector<HTMLElement>('[data-toggle-open]');
    openBar?.addEventListener('click', () => {
      isOpen = true;
      render();
    });
    openBar?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        isOpen = true;
        render();
      }
    });

    const closeBtn = container.querySelector<HTMLElement>('[data-toggle-close]');
    closeBtn?.addEventListener('click', () => {
      isOpen = false;
      render();
    });

    const dismissBtn = container.querySelector<HTMLElement>('[data-dismiss]');
    dismissBtn?.addEventListener('click', () => {
      host.style.display = 'none';
    });

    const impersonateBtn = container.querySelector<HTMLElement>('[data-open-impersonate]');
    impersonateBtn?.addEventListener('click', () => {
      void dialogController.open(impersonateBtn);
    });

    const studioBtn = container.querySelector<HTMLButtonElement>('[data-open-studio]');
    studioBtn?.addEventListener('click', () => {
      const url = options.studioUrl ?? '/__pyric/ui/';
      const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
      win?.open(url, '_blank');
    });

    dialogController.updateState();
  };

  const unsubRuntime = options.runtime.subscribe((snapshot) => {
    currentSnapshot = snapshot;
    render();
  });

  const unsubLens = subscribeLensFn((lens) => {
    activeLens = lens;
    render();
  });

  const unsubAuth = options.subscribeAuth
    ? options.subscribeAuth((user) => {
        clientUser = user;
        render();
      })
    : undefined;

  render();
  doc.body.appendChild(host);

  return {
    element: host,
    dispose() {
      unsubRuntime();
      unsubLens();
      unsubAuth?.();
      dialogController.dispose();
      host.remove();
    },
  };
}
