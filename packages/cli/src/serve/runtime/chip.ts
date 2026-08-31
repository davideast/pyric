import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';
import type {
  PyricRuntimeError,
  PyricRuntimeSnapshot,
  PyricRuntimeStatus,
} from './status.js';
import {
  createChipDialogController,
  DIALOG_STYLES,
  type ChipDialogController,
  type ChipDialogUser,
} from './chip-dialog.js';
import {
  getLens as defaultGetLens,
  setLens as defaultSetLens,
  subscribeLens as defaultSubscribeLens,
} from '../worker/client/core.js';

export interface PyricRuntimeChipOptions {
  runtime: PyricRuntimeStatus;
  document?: Document;
  clipboard?: Pick<Clipboard, 'writeText'>;
  initiallyOpen?: boolean;
  /** Override Studio availability. Omitted uses the runtime manifest URL. */
  studioUrl?: string | null;
  /** Optional sandbox user provider. */
  listUsers?: () => Promise<AuthUserRecord[]> | AuthUserRecord[];
  /** Optional handler to perform authentic user switching on client auth handles. */
  switchUser?: (uid: string) => Promise<void> | void;
  /** Optional handler to sign out active client auth handles. */
  signOut?: () => Promise<void> | void;
  /** Triggers the existing Auth Helper Dialog (<dialog data-pyric-auth>). */
  openCreateUser?: () => void;
  /** Returns the active client user session. */
  getCurrentUser?: () => ChipDialogUser | null;
  /** Subscribes to client auth state transitions (onAuthStateChanged). */
  subscribeAuth?: (listener: (user: ChipDialogUser | null) => void) => () => void;
  /** Injectable lens getter (defaults to worker client getLens). */
  getLens?: () => AuthLens | undefined;
  /** Injectable lens setter (defaults to worker client setLens). */
  setLens?: (lens: AuthLens | undefined) => void;
  /** Injectable lens subscription (defaults to worker client subscribeLens). */
  subscribeLens?: (listener: (lens: AuthLens | undefined) => void) => () => void;
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
    right: max(20px, env(safe-area-inset-right));
    bottom: max(20px, env(safe-area-inset-bottom));
    z-index: 2147483000;
    color: var(--pyric-text);
    font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-synthesis: none;
  }
  *, *::before, *::after { box-sizing: border-box; }
  .announcer { height: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; width: 1px; clip: rect(0 0 0 0); white-space: nowrap; }
  button, a { font: inherit; }
  button { margin: 0; }
  .chip {
    align-items: center;
    background: var(--pyric-bg);
    border: 1px solid var(--pyric-border);
    border-radius: 999px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, .38);
    color: var(--pyric-text);
    cursor: pointer;
    display: flex;
    gap: 10px;
    height: 36px;
    padding: 0 12px;
  }
  .chip:hover { border-color: #4a4a58; }
  .brand, .signals, .signal, .panel-title, .worker-state { align-items: center; display: flex; }
  .brand { gap: 8px; }
  .brand-mark { color: rgba(251, 251, 254, .78); font: 600 11px/1 ui-monospace, monospace; }
  .brand-label, .signals, .worker-state, code, .button { font-family: "JetBrains Mono", ui-monospace, monospace; }
  .brand-label { font-size: 11px; }
  .signals { color: var(--pyric-muted); font-size: 10px; gap: 8px; }
  .signal { gap: 4px; white-space: nowrap; }
  .signal[data-identity-badge] {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot { background: var(--pyric-accent); border-radius: 50%; height: 8px; width: 8px; }
  .dot.error { background: var(--pyric-error); box-shadow: 0 0 0 3px rgba(240,160,160,.12); }
  .signal.update { color: var(--pyric-warning); }
  .chevron { color: var(--pyric-muted); height: 14px; width: 14px; }
  .panel {
    background: var(--pyric-bg);
    border: 1px solid var(--pyric-border);
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, .48);
    max-width: calc(100vw - 40px);
    overflow: hidden;
    width: 380px;
  }
  .panel-header { align-items: center; display: flex; height: 44px; justify-content: space-between; padding: 0 12px; }
  .panel-title { gap: 8px; min-width: 0; }
  .panel-title strong { font: 500 12px/1 ui-monospace, monospace; }
  .count { background: rgba(58,42,42,.3); border: 1px solid #3a2a2a; border-radius: 999px; color: var(--pyric-error); font: 9px/1 ui-monospace, monospace; padding: 4px 6px; }
  .icon-button { align-items: center; background: transparent; border: 0; border-radius: 4px; color: var(--pyric-muted); cursor: pointer; display: inline-flex; height: 28px; justify-content: center; padding: 0; width: 28px; }
  .icon-button:hover { background: rgba(255,255,255,.05); color: var(--pyric-text); }
  .icon-button:disabled { cursor: not-allowed; opacity: .42; }
  .icon-button[data-copy-failed] { color: var(--pyric-error); }
  .icon { height: 15px; width: 15px; }
  .worker-state { border-top: 1px solid var(--pyric-border-soft); color: var(--pyric-muted); font-size: 10px; justify-content: space-between; min-height: 34px; padding: 7px 12px; }
  .worker-state-col { border-top: 1px solid var(--pyric-border-soft); color: var(--pyric-muted); font-size: 10px; display: flex; flex-direction: column; min-height: 34px; padding: 7px 12px; }
  .worker-state-row { align-items: center; display: flex; justify-content: space-between; width: 100%; }
  .worker-state-subline { color: #89899f; font: 9px/1.4 ui-monospace, monospace; margin-top: 4px; overflow-wrap: anywhere; text-align: right; width: 100%; }
  .worker-state .available { color: var(--pyric-warning); }
  .worker-state .state-label, .worker-state-col .state-label { align-items: center; display: flex; gap: 7px; white-space: nowrap; }
  .mini-dot { background: var(--pyric-accent); border-radius: 50%; height: 6px; width: 6px; }
  .available .mini-dot { background: var(--pyric-warning); }
  .epochs { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .errors { background: var(--pyric-content); border-bottom: 1px solid var(--pyric-border-soft); border-top: 1px solid var(--pyric-border-soft); max-height: 184px; min-height: 58px; overflow-y: auto; }
  .errors::-webkit-scrollbar { width: 8px; }
  .errors::-webkit-scrollbar-thumb { background: #33333f; border-radius: 4px; }
  .error-row { align-items: flex-start; border-bottom: 1px solid rgba(42,42,53,.7); display: grid; gap: 8px; grid-template-columns: 18px minmax(0,1fr) 28px 28px; padding: 10px 8px 10px 12px; }
  .error-row:last-child { border-bottom: 0; }
  .error-number { color: var(--pyric-error); font: 10px/20px ui-monospace, monospace; }
  .panel-controls { align-items: center; display: inline-flex; gap: 4px; }
  .clear-button { background: transparent; border: 0; color: var(--pyric-muted); cursor: pointer; font-size: 11px; margin-left: 8px; padding: 2px 6px; }
  .clear-button:hover { color: var(--pyric-text); }
  .error-body { min-width: 0; }
  .error-body code { color: #d7d7df; display: block; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
  .error-meta { color: var(--pyric-muted); font: 9px/1.4 ui-monospace, monospace; margin-top: 4px; overflow-wrap: anywhere; }
  .empty { align-items: center; color: var(--pyric-muted); display: flex; font: 11px/1.5 ui-monospace, monospace; min-height: 57px; padding: 12px; }
  .actions { display: grid; gap: 8px; grid-template-columns: repeat(3, 1fr); min-height: 56px; padding: 10px 12px; }
  .button { align-items: center; background: transparent; border: 1px solid var(--pyric-border-soft); border-radius: 4px; color: var(--pyric-muted); display: inline-flex; font-size: 10px; justify-content: center; letter-spacing: .06em; min-height: 34px; padding: 6px 8px; text-decoration: none; text-transform: uppercase; }
  button.button { cursor: pointer; }
  .button:hover:not(:disabled):not([aria-disabled="true"]), a.button:hover { border-color: #3a3a48; color: var(--pyric-text); }
  .button.update:not(:disabled):not([aria-disabled="true"]) { background: rgba(230,199,156,.1); border-color: rgba(230,199,156,.4); color: var(--pyric-warning); }
  .button.update:not(:disabled):not([aria-disabled="true"]):hover { background: rgba(230,199,156,.15); }
  .button:disabled, .button[aria-disabled="true"] { cursor: not-allowed; opacity: .42; }
  .button svg { height: 14px; margin-left: 6px; width: 14px; }
  @media (max-width: 460px) {
    :host { bottom: max(12px, env(safe-area-inset-bottom)); right: 12px; }
    .panel { max-width: calc(100vw - 24px); }
    .worker-state { align-items: flex-start; flex-direction: column; gap: 4px; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .chip, .panel { animation: pyric-enter 120ms ease-out; transform-origin: bottom right; }
    @keyframes pyric-enter { from { opacity: 0; transform: translateY(4px) scale(.98); } }
  }

  ${DIALOG_STYLES}
`;

const icons = {
  close: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  minimize: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14"/></svg>',
  copy: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5H5v11h3"/></svg>',
  chevron: '<svg class="chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 15 6-6 6 6"/></svg>',
  external: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 5h5v5M19 5l-8 8"/><path d="M19 13v6H5V5h6"/></svg>',
};

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function formatPyricRuntimeError(error: PyricRuntimeError): string {
  const context = [
    error.source,
    error.service && error.method ? `${error.service}.${error.method}` : error.service ?? error.method,
    error.path,
    error.code,
  ].filter(Boolean).join(' · ');
  return `${error.message}${context ? `\n${context}` : ''}${error.stack ? `\n${error.stack}` : ''}`;
}

function renderErrors(snapshot: PyricRuntimeSnapshot, canCopy: boolean): string {
  if (snapshot.errors.length === 0) return '<div class="empty">No sandbox errors.</div>';
  return snapshot.errors.map((error, index) => `
    <div class="error-row" data-error-id="${escapeAttribute(error.id)}">
      <span class="error-number">${String(index + 1).padStart(2, '0')}</span>
      <div class="error-body"><code></code><div class="error-meta"></div></div>
      <button class="icon-button" type="button" data-copy-error="${escapeAttribute(error.id)}" aria-label="${canCopy ? `Copy error ${index + 1}` : 'Copy unavailable'}" title="${canCopy ? 'Copy error' : 'Clipboard unavailable'}" ${canCopy ? '' : 'disabled'}>${icons.copy}</button>
      <button class="icon-button" type="button" data-dismiss-error="${escapeAttribute(error.id)}" aria-label="Dismiss error ${index + 1}" title="Dismiss error">${icons.close}</button>
    </div>
  `).join('');
}

/** Mount the framework-independent runtime chip in an isolated shadow root. */
export function mountPyricRuntimeChip(options: PyricRuntimeChipOptions): PyricRuntimeChip {
  const documentLike = options.document ?? document;
  const existingHost = documentLike.querySelector<HTMLElement>(
    '[data-pyric-runtime-chip-host], pyric-runtime-chip',
  );
  if (existingHost) {
    existingHost.remove();
  }

  const host = documentLike.createElement('div');
  host.setAttribute('data-pyric-runtime-chip-host', '');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${styles}</style><div class="announcer" role="status" aria-live="polite" aria-atomic="true"></div><div data-view></div>`;
  const view = root.querySelector<HTMLElement>('[data-view]')!;
  const announcer = root.querySelector<HTMLElement>('.announcer')!;
  const clipboard = options.clipboard
    ?? documentLike.defaultView?.navigator.clipboard;
  const studioUrl = 'studioUrl' in options
    ? options.studioUrl
    : options.runtime.getSnapshot().manifest.studioUrl;
  let open = options.initiallyOpen ?? false;
  let snapshot = options.runtime.getSnapshot();

  const getLensFn = options.getLens ?? defaultGetLens;
  const setLensFn = options.setLens ?? defaultSetLens;
  const subscribeLensFn = options.subscribeLens ?? defaultSubscribeLens;
  let activeLens: AuthLens | undefined = getLensFn();
  let clientUser: ChipDialogUser | null = options.getCurrentUser ? options.getCurrentUser() : null;

  const dialogController: ChipDialogController = createChipDialogController({
    shadowRoot: root,
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
      clientUser = null;
      render();
    },
    onOpenCreateUser: () => {
      if (options.openCreateUser) {
        options.openCreateUser();
      }
    },
    onToggleAdminBypass: (enable) => {
      if (enable) {
        setLensFn({ mode: 'admin' });
      } else {
        setLensFn(undefined);
      }
      activeLens = getLensFn();
      render();
    },
    getCurrentUser: () => (options.getCurrentUser ? options.getCurrentUser() : clientUser),
    getLens: () => getLensFn(),
  });

  const render = (next = snapshot): void => {
    const active = root.activeElement;
    const oldViewport = view.querySelector<HTMLElement>('[data-error-viewport]');
    const oldScroll = oldViewport
      ? {
          top: oldViewport.scrollTop,
          atBottom: oldViewport.scrollHeight - oldViewport.scrollTop - oldViewport.clientHeight <= 8,
        }
      : null;
    const activeCopyId = active?.getAttribute('data-copy-error');
    const activeControl = ['data-expand', 'data-collapse', 'data-update-worker', 'data-open-studio', 'data-open-impersonate']
      .find((attribute) => active?.hasAttribute(attribute));
    const focusToken = activeCopyId !== null && activeCopyId !== undefined
      ? { attribute: 'data-copy-error', value: activeCopyId }
      : activeControl
        ? { attribute: activeControl, value: null }
        : null;
    snapshot = next;
    const errorCount = snapshot.errors.length;
    const workerLabel = snapshot.updateAvailable
      ? 'New worker available'
      : snapshot.mode === 'starting'
        ? 'Sandbox starting'
        : snapshot.mode === 'in-page'
          ? 'In-page sandbox'
          : 'Worker current';
    const epochs = snapshot.updateAvailable
      ? `${snapshot.runningEpoch?.slice(0, 8) ?? 'unknown'} → ${snapshot.servedEpoch?.slice(0, 8) ?? 'unknown'}`
      : snapshot.runningEpoch?.slice(0, 8) ?? '';
    const aiState = aiEngineState();

    const lens = getLensFn();
    const user = options.getCurrentUser ? options.getCurrentUser() : clientUser;
    const isAdmin = lens?.mode === 'admin';

    let identitySignalHtml = '';
    if (isAdmin) {
      identitySignalHtml = '<span class="signal update" data-identity-badge>⚡ bypass</span>';
    } else if (lens?.mode === 'as') {
      const label = lens.uid;
      identitySignalHtml = `<span class="signal" data-identity-badge title="as: ${escapeAttribute(label)}">as: ${escapeAttribute(label)}</span>`;
    } else if (user) {
      const label = user.uid;
      identitySignalHtml = `<span class="signal" data-identity-badge title="as: ${escapeAttribute(label)}">as: ${escapeAttribute(label)}</span>`;
    }

    view.innerHTML = `${open ? `
      <section class="panel" role="dialog" aria-label="Pyric runtime">
        <header class="panel-header">
          <div class="panel-title"><span class="brand-mark">&gt;_</span><strong>Pyric runtime</strong>${identitySignalHtml}${errorCount > 0 ? `<span class="count">${errorCount} ${errorCount === 1 ? 'error' : 'errors'}</span><button class="clear-button" type="button" data-clear-errors aria-label="Clear all errors">Clear</button>` : ''}</div>
          <div class="panel-controls">
            <button class="icon-button" type="button" data-collapse aria-label="Minimize Pyric runtime">${icons.minimize}</button>
            <button class="icon-button" type="button" data-dismiss-chip aria-label="Dismiss Pyric runtime from page">${icons.close}</button>
          </div>
        </header>
        <div class="worker-state"><span class="state-label${snapshot.updateAvailable ? ' available' : ''}"><span class="mini-dot"></span>${workerLabel}</span><span class="epochs">${epochs}</span></div>
        <div class="worker-state-col" data-ai-status>
          <div class="worker-state-row">
            <span class="state-label"><span class="mini-dot"></span>AI engine</span>
            <span class="epochs">${aiState.primary}</span>
          </div>
          ${aiState.subline ? `<div class="worker-state-subline">${aiState.subline}</div>` : ''}
        </div>
        <div class="errors" data-error-viewport>${renderErrors(snapshot, Boolean(clipboard))}</div>
        <div class="actions">
          <button class="button" type="button" data-open-impersonate>Identity</button>
          <button class="button update" type="button" data-update-worker ${snapshot.updateAvailable ? '' : 'disabled'} aria-disabled="${snapshot.updateAvailable && !snapshot.updatingWorker ? 'false' : 'true'}">${snapshot.updatingWorker ? 'Updating…' : 'Update worker'}</button>
          ${studioUrl
            ? `<a class="button" data-open-studio href="${escapeAttribute(studioUrl)}" target="_blank" rel="noopener noreferrer">Studio${icons.external}</a>`
            : `<span class="button" data-open-studio aria-disabled="true" title="Pyric Studio is disabled">Studio${icons.external}</span>`}
        </div>
      </section>
    ` : `
      <button class="chip" type="button" data-expand aria-label="Open Pyric runtime" aria-expanded="false">
        <span class="brand"><span class="dot${errorCount > 0 ? ' error' : ''}"></span><span class="brand-label">Pyric</span></span>
        <span class="signals">${identitySignalHtml}${snapshot.updateAvailable ? '<span class="signal update">update</span>' : ''}${errorCount > 0 ? `<span class="signal">${errorCount} ${errorCount === 1 ? 'error' : 'errors'}</span>` : '<span class="signal">ready</span>'}${icons.chevron}</span>
      </button>
    `}`;

    const announcement = `${workerLabel}. ${errorCount === 0 ? 'No runtime errors' : `${errorCount} runtime ${errorCount === 1 ? 'error' : 'errors'}`}.`;
    if (announcer.textContent !== announcement) announcer.textContent = announcement;
    const newViewport = view.querySelector<HTMLElement>('[data-error-viewport]');
    if (oldScroll && newViewport) {
      newViewport.scrollTop = oldScroll.atBottom ? newViewport.scrollHeight : oldScroll.top;
    }

    for (const error of snapshot.errors) {
      const row = [...root.querySelectorAll('[data-error-id]')]
        .find((candidate) => candidate.getAttribute('data-error-id') === error.id);
      const code = row?.querySelector('code');
      const meta = row?.querySelector('.error-meta');
      if (code) code.textContent = error.message;
      if (meta) meta.textContent = [error.source, error.service && error.method ? `${error.service}.${error.method}` : error.service ?? error.method, error.path, error.code].filter(Boolean).join(' · ');
    }

    root.querySelector('[data-expand]')?.addEventListener('click', () => {
      open = true;
      render();
      root.querySelector<HTMLButtonElement>('[data-collapse]')?.focus();
    });
    root.querySelector('[data-collapse]')?.addEventListener('click', () => {
      open = false;
      render();
      root.querySelector<HTMLButtonElement>('[data-expand]')?.focus();
    });
    root.querySelector('[data-clear-errors]')?.addEventListener('click', () => {
      options.runtime.clearErrors();
    });
    root.querySelector('[data-dismiss-chip]')?.addEventListener('click', () => {
      host.style.display = 'none';
    });
    root.querySelector('[data-update-worker]')?.addEventListener('click', () => {
      if (!snapshot.updateAvailable || snapshot.updatingWorker) return;
      void options.runtime.updateWorker().catch(() => { /* status records and renders the failure */ });
    });
    root.querySelector('[data-open-impersonate]')?.addEventListener('click', (e) => {
      void dialogController.open(e.currentTarget as HTMLElement);
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy-error]')) {
      button.addEventListener('click', () => {
        const error = snapshot.errors.find((item) => item.id === button.dataset.copyError);
        if (!error || !clipboard) return;
        void clipboard.writeText(formatPyricRuntimeError(error)).catch(() => {
          button.setAttribute('data-copy-failed', '');
          button.setAttribute('aria-label', 'Copy failed');
          button.title = 'Copy failed';
        });
      });
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-dismiss-error]')) {
      button.addEventListener('click', () => {
        if (button.dataset.dismissError) {
          options.runtime.dismissError(button.dataset.dismissError);
        }
      });
    }
    if (focusToken) {
      const candidates = root.querySelectorAll<HTMLElement>(`[${focusToken.attribute}]`);
      const replacement = [...candidates].find((candidate) =>
        focusToken.value === null || candidate.getAttribute(focusToken.attribute) === focusToken.value);
      replacement?.focus();
    }
  };

  documentLike.body.append(host);
  const unsubscribe = options.runtime.subscribe(render);

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

  return {
    element: host,
    dispose() {
      unsubscribe();
      unsubLens();
      unsubAuth?.();
      dialogController.dispose();
      host.remove();
    },
  };
}
