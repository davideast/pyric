import type { AuthLens } from 'pyric/sandbox';
import type {
  PyricRuntimeError,
  PyricRuntimeSnapshot,
  PyricRuntimeStatus,
} from './status.js';
import {
  createChipDialogController,
  DIALOG_STYLES,
  type ChipDialogController,
} from './chip-dialog.js';
import type { RuntimeIdentity, RuntimeIdentityBindings } from './identity.js';
import type { ListenerMode } from './listener-mode.js';
import type { ListenerOutline, ListenerOutlineIncident } from './listener-outline-model.js';
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
  /** Optional identity integration. Missing operations use lens/no-op fallbacks. */
  identity?: Partial<RuntimeIdentityBindings>;
  /** Injectable lens getter (defaults to worker client getLens). */
  getLens?: () => AuthLens | undefined;
  /** Injectable lens setter (defaults to worker client setLens). */
  setLens?: (lens: AuthLens | undefined) => void;
  /** Injectable lens subscription (defaults to worker client subscribeLens). */
  subscribeLens?: (listener: (lens: AuthLens | undefined) => void) => () => void;
  /**
   * Build the Listeners mode this chip toggles. Called once, on the first
   * toggle, with the callback the mode reports each recomputation through.
   * Omitted leaves the toggle out: a page with no sandbox event source has
   * nothing to outline.
   */
  listeners?: (onChange: (outlines: readonly ListenerOutline[]) => void) => ListenerMode;
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
  .signal.update { color: var(--pyric-warning); }
  .signal.bypass { color: #8f7fe8; font-weight: 500; }
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
  .listener-header { border: 1px solid var(--pyric-border-soft); border-radius: 999px; color: var(--pyric-text); font: 9px/1 ui-monospace, monospace; padding: 4px 6px; }
  .listener-header.has-incident { background: rgba(58,50,42,.3); border-color: #3a322a; color: var(--pyric-warning); }
  .listener-rows { margin-top: 6px; }
  .listener-row {
    align-items: center;
    border-bottom: 1px solid rgba(42,42,53,.7);
    color: #d7d7df;
    display: grid;
    gap: 6px;
    grid-template-columns: 16px minmax(0,1fr) minmax(0,1.2fr) 30px 34px 10px 24px 24px;
    padding: 4px 0 4px 2px;
  }
  .listener-row:last-child { border-bottom: 0; }
  .listener-row:hover { background: rgba(255,255,255,.05); }
  .listener-number { color: var(--pyric-muted); font: 10px/18px ui-monospace, monospace; }
  .listener-row.incident .listener-number, .listener-row.incident .listener-mark { color: var(--pyric-warning); }
  .listener-label { font-size: 10px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listener-target, .listener-count { font: 10px/18px ui-monospace, monospace; }
  .listener-target { color: var(--pyric-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listener-count { text-align: right; }
  .listener-mark { font: 10px/18px ui-monospace, monospace; text-align: center; }
  .listener-row .icon-button { height: 20px; width: 24px; }
  .listener-row .icon-button .icon { height: 13px; width: 13px; }
  .listener-link { align-self: flex-end; color: var(--pyric-muted); font-size: 11px; margin-top: 4px; text-decoration: none; }
  a.listener-link:hover { color: var(--pyric-text); }
  .listener-link[aria-disabled="true"] { cursor: not-allowed; opacity: .6; }
  .signal.error { color: var(--pyric-error); }
  .button[aria-pressed="true"] { background: rgba(25,204,97,.12); border-color: rgba(25,204,97,.4); color: var(--pyric-accent); }
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
    .chip, .panel { transform-origin: bottom right; }
    .entering { animation: pyric-enter 120ms ease-out; }
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

/** `true` when two listener lists would render the same Listeners summary. */
function sameOutlines(a: readonly ListenerOutline[], b: readonly ListenerOutline[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((outline, i) => {
    const other = b[i];
    return outline.listenerId === other.listenerId
      && outline.label === other.label
      && outline.labelIsOwner === other.labelIsOwner
      && outline.target === other.target
      && outline.isQuery === other.isQuery
      && outline.deliveryCount === other.deliveryCount
      && outline.incident?.pattern === other.incident?.pattern
      && outline.incident?.count === other.incident?.count
      && outline.incident?.windowMs === other.incident?.windowMs;
  });
}

/** `12 listeners`, `1 listener`, `2 duplicates`, etc. */
function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The target the way the app wrote it: `conversations (query)`, `users/u1`. */
function displayTarget(outline: ListenerOutline): string {
  return outline.isQuery ? `${outline.target} (query)` : outline.target;
}

/** The group a listener's owner row belongs under: its owner label, or its
 * target when nothing on the page named it. */
function groupKey(outline: ListenerOutline): string {
  return outline.labelIsOwner ? outline.label : displayTarget(outline);
}

interface ListenerIncidentGroup {
  pattern: 'duplicate-listener' | 'listener-churn';
  target: string;
  label: string | null;
  count: number;
  windowMs: number;
}

/** One incident line per distinct (pattern, target, count) triple, so a
 * duplicate or churn incident shared by several listeners reads once. */
function listenerIncidentGroups(outlines: readonly ListenerOutline[]): ListenerIncidentGroup[] {
  const groups = new Map<string, ListenerIncidentGroup>();
  for (const outline of outlines) {
    const incident = outline.incident;
    if (incident === null) continue;
    const target = displayTarget(outline);
    const key = `${incident.pattern}:${target}:${incident.count}:${incident.windowMs}`;
    if (groups.has(key)) continue;
    groups.set(key, {
      pattern: incident.pattern,
      target,
      label: outline.labelIsOwner ? outline.label : null,
      count: incident.count,
      windowMs: incident.windowMs,
    });
  }
  return [...groups.values()];
}

function listenerIncidentLine(group: ListenerIncidentGroup): string {
  if (group.pattern === 'duplicate-listener') {
    const times = group.count === 2 ? 'twice' : `${group.count} times`;
    const by = group.label !== null ? ` by ${group.label}` : '';
    return `${group.target} attached ${times}${by}`;
  }
  const seconds = Math.round(group.windowMs / 1000);
  const duration = seconds > 0 ? `${seconds}s` : `${group.windowMs}ms`;
  return `${group.target} reattached ${group.count} times in ${duration}`;
}

interface ListenerOwnerGroup {
  key: string;
  listeners: number;
  deliveries: number;
  targets: Set<string>;
  incident: ListenerOutlineIncident | null;
}

/** The owner groups a Listeners panel lists, busiest by total deliveries
 * first. */
function listenerOwnerGroups(outlines: readonly ListenerOutline[]): ListenerOwnerGroup[] {
  const groups = new Map<string, ListenerOwnerGroup>();
  for (const outline of outlines) {
    const key = groupKey(outline);
    const target = displayTarget(outline);
    const existing = groups.get(key);
    if (existing) {
      existing.listeners += 1;
      existing.deliveries += outline.deliveryCount;
      existing.targets.add(target);
      existing.incident ??= outline.incident;
    } else {
      groups.set(key, {
        key,
        listeners: 1,
        deliveries: outline.deliveryCount,
        targets: new Set([target]),
        incident: outline.incident,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.deliveries - a.deliveries || a.key.localeCompare(b.key));
}

/** `?view=listeners`, appended to whatever query string Studio's URL already carries. */
function studioListenersUrl(studioUrl: string): string {
  const separator = studioUrl.includes('?') ? '&' : '?';
  return `${studioUrl}${separator}view=listeners`;
}

/** One body row of the Listeners table. The columns line up across incident
 * and owner rows, so the two read as one table. */
interface ListenerTableRow {
  /**
   * Identifies the row across renders. It changes when the row's listener set
   * changes, which is what brings a dismissed row back: a new attach moves an
   * owner row's listener count, and a new incident moves the incident part.
   */
  signature: string;
  isIncident: boolean;
  label: string;
  target: string;
  /** The first count column: listeners for an owner row, attaches for an incident. */
  first: string;
  firstTitle: string;
  /** The second count column: deliveries, empty on an incident row. */
  second: string;
  secondTitle: string;
  mark: string;
  markTitle: string;
  copyText: string;
}

/** `duplicate ×2`, `churn ×40`: what an incident mark stands for. */
function incidentMarkTitle(incident: ListenerOutlineIncident): string {
  const word = incident.pattern === 'duplicate-listener' ? 'duplicate' : 'churn';
  return `${word} ×${incident.count}`;
}

function incidentTableRow(group: ListenerIncidentGroup): ListenerTableRow {
  const prose = listenerIncidentLine(group);
  return {
    signature: `incident:${group.pattern}:${group.target}:${group.count}:${group.windowMs}`,
    isIncident: true,
    label: group.pattern === 'duplicate-listener' ? 'duplicate' : 'churn',
    target: group.target,
    first: String(group.count),
    firstTitle: prose,
    second: '',
    secondTitle: '',
    mark: '!',
    markTitle: prose,
    copyText: prose,
  };
}

function ownerTableRow(group: ListenerOwnerGroup): ListenerTableRow {
  const target = group.targets.size === 1 ? [...group.targets][0] : `${group.targets.size} targets`;
  const incidentSuffix = group.incident === null ? '' : ` · ${incidentMarkTitle(group.incident)}`;
  const counts = `${pluralize(group.listeners, 'listener')} · ${pluralize(group.deliveries, 'delivery', 'deliveries')}`;
  const incidentPart = group.incident === null
    ? 'none'
    : `${group.incident.pattern}:${group.incident.count}:${group.incident.windowMs}`;
  return {
    signature: `owner:${group.key}:${group.listeners}:${incidentPart}`,
    isIncident: false,
    label: group.key,
    target,
    first: String(group.listeners),
    firstTitle: pluralize(group.listeners, 'listener'),
    second: String(group.deliveries),
    secondTitle: pluralize(group.deliveries, 'delivery', 'deliveries'),
    mark: group.incident === null ? '' : '!',
    markTitle: group.incident === null ? '' : incidentMarkTitle(group.incident),
    copyText: `${group.key} · ${target} · ${counts}${incidentSuffix}`,
  };
}

/**
 * The rows a Listeners panel shows, incidents first and then the busiest
 * owners, minus the rows dismissed at their current signature. Four rows at
 * most: the header and the Studio link take the other two of the six lines.
 */
function listenerTableRows(
  outlines: readonly ListenerOutline[],
  dismissed: ReadonlySet<string>,
): ListenerTableRow[] {
  const incidents = listenerIncidentGroups(outlines).slice(0, 2)
    .map(incidentTableRow)
    .filter((row) => !dismissed.has(row.signature));
  const owners = listenerOwnerGroups(outlines)
    .map(ownerTableRow)
    .filter((row) => !dismissed.has(row.signature))
    .slice(0, Math.max(0, 4 - incidents.length));
  return [...incidents, ...owners];
}

function listenerRowHtml(row: ListenerTableRow, index: number, canCopy: boolean): string {
  const ordinal = String(index + 1).padStart(2, '0');
  const name = escapeAttribute(`${row.label} ${row.target}`);
  return `<div class="listener-row${row.isIncident ? ' incident' : ''}" data-listener-row="${escapeAttribute(row.signature)}">
      <span class="listener-number">${ordinal}</span>
      <span class="listener-label" title="${escapeAttribute(row.label)}">${escapeAttribute(row.label)}</span>
      <span class="listener-target" title="${escapeAttribute(row.target)}">${escapeAttribute(row.target)}</span>
      <span class="listener-count" title="${escapeAttribute(row.firstTitle)}">${escapeAttribute(row.first)}</span>
      <span class="listener-count" title="${escapeAttribute(row.secondTitle)}">${escapeAttribute(row.second)}</span>
      <span class="listener-mark" title="${escapeAttribute(row.markTitle)}" aria-hidden="${row.mark === '' ? 'true' : 'false'}">${escapeAttribute(row.mark)}</span>
      <button class="icon-button" type="button" data-copy-listener="${escapeAttribute(row.signature)}" aria-label="${canCopy ? `Copy ${name}` : 'Copy unavailable'}" title="${canCopy ? 'Copy listener row' : 'Clipboard unavailable'}" ${canCopy ? '' : 'disabled'}>${icons.copy}</button>
      <button class="icon-button" type="button" data-dismiss-listener="${escapeAttribute(row.signature)}" aria-label="Dismiss ${name}" title="Dismiss listener row">${icons.close}</button>
    </div>`;
}

/**
 * The Listeners panel section: a header line, up to two incident rows, the
 * busiest owners filling what is left, and a link to Studio, six lines at
 * most. The rows share one grid so their columns line up.
 */
function listenerSectionHtml(
  outlines: readonly ListenerOutline[],
  studioUrl: string | null,
  canCopy: boolean,
  dismissed: ReadonlySet<string>,
): string {
  const incidentGroups = listenerIncidentGroups(outlines);
  const duplicateCount = incidentGroups.filter((group) => group.pattern === 'duplicate-listener').length;
  const header = `${pluralize(outlines.length, 'listener')}${duplicateCount > 0 ? ` · ${pluralize(duplicateCount, 'duplicate')}` : ''}`;
  const rows = listenerTableRows(outlines, dismissed);
  const linkHtml = studioUrl
    ? `<a class="listener-link" data-open-listeners-studio href="${escapeAttribute(studioListenersUrl(studioUrl))}" target="_blank" rel="noopener noreferrer">All listeners in Studio</a>`
    : `<span class="listener-link" data-open-listeners-studio aria-disabled="true" title="Pyric Studio is disabled">All listeners in Studio</span>`;
  return `<div class="worker-state-col" data-listener-panel>
      <div class="worker-state-row"><span class="state-label listener-header${incidentGroups.length > 0 ? ' has-incident' : ''}">${escapeAttribute(header)}</span></div>
      <div class="listener-rows">${rows.map((row, index) => listenerRowHtml(row, index, canCopy)).join('')}</div>
      ${linkHtml}
    </div>`;
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

  let host: HTMLElement;
  try {
    host = documentLike.createElement('pyric-runtime-chip');
  } catch {
    host = documentLike.createElement('div');
  }
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
  /** The `open` value the view was last built for; the enter animation plays only when it changes. */
  let renderedOpen: boolean | null = null;
  let snapshot = options.runtime.getSnapshot();

  const getLensFn = options.getLens ?? defaultGetLens;
  const setLensFn = options.setLens ?? defaultSetLens;
  const subscribeLensFn = options.subscribeLens ?? defaultSubscribeLens;
  const providedIdentity = options.identity;
  let clientUser: RuntimeIdentity | null = null;
  const readCurrentUser = (): RuntimeIdentity | null => {
    if (providedIdentity?.getCurrentUser) return providedIdentity.getCurrentUser();
    return clientUser;
  };
  clientUser = readCurrentUser();

  const identity: RuntimeIdentityBindings = {
    listUsers: providedIdentity?.listUsers ?? (() => []),
    switchUser: async (uid) => {
      if (providedIdentity?.switchUser) await providedIdentity.switchUser(uid);
      else setLensFn({ mode: 'as', uid });
      clientUser = readCurrentUser();
      render();
    },
    signOut: async () => {
      if (providedIdentity?.signOut) await providedIdentity.signOut();
      else setLensFn(undefined);
      clientUser = null;
      render();
    },
    openCreateUser: providedIdentity?.openCreateUser ?? (() => {}),
    getCurrentUser: readCurrentUser,
    subscribeAuth: providedIdentity?.subscribeAuth ?? (() => () => {}),
  };

  let listenerMode: ListenerMode | null = null;
  let listenerOutlines: readonly ListenerOutline[] = [];
  /** `true` once the Listeners mode has reported at least once. The collapsed
   * chip's listener count stays hidden until then. */
  let everReportedListeners = false;
  /** Why the last Listeners toggle did nothing, shown until the next toggle. */
  let listenerNotice: string | null = null;
  /** Signatures of the listener rows dismissed from the panel. A row comes
   * back on its own once its signature moves, which a new attach on its
   * target or a new incident does. */
  const dismissedListenerRows = new Set<string>();
  const ensureListenerMode = (): ListenerMode | null => {
    if (listenerMode !== null) return listenerMode;
    const build = options.listeners;
    if (build === undefined) return null;
    listenerMode = build((outlines) => {
      everReportedListeners = true;
      // The mode reports on every attach, delivery, and resize; rebuild the
      // view only when what the Listeners summary shows actually changes.
      if (sameOutlines(outlines, listenerOutlines)) return;
      listenerOutlines = outlines;
      render();
    });
    return listenerMode;
  };

  const dialogController: ChipDialogController = createChipDialogController({
    shadowRoot: root,
    identity,
    onToggleAdminBypass: (enable) => {
      if (enable) {
        setLensFn({ mode: 'admin' });
      } else {
        setLensFn(undefined);
      }
      render();
    },
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
    const activeCopyListener = active?.getAttribute('data-copy-listener');
    const activeControl = ['data-expand', 'data-collapse', 'data-update-worker', 'data-open-studio', 'data-open-impersonate']
      .find((attribute) => active?.hasAttribute(attribute));
    const focusToken = activeCopyId !== null && activeCopyId !== undefined
      ? { attribute: 'data-copy-error', value: activeCopyId }
      : activeCopyListener !== null && activeCopyListener !== undefined
      ? { attribute: 'data-copy-listener', value: activeCopyListener }
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
          : 'Worker version';
    const epochs = snapshot.updateAvailable
      ? `${snapshot.runningEpoch?.slice(0, 8) ?? 'unknown'} → ${snapshot.servedEpoch?.slice(0, 8) ?? 'unknown'}`
      : snapshot.runningEpoch?.slice(0, 8) ?? '';
    const aiState = aiEngineState();

    const lens = getLensFn();
    const user = readCurrentUser();
    const isAdmin = lens?.mode === 'admin';
    const activeUid = lens?.mode === 'as' ? lens.uid : user?.uid;

    const identitySignals: string[] = [];
    let identityStateHtml = '<span class="epochs" data-identity-state>App session</span>';
    if (activeUid) {
      identitySignals.push(`<span class="signal" data-identity-badge title="as: ${escapeAttribute(activeUid)}">as: ${escapeAttribute(activeUid)}</span>`);
      identityStateHtml = `<span class="epochs" data-identity-state data-identity-badge title="as: ${escapeAttribute(activeUid)}">as: ${escapeAttribute(activeUid)}</span>`;
    }
    if (isAdmin) {
      identitySignals.push('<span class="signal bypass" data-identity-badge>bypass rules</span>');
    }
    const identitySignalHtml = identitySignals.join('');

    const listenersOn = listenerMode?.enabled() === true;
    let listenersButtonHtml = '';
    if (options.listeners) {
      listenersButtonHtml = `<button class="button" type="button" data-toggle-listeners aria-pressed="${listenersOn}">Listeners</button>`;
    }
    let listenerPanelHtml = '';
    if (listenerNotice !== null) {
      listenerPanelHtml = `<div class="worker-state-col" data-listener-notice><div class="worker-state-row"><span class="state-label">${escapeAttribute(listenerNotice)}</span></div></div>`;
    } else if (listenersOn) {
      listenerPanelHtml = listenerOutlines.length === 0
        ? `<div class="worker-state-col" data-listener-panel><div class="worker-state-row"><span class="state-label">No listeners</span></div></div>`
        : listenerSectionHtml(listenerOutlines, studioUrl ?? null, Boolean(clipboard), dismissedListenerRows);
    }
    const hasListenerIncident = listenerOutlines.some((outline) => outline.incident !== null);
    const listenerCountHtml = everReportedListeners && (listenerOutlines.length > 0 || listenersOn)
      ? `<span class="signal${hasListenerIncident ? ' error' : ''}" data-listener-count>${pluralize(listenerOutlines.length, 'listener')}</span>`
      : '';

    view.innerHTML = `${open ? `
      <section class="panel" role="dialog" aria-label="pyric">
        <header class="panel-header">
          <div class="panel-title"><span class="brand-mark">&gt;_</span><strong>pyric</strong>${errorCount > 0 ? `<span class="count">${errorCount} ${errorCount === 1 ? 'error' : 'errors'}</span><button class="clear-button" type="button" data-clear-errors aria-label="Clear all errors">Clear</button>` : ''}</div>
          <div class="panel-controls">
            <button class="icon-button" type="button" data-collapse aria-label="Minimize pyric">${icons.minimize}</button>
            <button class="icon-button" type="button" data-dismiss-chip aria-label="Dismiss pyric from page">${icons.close}</button>
          </div>
        </header>
        <div class="worker-state"><span class="state-label${snapshot.updateAvailable ? ' available' : ''}">${workerLabel}</span><span class="epochs">${epochs}</span></div>
        <div class="worker-state-col" data-ai-status>
          <div class="worker-state-row">
            <span class="state-label">AI engine</span>
            <span class="epochs">${aiState.primary}</span>
          </div>
          ${aiState.subline ? `<div class="worker-state-subline">${aiState.subline}</div>` : ''}
        </div>
        <div class="worker-state"><span class="state-label">Rules</span><span class="epochs" style="${isAdmin ? 'color: #8f7fe8; font-weight: 500;' : ''}">${isAdmin ? 'bypassed' : 'enforced'}</span></div>
        <div class="worker-state"><span class="state-label">Identity</span>${identityStateHtml}</div>
        ${listenerPanelHtml}
        <div class="errors" data-error-viewport>${renderErrors(snapshot, Boolean(clipboard))}</div>
        <div class="actions">
          <button class="button update" type="button" data-update-worker ${snapshot.updateAvailable ? '' : 'disabled'} aria-disabled="${snapshot.updateAvailable && !snapshot.updatingWorker ? 'false' : 'true'}">${snapshot.updatingWorker ? 'Updating…' : 'Update worker'}</button>
          <button class="button" type="button" data-open-impersonate>Identity</button>
          ${listenersButtonHtml}
          ${studioUrl
            ? `<a class="button" data-open-studio href="${escapeAttribute(studioUrl)}" target="_blank" rel="noopener noreferrer">Studio${icons.external}</a>`
            : `<span class="button" data-open-studio aria-disabled="true" title="Pyric Studio is disabled">Studio${icons.external}</span>`}
        </div>
      </section>
    ` : `
      <button class="chip" type="button" data-expand aria-label="Open pyric" aria-expanded="false">
        <span class="brand"><span class="dot${errorCount > 0 ? ' error' : ''}"></span><span class="brand-label">pyric</span></span>
        <span class="signals">${identitySignalHtml}${listenerCountHtml}${snapshot.updateAvailable ? '<span class="signal update">update</span>' : ''}${errorCount > 0 ? `<span class="signal">${errorCount} ${errorCount === 1 ? 'error' : 'errors'}</span>` : ''}${icons.chevron}</span>
      </button>
    `}`;

    const announcement = `${workerLabel}. ${errorCount === 0 ? 'No runtime errors' : `${errorCount} runtime ${errorCount === 1 ? 'error' : 'errors'}`}.${listenerNotice === null ? '' : ` ${listenerNotice}`}`;
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

    if (renderedOpen !== open) {
      view.querySelector(open ? '.panel' : '.chip')?.classList.add('entering');
      renderedOpen = open;
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
    root.querySelector('[data-toggle-listeners]')?.addEventListener('click', () => {
      const mode = ensureListenerMode();
      if (mode === null) return;
      const wanted = !mode.enabled();
      mode.setEnabled(wanted);
      // The mode refuses to start when attribution is off; say so rather than
      // rebuilding the panel with nothing changed.
      listenerNotice = wanted && !mode.enabled()
        ? 'Listener attribution is off in this build, so there are no owners to outline.'
        : null;
      if (!mode.enabled()) listenerOutlines = [];
      render();
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
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy-listener]')) {
      button.addEventListener('click', () => {
        const signature = button.dataset.copyListener;
        const row = listenerTableRows(listenerOutlines, dismissedListenerRows)
          .find((candidate) => candidate.signature === signature);
        if (!row || !clipboard) return;
        void clipboard.writeText(row.copyText).catch(() => {
          button.setAttribute('data-copy-failed', '');
          button.setAttribute('aria-label', 'Copy failed');
          button.title = 'Copy failed';
        });
      });
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-dismiss-listener]')) {
      button.addEventListener('click', () => {
        if (!button.dataset.dismissListener) return;
        dismissedListenerRows.add(button.dataset.dismissListener);
        render();
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
  const reattachAfterAstroSwap = (): void => {
    if (!host.isConnected) documentLike.body.append(host);
  };
  documentLike.addEventListener('astro:after-swap', reattachAfterAstroSwap);
  const unsubscribe = options.runtime.subscribe(render);

  const unsubLens = subscribeLensFn(() => {
    render();
  });

  const unsubAuth = identity.subscribeAuth((user) => {
    clientUser = user;
    render();
  });

  render();

  return {
    element: host,
    dispose() {
      unsubscribe();
      unsubLens();
      unsubAuth();
      documentLike.removeEventListener('astro:after-swap', reattachAfterAstroSwap);
      dialogController.dispose();
      listenerMode?.dispose();
      host.remove();
    },
  };
}
