import type {
  PyricRuntimeError,
  PyricRuntimeSnapshot,
  PyricRuntimeStatus,
} from './status.js';
import { getLens, setLens, subscribeLens } from '../worker/client.js';
import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';

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
  /** Optional user directory provider to power the typeahead combobox. */
  listUsers?: () => Promise<AuthUserRecord[]> | AuthUserRecord[];
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
  .dot { background: var(--pyric-accent); border-radius: 50%; height: 8px; width: 8px; }
  .dot.error { background: var(--pyric-error); box-shadow: 0 0 0 3px rgba(240,160,160,.12); }
  .signal.update { color: var(--pyric-warning); }
  .signal.identity {
    background: rgba(25, 204, 97, 0.14);
    border: 1px solid rgba(25, 204, 97, 0.3);
    border-radius: 4px;
    color: var(--pyric-accent);
    font-weight: 500;
    padding: 1px 6px;
  }
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
  .actions { display: grid; gap: 8px; grid-template-columns: 1fr 1fr 1fr; min-height: 56px; padding: 10px 12px; }
  .button { align-items: center; background: transparent; border: 1px solid var(--pyric-border-soft); border-radius: 4px; color: var(--pyric-muted); display: inline-flex; font-size: 10px; justify-content: center; letter-spacing: .06em; min-height: 34px; padding: 6px 8px; text-decoration: none; text-transform: uppercase; }
  button.button { cursor: pointer; }
  .button:hover:not(:disabled):not([aria-disabled="true"]), a.button:hover { border-color: #3a3a48; color: var(--pyric-text); }
  .button.update:not(:disabled):not([aria-disabled="true"]) { background: rgba(230,199,156,.1); border-color: rgba(230,199,156,.4); color: var(--pyric-warning); }
  .button.update:not(:disabled):not([aria-disabled="true"]):hover { background: rgba(230,199,156,.15); }
  .button:disabled, .button[aria-disabled="true"] { cursor: not-allowed; opacity: .42; }
  .button svg { height: 14px; margin-left: 6px; width: 14px; }
  .impersonate-dialog {
    background: var(--pyric-bg);
    border: 1px solid var(--pyric-border);
    border-radius: 8px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    color: var(--pyric-text);
    font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: auto;
    max-width: calc(100vw - 32px);
    padding: 0;
    width: 420px;
  }
  .impersonate-dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }
  .dialog-content {
    display: flex;
    flex-direction: column;
    padding: 16px;
  }
  .dialog-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .dialog-header h2 {
    color: var(--pyric-text);
    font: 600 13px/1 ui-monospace, monospace;
    letter-spacing: 0.02em;
    margin: 0;
  }
  .dialog-close {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 4px;
    color: var(--pyric-muted);
    cursor: pointer;
    display: inline-flex;
    font-size: 18px;
    height: 28px;
    justify-content: center;
    line-height: 1;
    padding: 0;
    width: 28px;
  }
  .dialog-close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--pyric-text);
  }
  .field-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }
  .radio-label {
    align-items: center;
    color: var(--pyric-text);
    cursor: pointer;
    display: flex;
    font-size: 11px;
    gap: 8px;
  }
  .radio-label input[type="radio"] {
    accent-color: var(--pyric-accent);
    cursor: pointer;
    margin: 0;
  }
  .input-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 14px;
  }
  .field-label {
    display: flex;
    flex-direction: column;
    font-size: 10px;
    gap: 4px;
    color: var(--pyric-muted);
  }
  .field-label input, .field-label textarea {
    background: var(--pyric-content);
    border: 1px solid var(--pyric-border-soft);
    border-radius: 4px;
    color: var(--pyric-text);
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    padding: 6px 8px;
  }
  .field-label input:focus, .field-label textarea:focus {
    border-color: var(--pyric-accent);
    outline: none;
  }
  .field-label textarea {
    resize: vertical;
  }
  .user-search-container {
    position: relative;
    margin-bottom: 4px;
  }
  .search-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }
  .user-search-input {
    width: 100%;
    box-sizing: border-box;
    padding-right: 24px !important;
  }
  .search-clear-btn {
    position: absolute;
    right: 4px;
    background: transparent;
    border: 0;
    color: var(--pyric-muted);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    line-height: 1;
  }
  .search-clear-btn:hover {
    color: var(--pyric-text);
  }
  .filter-chips-row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .filter-chip {
    background: var(--pyric-content);
    border: 1px solid var(--pyric-border-soft);
    border-radius: 12px;
    color: var(--pyric-muted);
    cursor: pointer;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 9px;
    padding: 2px 8px;
    transition: all 0.15s ease;
  }
  .filter-chip:hover {
    border-color: var(--pyric-border);
    color: var(--pyric-text);
  }
  .filter-chip.active {
    background: rgba(25, 204, 97, 0.12);
    border-color: var(--pyric-accent);
    color: var(--pyric-accent);
  }
  .user-search-listbox {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: #141418;
    border: 1px solid var(--pyric-border);
    border-radius: 6px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.75);
    list-style: none;
    margin: 0;
    max-height: 220px;
    overflow-y: auto;
    padding: 4px;
    z-index: 100;
  }
  .user-search-item {
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
  }
  .user-search-item:hover, .user-search-item.highlighted {
    background: rgba(255, 255, 255, 0.08);
  }
  .user-item-main {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .user-name {
    color: var(--pyric-text);
    font-size: 11px;
    font-weight: 500;
  }
  .user-email {
    color: var(--pyric-muted);
    font-size: 10px;
  }
  .user-badges {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }
  .badge-provider {
    background: rgba(80, 140, 255, 0.15);
    border: 1px solid rgba(80, 140, 255, 0.3);
    border-radius: 3px;
    color: #93b5ff;
    font: 9px "JetBrains Mono", ui-monospace, monospace;
    padding: 1px 4px;
  }
  .badge-tenant {
    background: rgba(25, 204, 97, 0.12);
    border: 1px solid rgba(25, 204, 97, 0.3);
    border-radius: 3px;
    color: var(--pyric-accent);
    font: 9px "JetBrains Mono", ui-monospace, monospace;
    padding: 1px 4px;
  }
  .user-item-sub {
    display: flex;
    align-items: center;
    gap: 8px;
    font: 9px/1.3 "JetBrains Mono", ui-monospace, monospace;
    color: var(--pyric-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .user-claims-preview {
    color: #e6c79c;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .selected-user-card {
    align-items: center;
    background: rgba(25, 204, 97, 0.08);
    border: 1px solid rgba(25, 204, 97, 0.25);
    border-radius: 4px;
    display: flex;
    font: 10px "JetBrains Mono", ui-monospace, monospace;
    justify-content: space-between;
    margin-top: 6px;
    padding: 4px 8px;
  }
  .selected-user-card span {
    color: var(--pyric-accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .selected-user-clear {
    background: transparent;
    border: 0;
    color: var(--pyric-muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 4px;
  }
  .selected-user-clear:hover {
    color: var(--pyric-text);
  }
  .form-error {
    color: var(--pyric-error);
    font-size: 10px;
    margin-bottom: 10px;
  }
  .dialog-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .button-primary {
    background: rgba(25, 204, 97, 0.15);
    border-color: rgba(25, 204, 97, 0.4);
    color: var(--pyric-accent);
  }
  .button-primary:hover {
    background: rgba(25, 204, 97, 0.25);
    color: #fff;
  }
  @media (max-width: 460px) {
    :host { bottom: max(12px, env(safe-area-inset-bottom)); right: 12px; }
    .panel { max-width: calc(100vw - 24px); }
    .worker-state { align-items: flex-start; flex-direction: column; gap: 4px; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .chip, .panel { animation: pyric-enter 120ms ease-out; transform-origin: bottom right; }
    @keyframes pyric-enter { from { opacity: 0; transform: translateY(4px) scale(.98); } }
  }
`;

const icons = {
  close: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  minimize: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14"/></svg>',
  copy: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5H5v11h3"/></svg>',
  chevron: '<svg class="chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 15 6-6 6 6"/></svg>',
  external: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 5h5v5M19 5l-8 8"/><path d="M19 13v6H5V5h6"/></svg>',
};

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderIdentityBadge(lens: AuthLens | undefined): string {
  if (!lens || lens.mode === 'app-session') return '';
  if (lens.mode === 'as') {
    const tenantSuffix = lens.tenant ? ` (${escapeHtml(lens.tenant)})` : '';
    return `<span class="signal identity" data-identity-badge>as: ${escapeHtml(lens.uid)}${tenantSuffix}</span>`;
  }
  if (lens.mode === 'admin') {
    return '<span class="signal identity" data-identity-badge>admin</span>';
  }
  if ((lens as { mode: string }).mode === 'anon') {
    return '<span class="signal identity" data-identity-badge>anon</span>';
  }
  return '';
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
  const host = documentLike.createElement('div');
  host.setAttribute('data-pyric-runtime-chip-host', '');
  const root = host.attachShadow({ mode: 'open' });

  const getLensFn = options.getLens ?? getLens;
  const setLensFn = options.setLens ?? setLens;
  const subscribeLensFn = options.subscribeLens ?? subscribeLens;

  let currentLens: AuthLens | undefined = getLensFn();

  root.innerHTML = `
    <style>${styles}</style>
    <div class="announcer" role="status" aria-live="polite" aria-atomic="true"></div>
    <div data-view></div>
    <dialog class="impersonate-dialog" data-impersonate-dialog aria-modal="true" aria-labelledby="impersonate-title">
      <div class="dialog-content">
        <header class="dialog-header">
          <h2 id="impersonate-title">Impersonate Identity</h2>
          <button type="button" class="dialog-close" data-close-impersonate aria-label="Close dialog">&times;</button>
        </header>
        <form data-impersonate-form>
          <div class="field-group">
            <label class="radio-label">
              <input type="radio" name="mode" value="app-session" checked />
              <span>App Session</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="mode" value="admin" />
              <span>Admin Bypass</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="mode" value="as" />
              <span>Impersonated User</span>
            </label>
          </div>
          <div class="input-group" data-impersonate-fields>
            <div class="user-search-container" data-user-search-container>
              <label class="field-label">
                <span>Search Sandbox Users (Name, UID, Provider, Claim)</span>
                <div class="search-input-wrapper">
                  <input
                    type="text"
                    class="user-search-input"
                    data-user-search-input
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded="false"
                    aria-controls="user-search-listbox"
                    placeholder="Search name, uid, provider:google, role:admin..."
                    autocomplete="off"
                  />
                  <button type="button" class="search-clear-btn" data-search-clear-btn style="display: none;" aria-label="Clear search">&times;</button>
                </div>
              </label>
              <div class="filter-chips-row" data-filter-chips style="display: none;"></div>
              <ul class="user-search-listbox" id="user-search-listbox" data-user-search-listbox role="listbox" style="display: none;"></ul>
              <div class="selected-user-card" data-selected-user-card style="display: none;">
                <span class="selected-user-label" data-selected-user-label></span>
                <button type="button" class="selected-user-clear" data-clear-selected-user title="Clear selected template" aria-label="Clear selected template">&times;</button>
              </div>
            </div>
            <label class="field-label">
              <span>UID</span>
              <input type="text" name="uid" data-input-uid placeholder="UID (e.g. alice)" />
            </label>
            <label class="field-label">
              <span>Tenant</span>
              <input type="text" name="tenant" data-input-tenant placeholder="Tenant ID (e.g. tenant-1)" />
            </label>
            <label class="field-label">
              <span>Claims</span>
              <textarea name="claims" data-input-claims placeholder='Custom claims JSON (e.g. {"role": "editor"})'></textarea>
            </label>
          </div>
          <div class="form-error" data-dialog-error style="display: none;"></div>
          <footer class="dialog-actions">
            <button type="button" data-clear-lens class="button">Reset to App Session</button>
            <button type="submit" class="button button-primary">Apply Identity</button>
          </footer>
        </form>
      </div>
    </dialog>
  `;

  const view = root.querySelector<HTMLElement>('[data-view]')!;
  const announcer = root.querySelector<HTMLElement>('.announcer')!;
  const dialog = root.querySelector<HTMLDialogElement>('[data-impersonate-dialog]')!;
  const form = dialog.querySelector<HTMLFormElement>('[data-impersonate-form]')!;
  const closeButton = dialog.querySelector<HTMLButtonElement>('[data-close-impersonate]')!;
  const clearLensButton = dialog.querySelector<HTMLButtonElement>('[data-clear-lens]')!;
  const errorEl = dialog.querySelector<HTMLElement>('[data-dialog-error]')!;
  const uidInput = dialog.querySelector<HTMLInputElement>('[data-input-uid]')!;
  const tenantInput = dialog.querySelector<HTMLInputElement>('[data-input-tenant]')!;
  const claimsInput = dialog.querySelector<HTMLTextAreaElement>('[data-input-claims]')!;

  const userSearchContainer = dialog.querySelector<HTMLElement>('[data-user-search-container]')!;
  const userSearchInput = dialog.querySelector<HTMLInputElement>('[data-user-search-input]')!;
  const searchClearBtn = dialog.querySelector<HTMLButtonElement>('[data-search-clear-btn]')!;
  const filterChips = dialog.querySelector<HTMLElement>('[data-filter-chips]')!;
  const userSearchListbox = dialog.querySelector<HTMLUListElement>('[data-user-search-listbox]')!;
  const selectedUserCard = dialog.querySelector<HTMLElement>('[data-selected-user-card]')!;
  const selectedUserLabel = dialog.querySelector<HTMLElement>('[data-selected-user-label]')!;
  const clearSelectedUser = dialog.querySelector<HTMLButtonElement>('[data-clear-selected-user]')!;

  let cachedUsers: AuthUserRecord[] = [];
  let currentMatches: AuthUserRecord[] = [];
  let activeFilter: string | null = null;
  let highlightedIndex = -1;

  const extractTenantFromUser = (user: AuthUserRecord): string => {
    const claims = user.customClaims ?? {};
    if (typeof claims.tenant === 'string') return claims.tenant;
    if (claims.firebase && typeof (claims.firebase as Record<string, unknown>).tenant === 'string') {
      return (claims.firebase as Record<string, unknown>).tenant as string;
    }
    return '';
  };

  const getUserProviders = (user: AuthUserRecord): string[] => {
    const providers = (user.providerUserInfo ?? [])
      .map((p) => p.providerId)
      .filter(Boolean);
    if (user.isAnonymous && !providers.includes('anonymous')) {
      providers.push('anonymous');
    }
    return providers;
  };

  const filterUsers = (users: AuthUserRecord[], query: string, filter: string | null): AuthUserRecord[] => {
    let list = users;
    if (filter) {
      const f = filter.toLowerCase();
      if (f === 'admin') {
        list = list.filter((u) => {
          const c = u.customClaims ?? {};
          return c.admin === true || c.role === 'admin' || (typeof c.role === 'string' && c.role.toLowerCase().includes('admin'));
        });
      } else if (f === 'tenant') {
        list = list.filter((u) => Boolean(extractTenantFromUser(u)));
      } else if (f === 'anonymous') {
        list = list.filter((u) => u.isAnonymous || getUserProviders(u).includes('anonymous'));
      } else {
        list = list.filter((u) => getUserProviders(u).some((p) => p.toLowerCase().includes(f)));
      }
    }

    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return list.slice(0, 15);
    }

    const tokens = trimmed.split(/\s+/);

    return list.filter((user) => {
      const providers = getUserProviders(user).map((p) => p.toLowerCase());
      const claims = user.customClaims ?? {};
      const claimsEntries = Object.entries(claims);
      const tenant = extractTenantFromUser(user).toLowerCase();
      const uid = user.uid.toLowerCase();
      const displayName = (user.displayName ?? '').toLowerCase();
      const email = (user.email ?? '').toLowerCase();

      return tokens.every((token) => {
        if (token.startsWith('provider:')) {
          const pVal = token.slice('provider:'.length);
          return providers.some((p) => p.includes(pVal));
        }
        if (token.startsWith('tenant:')) {
          const tVal = token.slice('tenant:'.length);
          return tenant.includes(tVal);
        }
        if (token.startsWith('role:')) {
          const rVal = token.slice('role:'.length);
          const role = (claims.role ?? '').toString().toLowerCase();
          return role.includes(rVal);
        }
        if (token.startsWith('claim:')) {
          const cVal = token.slice('claim:'.length);
          return claimsEntries.some(([k, v]) => `${k}:${v}`.toLowerCase().includes(cVal) || `${k}=${v}`.toLowerCase().includes(cVal));
        }
        if (token.includes(':')) {
          const [k, ...rest] = token.split(':');
          const v = rest.join(':');
          if (k && v && claimsEntries.some(([ck, cv]) => ck.toLowerCase() === k && String(cv).toLowerCase().includes(v))) {
            return true;
          }
        }
        if (token.includes('=')) {
          const [k, ...rest] = token.split('=');
          const v = rest.join('=');
          if (k && v && claimsEntries.some(([ck, cv]) => ck.toLowerCase() === k && String(cv).toLowerCase().includes(v))) {
            return true;
          }
        }

        if (uid.includes(token)) return true;
        if (displayName.includes(token)) return true;
        if (email.includes(token)) return true;
        if (tenant.includes(token)) return true;
        if (providers.some((p) => p.includes(token))) return true;
        if (claimsEntries.some(([k, v]) => k.toLowerCase().includes(token) || String(v).toLowerCase().includes(token))) return true;

        return false;
      });
    }).slice(0, 15);
  };

  const renderMatches = (): void => {
    currentMatches = filterUsers(cachedUsers, userSearchInput.value, activeFilter);
    highlightedIndex = -1;

    if (!cachedUsers.length && !userSearchInput.value) {
      userSearchListbox.style.display = 'none';
      userSearchInput.setAttribute('aria-expanded', 'false');
      return;
    }

    if (currentMatches.length === 0) {
      userSearchListbox.innerHTML = `<li class="user-search-empty" style="color: var(--pyric-muted); font-size: 11px; padding: 8px;">No matching sandbox users found</li>`;
      userSearchListbox.style.display = 'block';
      userSearchInput.setAttribute('aria-expanded', 'true');
      return;
    }

    userSearchListbox.innerHTML = currentMatches.map((u, idx) => {
      const providers = getUserProviders(u);
      const tenant = extractTenantFromUser(u);
      const claims = u.customClaims ?? {};
      const claimsStr = Object.keys(claims).length > 0 ? JSON.stringify(claims) : '';
      const label = u.displayName || u.email || u.uid;

      return `
        <li class="user-search-item" data-user-index="${idx}" role="option" aria-selected="false">
          <div class="user-item-main">
            <span class="user-name">${escapeAttribute(label)}</span>
            ${u.email && u.displayName ? `<span class="user-email">${escapeAttribute(u.email)}</span>` : ''}
            <div class="user-badges">
              ${providers.map((p) => `<span class="badge-provider">${escapeAttribute(p)}</span>`).join('')}
              ${tenant ? `<span class="badge-tenant">tenant: ${escapeAttribute(tenant)}</span>` : ''}
            </div>
          </div>
          <div class="user-item-sub">
            <span class="user-uid">uid: ${escapeAttribute(u.uid)}</span>
            ${claimsStr ? `<span class="user-claims-preview">${escapeAttribute(claimsStr)}</span>` : ''}
          </div>
        </li>
      `;
    }).join('');

    userSearchListbox.style.display = 'block';
    userSearchInput.setAttribute('aria-expanded', 'true');
  };

  const selectUser = (user: AuthUserRecord): void => {
    uidInput.value = user.uid;
    const tenant = extractTenantFromUser(user);
    tenantInput.value = tenant;
    const claims = user.customClaims ?? {};
    claimsInput.value = Object.keys(claims).length > 0 ? JSON.stringify(claims, null, 2) : '';

    const asRadio = dialog.querySelector<HTMLInputElement>('input[name="mode"][value="as"]');
    if (asRadio) {
      asRadio.checked = true;
      for (const other of modeRadios) {
        if (other !== asRadio) other.checked = false;
      }
    }

    selectedUserLabel.textContent = `Template: ${user.displayName || user.email || user.uid}`;
    selectedUserCard.style.display = 'flex';
    userSearchInput.value = '';
    searchClearBtn.style.display = 'none';
    userSearchListbox.style.display = 'none';
    userSearchInput.setAttribute('aria-expanded', 'false');
    announcer.textContent = `Selected user ${user.uid}`;
  };

  const renderFilterChips = (): void => {
    if (!cachedUsers.length) {
      filterChips.style.display = 'none';
      return;
    }

    const chips: Array<{ id: string | null; label: string }> = [
      { id: null, label: 'All' },
    ];

    const hasAdmins = cachedUsers.some((u) => {
      const c = u.customClaims ?? {};
      return c.admin === true || c.role === 'admin';
    });
    if (hasAdmins) chips.push({ id: 'admin', label: 'Admins' });

    const hasTenants = cachedUsers.some((u) => Boolean(extractTenantFromUser(u)));
    if (hasTenants) chips.push({ id: 'tenant', label: 'Tenants' });

    const allProviders = new Set<string>();
    for (const u of cachedUsers) {
      for (const p of getUserProviders(u)) {
        allProviders.add(p);
      }
    }
    for (const p of allProviders) {
      chips.push({ id: p, label: p });
    }

    filterChips.innerHTML = chips.map((c) => `
      <button type="button" class="filter-chip${activeFilter === c.id ? ' active' : ''}" data-filter="${c.id ?? ''}">
        ${escapeAttribute(c.label)}
      </button>
    `).join('');
    filterChips.style.display = 'flex';
  };

  const loadUsers = async (): Promise<void> => {
    if (!options.listUsers) return;
    try {
      const res = await options.listUsers();
      cachedUsers = Array.isArray(res) ? res : [];
      renderFilterChips();
    } catch {
      cachedUsers = [];
    }
  };

  const clipboard = options.clipboard
    ?? documentLike.defaultView?.navigator.clipboard;
  const studioUrl = 'studioUrl' in options
    ? options.studioUrl
    : options.runtime.getSnapshot().manifest.studioUrl;
  let open = options.initiallyOpen ?? false;
  let snapshot = options.runtime.getSnapshot();
  let triggerElement: HTMLElement | null = null;

  const getFocusableElements = (): HTMLElement[] => {
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const parent = el.closest('[style*="display: none"]');
      return !parent;
    });
  };

  const populateForm = (): void => {
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }

    userSearchInput.value = '';
    searchClearBtn.style.display = 'none';
    userSearchListbox.style.display = 'none';
    userSearchInput.setAttribute('aria-expanded', 'false');
    activeFilter = null;
    highlightedIndex = -1;

    const modeRadios = dialog.querySelectorAll<HTMLInputElement>('input[name="mode"]');
    const mode = currentLens?.mode ?? 'app-session';
    for (const radio of modeRadios) {
      radio.checked = radio.value === mode;
    }

    const lens = currentLens;
    if (lens && lens.mode === 'as') {
      uidInput.value = lens.uid;
      tenantInput.value = lens.tenant ?? '';
      claimsInput.value = lens.token ? JSON.stringify(lens.token, null, 2) : '';
      const matched = cachedUsers.find((u) => u.uid === lens.uid);
      if (matched) {
        selectedUserLabel.textContent = `Template: ${matched.displayName || matched.email || matched.uid}`;
        selectedUserCard.style.display = 'flex';
      } else {
        selectedUserCard.style.display = 'none';
        selectedUserLabel.textContent = '';
      }
    } else {
      uidInput.value = '';
      tenantInput.value = '';
      claimsInput.value = '';
      selectedUserCard.style.display = 'none';
      selectedUserLabel.textContent = '';
    }
  };

  const openDialog = (): void => {
    triggerElement = (root.activeElement ?? (documentLike as Document).activeElement) as HTMLElement | null;
    populateForm();
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    loadUsers();
    const focusables = getFocusableElements();
    if (focusables.length > 0) {
      focusables[0].focus();
    }
  };

  const closeDialog = (): void => {
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    userSearchListbox.style.display = 'none';
    triggerElement?.focus();
  };

  closeButton.addEventListener('click', () => {
    closeDialog();
  });

  const modeRadios = dialog.querySelectorAll<HTMLInputElement>('input[name="mode"]');
  for (const radio of modeRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        for (const other of modeRadios) {
          if (other !== radio) other.checked = false;
        }
      }
    });
  }

  clearSelectedUser.addEventListener('click', () => {
    selectedUserCard.style.display = 'none';
    selectedUserLabel.textContent = '';
    uidInput.value = '';
    tenantInput.value = '';
    claimsInput.value = '';
  });

  searchClearBtn.addEventListener('click', () => {
    userSearchInput.value = '';
    searchClearBtn.style.display = 'none';
    renderMatches();
    userSearchInput.focus();
  });

  userSearchInput.addEventListener('input', () => {
    searchClearBtn.style.display = userSearchInput.value ? 'block' : 'none';
    const asRadio = dialog.querySelector<HTMLInputElement>('input[name="mode"][value="as"]');
    if (asRadio && !asRadio.checked) {
      asRadio.checked = true;
      for (const other of modeRadios) {
        if (other !== asRadio) other.checked = false;
      }
    }
    renderMatches();
  });

  userSearchInput.addEventListener('focus', () => {
    if (cachedUsers.length > 0) {
      renderMatches();
    }
  });

  userSearchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (userSearchListbox.style.display === 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        renderMatches();
        e.preventDefault();
        return;
      }
    }

    const items = Array.from(userSearchListbox.querySelectorAll<HTMLElement>('.user-search-item'));
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightedIndex = (highlightedIndex + 1) % items.length;
      items.forEach((item, idx) => {
        if (idx === highlightedIndex) {
          item.classList.add('highlighted');
          item.setAttribute('aria-selected', 'true');
          item.scrollIntoView?.({ block: 'nearest' });
        } else {
          item.classList.remove('highlighted');
          item.setAttribute('aria-selected', 'false');
        }
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightedIndex = (highlightedIndex - 1 + items.length) % items.length;
      items.forEach((item, idx) => {
        if (idx === highlightedIndex) {
          item.classList.add('highlighted');
          item.setAttribute('aria-selected', 'true');
          item.scrollIntoView?.({ block: 'nearest' });
        } else {
          item.classList.remove('highlighted');
          item.setAttribute('aria-selected', 'false');
        }
      });
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && highlightedIndex < currentMatches.length) {
        e.preventDefault();
        selectUser(currentMatches[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      userSearchListbox.style.display = 'none';
      userSearchInput.setAttribute('aria-expanded', 'false');
    }
  });

  filterChips.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    const target = (e.target as HTMLElement).closest<HTMLElement>('.filter-chip');
    if (!target) return;
    const filterVal = target.getAttribute('data-filter') || null;
    activeFilter = activeFilter === filterVal ? null : filterVal;
    renderFilterChips();
    renderMatches();
  });

  userSearchListbox.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    const target = (e.target as HTMLElement).closest<HTMLElement>('.user-search-item');
    if (!target) return;
    const idx = Number(target.getAttribute('data-user-index'));
    if (!Number.isNaN(idx) && currentMatches[idx]) {
      selectUser(currentMatches[idx]);
    }
  });

  clearLensButton.addEventListener('click', () => {
    setLensFn(undefined);
    closeDialog();
  });

  dialog.addEventListener('click', (e: MouseEvent) => {
    if (e.target === dialog) {
      closeDialog();
      return;
    }
    if (!userSearchContainer.contains(e.target as Node)) {
      userSearchListbox.style.display = 'none';
      userSearchInput.setAttribute('aria-expanded', 'false');
    }
  });

  dialog.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (userSearchListbox.style.display !== 'none') {
        userSearchListbox.style.display = 'none';
        userSearchInput.setAttribute('aria-expanded', 'false');
        e.preventDefault();
        return;
      }
      e.preventDefault();
      closeDialog();
      return;
    }

    if (e.key === 'Tab') {
      userSearchListbox.style.display = 'none';
      userSearchInput.setAttribute('aria-expanded', 'false');
      const focusables = getFocusableElements();
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = root.activeElement;

      if (e.shiftKey) {
        if (current === first || !dialog.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (current === last || !dialog.contains(current)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  });

  form.addEventListener('submit', (e: Event) => {
    e.preventDefault();
    const checkedRadio = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[name="mode"]'))
      .reverse()
      .find((r) => r.checked);
    const mode = checkedRadio?.value ?? 'app-session';

    if (mode === 'app-session') {
      setLensFn(undefined);
      closeDialog();
      return;
    }

    if (mode === 'admin') {
      setLensFn({ mode: 'admin' });
      closeDialog();
      return;
    }

    if (mode === 'as') {
      const uid = (uidInput.value || '').trim();
      const tenant = (tenantInput.value || '').trim();
      const claimsRaw = (claimsInput.value || '').trim();

      let parsedClaims: Record<string, unknown> | undefined;
      if (claimsRaw) {
        try {
          parsedClaims = JSON.parse(claimsRaw) as Record<string, unknown>;
        } catch {
          if (errorEl) {
            errorEl.textContent = 'Invalid JSON in custom claims';
            errorEl.style.display = 'block';
          }
          return;
        }
      }

      setLensFn({
        mode: 'as',
        uid,
        tenant: tenant || undefined,
        token: parsedClaims || undefined,
      });
      closeDialog();
      return;
    }
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

    view.innerHTML = `${open ? `
      <section class="panel" role="dialog" aria-label="Pyric runtime">
        <header class="panel-header">
          <div class="panel-title"><span class="brand-mark">&gt;_</span><strong>Pyric runtime</strong>${errorCount > 0 ? `<span class="count">${errorCount} ${errorCount === 1 ? 'error' : 'errors'}</span><button class="clear-button" type="button" data-clear-errors aria-label="Clear all errors">Clear</button>` : ''}</div>
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
          <button class="button update" type="button" data-update-worker ${snapshot.updateAvailable ? '' : 'disabled'} aria-disabled="${snapshot.updateAvailable && !snapshot.updatingWorker ? 'false' : 'true'}">${snapshot.updatingWorker ? 'Updating…' : 'Update worker'}</button>
          <button class="button" type="button" data-open-impersonate>Impersonate</button>
          ${studioUrl
            ? `<a class="button" data-open-studio href="${escapeAttribute(studioUrl)}" target="_blank" rel="noopener noreferrer">Studio${icons.external}</a>`
            : `<span class="button" data-open-studio aria-disabled="true" title="Pyric Studio is disabled">Studio${icons.external}</span>`}
        </div>
      </section>
    ` : `
      <button class="chip" type="button" data-expand aria-label="Open Pyric runtime" aria-expanded="false">
        <span class="brand"><span class="dot${errorCount > 0 ? ' error' : ''}"></span><span class="brand-label">Pyric</span></span>
        <span class="signals">${renderIdentityBadge(currentLens)}${snapshot.updateAvailable ? '<span class="signal update">update</span>' : ''}${errorCount > 0 ? `<span class="signal">${errorCount} ${errorCount === 1 ? 'error' : 'errors'}</span>` : '<span class="signal">ready</span>'}${icons.chevron}</span>
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
    root.querySelector('[data-open-impersonate]')?.addEventListener('click', () => {
      openDialog();
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
  const unsubscribeLens = subscribeLensFn((nextLens) => {
    currentLens = nextLens;
    render();
  });
  return {
    element: host,
    dispose() {
      unsubscribeLens();
      unsubscribe();
      host.remove();
    },
  };
}
