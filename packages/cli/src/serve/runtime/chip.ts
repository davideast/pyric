/**
 * A compact inspector for the app's identity, listeners, traffic, and sandbox.
 * Header, tabs, scroll viewport, and action bar share one fixed panel frame.
 * Rows retain named cells across views; each view assigns those cells to the
 * tracks its information needs. Insets and grouping come exclusively from gaps.
 * Row actions operate on the page; Studio is an explicit secondary destination.
 */
import { installChipFonts } from './chip-fonts.js';
import type { AuthLens } from 'pyric/sandbox';
import type { AuthUserRecord } from 'pyric/auth';
import type { PyricRuntimeStatus } from './status.js';
import {
  createChipThemeDialog,
  THEME_DIALOG_STYLES,
  type ChipThemeDialogController,
} from './chip-theme-dialog.js';
import { pageOverlayThemeStorage } from './overlay-theme.js';
import type { RuntimeIdentity, RuntimeIdentityBindings } from './identity.js';
import type { ListenerMode } from './listener-mode.js';
import { studioSectionUrl } from './studio-links.js';
import type { ListenerOutline } from './listener-outline-model.js';
import { listenerColors } from './listener-palette.js';
import { filterUsers, getUserProviders, userDisplayLabel } from './chip-user-search.js';
import {
  CHIP_TABS,
  CHIP_TAB_LABELS,
  openingChipTab,
  pageChipTabStorage,
  problemTab,
  readRememberedChipTab,
  writeRememberedChipTab,
  type ChipTab,
  type ChipTabSignals,
} from './chip-tab.js';
import {
  createTrafficFeed,
  isPermissionDeniedCode,
  orderChipRequests,
  RECENT_FAILURE_MS,
  type ChipRequest,
  type TrafficFeed,
} from './chip-traffic.js';
import {
  pagePaintModeStorage,
  readListenerPaintMode,
  type ListenerPaintMode,
} from './listener-paint-mode.js';
import type { SandboxEventSource } from './listener-event-source.js';
import {
  getLens as defaultGetLens,
  setLens as defaultSetLens,
  subscribeLens as defaultSubscribeLens,
} from '../worker/client/core.js';

export interface PyricRuntimeChipOptions {
  runtime: PyricRuntimeStatus;
  document?: Document;
  /** Where Traffic's Copy writes. Defaults to the page's own clipboard. */
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
   * The page's sandbox event stream, which Traffic folds into its rows. Omitted
   * leaves Traffic with the runtime's own error feed, which is what a page
   * without an event source has.
   */
  sandboxEvents?: SandboxEventSource | null;
  /**
   * Build the Listeners mode this chip toggles. Called once, on the first
   * toggle, with the callback the mode reports each recomputation through.
   * Omitted leaves the outlines control out: a page with no sandbox event
   * source has nothing to outline.
   */
  listeners?: (onChange: (outlines: readonly ListenerOutline[]) => void) => ListenerMode;
}

export interface PyricRuntimeChip {
  element: HTMLElement;
  dispose(): void;
}

interface AiEngineDisplay {
  primary: string;
  detail: string | null;
}

function aiEngineState(): AiEngineDisplay {
  const engine = (globalThis as { __PYRIC_AI_ENGINE__?: { kind?: string; model?: string } }).__PYRIC_AI_ENGINE__;
  if (engine?.kind === 'gemini') {
    return {
      primary: 'gemini (production)',
      detail: 'gemini-3.5-flash-lite → gemini-flash-lite-latest',
    };
  }
  if (engine?.kind === 'openai') {
    const modelLabel = engine.model ? ` (${engine.model})` : '';
    return {
      primary: `openai (proxy${modelLabel})`,
      detail: null,
    };
  }
  return {
    primary: 'sandbox (scripted)',
    detail: null,
  };
}

const styles = `
  :host {
    all: initial;
    --pyric-bg: #1b1d23;
    --pyric-content: #15171c;
    --pyric-border: #3a3e49;
    --pyric-border-soft: #2d303a;
    --pyric-text: #edf0f5;
    --pyric-muted: #a4acbb;
    --pyric-accent: #b4c7ff;
    --pyric-warning: #e6c79c;
    --pyric-error: #f0a0a0;
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-6: 20px;
    --record-inset: calc(var(--space-3) + 1px);
    --content-inset: calc(var(--space-4) + var(--record-inset));
    position: fixed;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    z-index: 2147483000;
    color: var(--pyric-text);
    font-family: "Pyric Geist", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.5;
    font-synthesis: none;
    color-scheme: dark;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, a, input { all: unset; box-sizing: border-box; font: inherit; }
  button, a { -webkit-tap-highlight-color: transparent; }
  :focus-visible { outline: 2px solid var(--pyric-accent); outline-offset: -2px; }
  .announcer, .sr-only { height: 1px; overflow: hidden; position: absolute; width: 1px; clip-path: inset(50%); white-space: nowrap; }
  .mono { font-family: "Pyric Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-variant-numeric: tabular-nums; }
  .icon { width: 16px; height: 16px; flex: none; }
  .chip { display: flex; align-items: center; justify-content: center; width: 72px; height: 32px; border: 1px solid var(--pyric-border); border-radius: 16px; background: var(--pyric-bg); color: var(--pyric-text); cursor: pointer; font-size: 12px; font-weight: 600; box-shadow: 0 8px 24px #0005; }
  .chip:hover { background: #292d36; }
  .chip.error { border-color: var(--pyric-error); }
  .chip.warning { border-color: var(--pyric-warning); }

  /* Zero-size outer tracks turn gaps into insets. The shell, section frames,
     and records all use this same construction, with no additive spacing. */
  .panel { display: grid; width: 440px; height: 568px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); background: var(--pyric-bg); border: 1px solid var(--pyric-border); border-radius: 12px; box-shadow: 0 18px 60px #0007; overflow: hidden; }
  .panel-column { display: grid; grid-template-rows: 64px 44px minmax(0, 1fr) 64px; min-width: 0; min-height: 0; }
  .panel-header, .bar { display: grid; grid-template-columns: 0 minmax(0, 1fr) auto 0; align-items: center; column-gap: var(--content-inset); overflow: hidden; scrollbar-gutter: stable; scrollbar-width: thin; }
  .brand { display: flex; align-items: center; gap: var(--space-2); grid-column: 2; }
  .panel-name { font-size: 16px; font-weight: 650; letter-spacing: -.02em; }
  .panel-header > .actions { grid-column: 3; }
  .actions { display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end; }
  .tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--pyric-border-soft); background: var(--pyric-content); }
  .tab { display: grid; place-items: center; cursor: pointer; color: var(--pyric-muted); font-size: 12px; font-weight: 550; border-bottom: 2px solid transparent; }
  .tab + .tab { border-left: 1px solid var(--pyric-border-soft); }
  .tab:hover { background: #242832; color: var(--pyric-text); }
  .tab[aria-selected="true"] { background: #242936; border-bottom-color: var(--pyric-accent); color: var(--pyric-accent); }
  .tab.problem { color: var(--pyric-error); }
  .tab.problem[aria-selected="true"] { border-bottom-color: var(--pyric-error); }
  .tab.pending { color: var(--pyric-warning); }
  .tab.pending[aria-selected="true"] { border-bottom-color: var(--pyric-warning); }

  /* The scrollbar owns a separate gutter. Records stop before it even on
     systems with overlay scrollbars; the footer never participates in scroll. */
  .view { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; column-gap: var(--space-4); min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #555c6b transparent; overscroll-behavior: contain; }
  .view::-webkit-scrollbar { width: 8px; }
  .view::-webkit-scrollbar-thumb { background: #555c6b; border-radius: 4px; }
  .view-content { grid-column: 2; display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; }
  .view-content::before, .view-content::after { content: ''; flex: 0 0 0; }
  .section { display: flex; flex-direction: column; gap: var(--space-3); }
  .section-heading, .intro-rail, .pagination { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; column-gap: var(--record-inset); }
  .section-line, .pagination-line { grid-column: 2; display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 20px; }
  .intro-rail > .intro { grid-column: 2; }
  .section-title { font-size: 13px; font-weight: 600; }
  .section-meta, .hint { color: var(--pyric-muted); font-size: 11px; }
  .intro { display: flex; flex-direction: column; gap: var(--space-1); }
  .intro .section-title { font-size: 15px; }
  .rows { display: flex; flex-direction: column; border: 1px solid var(--pyric-border-soft); border-radius: 8px; background: var(--pyric-content); }
  .rows:empty { display: none; }
  .row { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; grid-template-rows: 0 auto 0; column-gap: var(--space-3); row-gap: var(--space-3); text-align: left; width: 100%; }
  .row + .row, .identity-record + .identity-record { border-top: 1px solid var(--pyric-border-soft); }
  .row:first-child { border-start-start-radius: 7px; border-start-end-radius: 7px; }
  .row:last-child { border-end-start-radius: 7px; border-end-end-radius: 7px; }
  .row-content { grid-column: 2; grid-row: 2; display: grid; align-items: center; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 88px; column-gap: var(--space-3); row-gap: var(--space-1); min-width: 0; }
  button.row { color: inherit; cursor: pointer; }
  button.row:hover { background: #252b37; }
  button.row[aria-pressed="true"] { background: #2a3348; box-shadow: inset 0 0 0 1px #788fbd; }
  .c1, .c2, .s1, .s2 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c1 { font-size: 13px; font-weight: 550; line-height: 20px; }
  .c1.wide { grid-column: 1 / 3; }
  .c2 { font-size: 12px; line-height: 20px; }
  .s1, .s2 { color: var(--pyric-muted); font-size: 11px; line-height: 18px; grid-row: 2; }
  .s1 { grid-column: 1; }
  .s1.wide { grid-column: 1 / 3; }
  .s2 { grid-column: 2; }
  .s1.split { display: flex; align-items: center; gap: var(--space-2); }
  .s1.split > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .right { display: flex; gap: var(--space-1); flex: none; max-width: 56px; }
  .provider-disclosure { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; gap: var(--space-3); }
  .provider-details { grid-column: 2; min-width: 0; }
  .provider-body { display: grid; grid-template-rows: 0 auto; row-gap: var(--space-2); }
  .provider-details > summary { grid-column: 2; display: flex; align-items: center; gap: var(--space-1); font-size: 11px; color: var(--pyric-accent); cursor: pointer; min-height: 24px; list-style: none; }
  .provider-details > summary::-webkit-details-marker { display: none; }
  .provider-details[open] > summary .icon { transform: rotate(90deg); }
  .provider-list { grid-row: 2; display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .provider-entry { display: inline-flex; gap: var(--space-1); align-items: center; font-size: 11px; color: var(--pyric-muted); overflow-wrap: anywhere; }
  .provider-disclosure::after { content: ""; grid-column: 2; height: 0; }
  .pagination .btn { width: 32px; flex-basis: 32px; }
  .pagination [data-user-previous] .icon { transform: rotate(180deg); }
  .pagination .section-meta { font-variant-numeric: tabular-nums; }
  .slot { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); grid-column: 3; grid-row: 1 / 3; color: var(--pyric-muted); font-size: 11px; min-width: 0; }
  .slot > span { min-width: 0; overflow-wrap: anywhere; }
  .slot .verdict { width: 52px; min-width: 52px; }
  .row.problem .slot, .row.problem .c1 { color: var(--pyric-error); }
  .row.pending .slot, .row.pending .c1 { color: var(--pyric-warning); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); width: 88px; height: 32px; flex: 0 0 88px; border: 1px solid #454b59; border-radius: 6px; background: #282d37; color: #dbe1ed; cursor: pointer; font-size: 11px; font-weight: 550; line-height: 16px; text-decoration: none; white-space: nowrap; }
  .btn:hover:not(:disabled):not([aria-disabled="true"]) { background: #343d4d; border-color: #76839b; color: #fff; }
  .btn:disabled, .btn[aria-disabled="true"] { cursor: not-allowed; opacity: .5; }
  .btn[aria-pressed="true"] { background: #35435e; border-color: #829ac9; color: #dce6ff; }
  .btn.icon-button { width: 32px; flex-basis: 32px; background: transparent; }
  [data-open-studio] { background: transparent; border-color: var(--pyric-border-soft); }
  .bar { border-top: 1px solid var(--pyric-border-soft); background: var(--pyric-content); }
  .bar-hint { grid-column: 2; color: var(--pyric-muted); font-size: 11px; }
  .bar > .actions { grid-column: 3; }
  .bar.no-hint { grid-template-columns: 0 minmax(0, 1fr) 0; }
  .bar.no-hint > .actions { grid-column: 2; }
  .bar.no-hint .bar-hint { display: none; }
  .field { display: grid; grid-template-columns: 0 16px minmax(0, 1fr) 0; gap: var(--space-3); align-items: center; height: 36px; flex: none; border: 1px solid #454b59; border-radius: 6px; background: var(--pyric-content); color: var(--pyric-muted); }
  .field > .icon { grid-column: 2; }
  .field input { grid-column: 3; width: 100%; min-width: 0; color: var(--pyric-text); font-size: 12px; }
  .field input::placeholder { color: var(--pyric-muted); opacity: 1; }
  .field:focus-within { outline: 2px solid var(--pyric-accent); outline-offset: -2px; }
  .field input:focus-visible { outline: none; }
  .has-leading .row-content { grid-template-columns: 36px minmax(0, 1fr) 88px; }
  .has-leading .c1.wide, .has-leading .s1.wide { grid-column: 2; }
  .leading { grid-column: 1; grid-row: 1 / 3; display: grid; place-items: center; }
  .avatar { display: grid; place-items: center; width: 36px; height: 36px; overflow: hidden; border: 1px solid #474f60; border-radius: 50%; background: #30394b; color: #d1ddf5; font-size: 12px; font-weight: 550; }
  .avatar > * { grid-area: 1 / 1; }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .avatar img[hidden] { display: none; }
  .provider { display: grid; place-items: center; width: 16px; height: 16px; color: #c6cfdf; }
  .provider .icon { width: 13px; height: 13px; }
  .listener-mark { width: 10px; height: 10px; border: 2px solid var(--listener-color); border-radius: 3px; }
  .listener-row .row-content { grid-template-columns: 12px minmax(0, 1fr) 88px; }
  .listener-row .c1.wide, .listener-row .s1.wide { grid-column: 2; }
  .listener-fact { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1); }
  .listener-fact strong { color: #dce2ed; font-weight: 550; font-variant-numeric: tabular-nums; }
  .row[aria-pressed="true"] .listener-fact { color: var(--pyric-accent); }
  .traffic-row .row-content { grid-template-columns: minmax(0, 1fr) 72px 52px; grid-template-rows: 20px auto; align-items: start; column-gap: var(--space-2); }
  .traffic-row .c1 { grid-column: 1; grid-row: 1; color: var(--pyric-muted); font-size: 11px; font-weight: 400; line-height: 20px; }
  .traffic-row .c2 { grid-column: 1 / -1; grid-row: 2; }
  .traffic-row .s1 { grid-column: 2; grid-row: 1; text-align: left; line-height: 20px; }
  .traffic-row .s1 .mono { font-size: 11px; }
  .traffic-row .s2 { grid-column: 1 / -1; grid-row: 3; white-space: normal; overflow-wrap: anywhere; }
  .traffic-row .s2:empty { display: none; }
  .traffic-row[aria-expanded="true"] .c2 { white-space: normal; overflow-wrap: anywhere; }
  [data-chip-view="sandbox"] .s1 { white-space: normal; overflow-wrap: anywhere; }
  .traffic-row .slot { grid-column: 3; grid-row: 1; align-self: start; }
  .listener-toggle { display: flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: 11px; color: var(--pyric-muted); height: 32px; }
  .toggle-track { width: 28px; height: 16px; display: grid; grid-template-columns: 0 1fr 0; gap: 2px; align-items: center; background: #3a3e49; border: 1px solid #697488; border-radius: 8px; }
  .toggle-track::after { content: ''; grid-column: 2; width: 10px; height: 10px; background: #dce1eb; border-radius: 50%; justify-self: start; }
  .listener-toggle[aria-pressed="true"] .toggle-track { background: #536b9d; border-color: var(--pyric-accent); }
  .listener-toggle[aria-pressed="true"] .toggle-track::after { justify-self: end; }
  .verdict { display: flex; align-items: center; justify-content: center; gap: var(--space-1); min-width: 52px; height: 20px; border: 1px solid #49404a; border-radius: 4px; background: #38282d; color: var(--pyric-error); }
  .verdict.ok { color: #b3c7bd; border-color: #3b4943; background: #232e29; }
  .empty { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; grid-template-rows: 0 auto 0; gap: var(--space-4); border: 1px dashed #454b59; border-radius: 8px; }
  .empty > .intro { grid-column: 2; grid-row: 2; }
  .empty .section-title { font-size: 13px; }
  @media (max-width: 400px) {
    :host { --space-3: 8px; --space-4: 12px; --space-6: 20px; }
    .row-content, .has-leading .row-content, .listener-row .row-content { column-gap: var(--space-2); }
    .has-leading .row-content { grid-template-columns: 32px minmax(0, 1fr) 80px; }
    .avatar { width: 32px; height: 32px; }
    .btn { width: 80px; flex-basis: 80px; }
    .bar-hint { font-size: 10px; }
  }
  @media (prefers-reduced-motion: no-preference) {
    [data-view], .panel { transform-origin: bottom right; }
    .entering { animation: pyric-enter 120ms ease-out; }
    @keyframes pyric-enter { from { opacity: 0; transform: translateY(4px) scale(.98); } }
  }
  ${THEME_DIALOG_STYLES}
`;

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Small, shared stroke icons; provider marks use their recognizable silhouettes. */
function iconHtml(name: string): string {
  const paths: Record<string, string> = {
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    minimize: '<path d="M5 12h14"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    password: '<rect x="4" y="9" width="16" height="12" rx="2"/><path d="M8 9V6a4 4 0 0 1 8 0v3M12 14v3"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    'google.com': '<path d="M20 7a9 9 0 1 0 1 6h-9M21 13v-2h-9"/>',
    'github.com': '<path d="M8 21v-4c-5 1-5-3-7-3m15 7v-4c0-1-.3-2-1-2 4-.5 6-2 6-6 0-2-.5-3-2-4 .3-1 .3-2 0-3-2 0-3 1-4 2a14 14 0 0 0-6 0C8 3 7 2 5 2c-.3 1-.3 2 0 3-1.5 1-2 2-2 4 0 4 2 5.5 6 6-.7 0-1 1-1 2"/>',
    'facebook.com': '<path d="M14 22V12h4l1-4h-5V6c0-2 1-3 4-3V0h-4c-4 0-5 3-5 6v2H6v4h3v10"/>',
    'twitter.com': '<path d="m4 3 16 18h-4L1 3h4m15 0L4 21"/>',
    'microsoft.com': '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
    'apple.com': '<path d="M15 3c0-2 2-3 3-3 0 2-1 3-3 3Zm-3 3C5 1 1 9 5 17c3 6 4 3 7 3s4 3 7-3c-5-2-5-7-1-9-2-3-4-3-6-2Z"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.user}</svg>`;
}

function avatarHtml(photoUrl: string | null | undefined, label: string): string {
  const initials = label.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
  // Profile images may be relative served assets or remote HTTP images.
  const safePhoto = photoUrl && /^(https?:\/\/|\/(?!\/))/.test(photoUrl) ? photoUrl : null;
  return `<span class="avatar" aria-hidden="true"><span>${escapeAttribute(initials || '?')}</span>${safePhoto ? `<img data-avatar src="${escapeAttribute(safePhoto)}" alt="" referrerpolicy="no-referrer">` : ''}</span>`;
}

function sectionHtml(title: string, body: string, meta = '', action = ''): string {
  return `<section class="section"><div class="section-heading"><div class="section-line"><span class="section-title">${escapeAttribute(title)}</span><span class="actions"><span class="section-meta">${escapeAttribute(meta)}</span>${action}</span></div></div>${body}</section>`;
}

function introHtml(title: string, hint: string, detail = ''): string {
  return `<div class="intro-rail"><div class="intro"><span class="section-title">${escapeAttribute(title)}</span><span class="hint">${escapeAttribute(hint)}</span>${detail}</div></div>`;
}

function emptyHtml(title: string, detail: string): string {
  return `<div class="empty"><div class="intro"><span class="section-title">${escapeAttribute(title)}</span><span class="hint">${escapeAttribute(detail)}</span></div></div>`;
}

/** `true` when two listener lists would render the same Listeners view. */
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

/** `12 listeners`, `1 listener`, etc. */
function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** The target the way the app wrote it: `conversations (query)`, `users/u1`. */
function displayTarget(outline: ListenerOutline): string {
  return outline.isQuery ? `${outline.target} (query)` : outline.target;
}

/** A view: what the scrolling area holds, and its action bar. */
interface ChipView { body: string; bar: string }

/** Traffic is a bounded recent feed; the identity directory has searchable pages. */
const MAX_ROWS = 7;
const USER_PAGE_SIZE = 20;
const PROVIDER_ICON_LIMIT = 3;

/** Named cells containing escaped text or trusted component markup. */
interface RowCells {
  /** Column one, or the whole text width when `c2` is absent. */
  c1: string;
  /** Optional avatar or listener mark, outside the text cells. */
  leading?: string;
  /** Column two, at L2. Present only on a tab with a fixed first column. */
  c2?: string;
  /** The sub-row under column one; with `c2`, under the first column only. */
  s1?: string;
  /** The sub-row under column two. */
  s2?: string;
  /** The sub-row's right-aligned cell, ending at R. Only without `c2`. */
  s1Right?: string;
  /** The trailing fact or action slot, already escaped or built. */
  slot: string;
  className?: string;
  attributes?: string;
  title?: string | null;
}

/** A row: two lines, three columns, the same cells on every tab. */
function rowHtml(cells: RowCells): string {
  const hasSub = cells.s1 !== undefined || cells.s2 !== undefined || cells.s1Right !== undefined;
  const wide = cells.c2 === undefined;
  const classes = `row${hasSub ? ' sub' : ''}${cells.leading ? ' has-leading' : ''}${cells.className ? ` ${cells.className}` : ''}`;
  const title = cells.title ? ` title="${escapeAttribute(cells.title)}"` : '';
  const attributes = cells.attributes ? ` ${cells.attributes}` : '';
  let html = `<span class="c1${wide ? ' wide' : ''}">${cells.c1}</span>`;
  if (!wide) html += `<span class="c2">${cells.c2}</span>`;
  html += `<span class="slot">${cells.slot}</span>`;
  if (hasSub) {
    if (wide && cells.s1Right !== undefined) {
      html += `<span class="s1 wide split"><span>${cells.s1 ?? ''}</span><span class="right">${cells.s1Right}</span></span>`;
    } else {
      html += `<span class="s1${wide ? ' wide' : ''}">${cells.s1 ?? ''}</span>`;
      if (!wide) html += `<span class="s2">${cells.s2 ?? ''}</span>`;
    }
  }
  return `<div class="${classes}"${title}${attributes}><span class="row-content">${cells.leading ? `<span class="leading">${cells.leading}</span>` : ''}${html}</span></div>`;
}

/** A row whose own click is its action; `pressed` marks it active. */
function buttonRowHtml(cells: RowCells & { label: string; pressed?: boolean; expanded?: boolean }): string {
  const inner = rowHtml(cells);
  const body = inner.slice(inner.indexOf('>') + 1, -'</div>'.length);
  const hasSub = cells.s1 !== undefined || cells.s2 !== undefined || cells.s1Right !== undefined;
  const classes = `row${hasSub ? ' sub' : ''}${cells.leading ? ' has-leading' : ''}${cells.className ? ` ${cells.className}` : ''}`;
  const title = cells.title ? ` title="${escapeAttribute(cells.title)}"` : '';
  return `<button class="${classes}" type="button" aria-label="${escapeAttribute(cells.label)}"${cells.pressed === undefined ? '' : ` aria-pressed="${cells.pressed}"`}${cells.expanded === undefined ? '' : ` aria-expanded="${cells.expanded}"`}${title} ${cells.attributes ?? ''}>${body}</button>`;
}

/** `true` for an element with a text caret to preserve across a rebuild. */
function isTextField(element: Element | null | undefined): element is HTMLInputElement {
  return element !== null && element !== undefined && element.tagName === 'INPUT';
}

/** The one button, wherever it sits. */
function buttonHtml(attributes: string, label: string, title?: string): string {
  return `<button class="btn" type="button" ${attributes}${title ? ` title="${escapeAttribute(title)}"` : ''}>${escapeAttribute(label)}</button>`;
}

/** The action bar: up to three buttons against R, the primary one rightmost. */
function barHtml(buttons: readonly string[], hint = ''): string {
  return `<div class="bar${hint ? '' : ' no-hint'}" data-action-bar><span class="bar-hint">${hint}</span><span class="actions">${buttons.join('')}</span></div>`;
}

/** `12:50:43` in the page's own clock, which is the one the developer reads. */
function clockTime(at: number): string {
  const time = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
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
  const clipboard = options.clipboard ?? documentLike.defaultView?.navigator.clipboard;
  const studioUrl = 'studioUrl' in options
    ? options.studioUrl
    : options.runtime.getSnapshot().manifest.studioUrl;
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
      identityQuery = '';
      identityPage = 0;
      void loadUsers();
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

  // ── Identity view state ────────────────────────────────────────────────────
  /** What the developer typed into the switch-user field. */
  let identityQuery = '';
  let identityPage = 0;
  let filteredDirectory: { users: AuthUserRecord[]; query: string; uid: string | null; matches: AuthUserRecord[] } | null = null;
  /** The sandbox's users, read once the Identity view is first shown. */
  let knownUsers: AuthUserRecord[] = [];
  let usersRequested = false;
  let usersLoading = false;
  let usersFailed = false;
  const loadUsers = async (): Promise<void> => {
    usersRequested = true;
    usersLoading = true;
    usersFailed = false;
    try {
      knownUsers = await identity.listUsers();
    } catch {
      knownUsers = [];
      usersFailed = true;
    }
    usersLoading = false;
    render();
  };

  // ── Listeners view state ───────────────────────────────────────────────────
  let listenerMode: ListenerMode | null = null;
  let listenerOutlines: readonly ListenerOutline[] = [];
  /** The remembered painting mode, for the control the chip draws before the
   * Listeners mode is built. */
  const paintModeBeforeBuild = readListenerPaintMode(pagePaintModeStorage(documentLike));
  /** `true` once the Listeners mode has reported at least once. The collapsed
   * chip's listener count stays hidden until then. */
  /** Why the outlines refused to come on, for the control's own title. */
  let outlinesRefused: string | null = null;
  /** Whether the last rendered panel carried the Flow waiting fact. */
  let renderedFlowWaiting = false;
  const ensureListenerMode = (): ListenerMode | null => {
    if (listenerMode !== null) return listenerMode;
    const build = options.listeners;
    if (build === undefined) return null;
    listenerMode = build((outlines) => {
      // The mode reports on every attach, delivery, and resize; rebuild the
      // view only when what the panel shows actually changes. The first
      // painted flow changes the panel without changing the outlines, because
      // it is what takes the waiting fact away.
      const waiting = listenerMode?.flowWaiting() === true;
      if (sameOutlines(outlines, listenerOutlines) && waiting === renderedFlowWaiting) return;
      renderedFlowWaiting = waiting;
      listenerOutlines = outlines;
      render();
    });
    return listenerMode;
  };

  // ── Traffic view state ─────────────────────────────────────────────────────
  /** Which requests Traffic lists. A page session remembers nothing here: the
   * filter is a way of reading the last minute, not a preference. */
  let trafficFilter: 'all' | 'denied' = 'all';
  /** `false` until the first render. The fold's history batch arrives while this
   * function is still running, before there is a view for it to rebuild. */
  let mounted = false;
  const trafficFeed: TrafficFeed | null = options.sandboxEvents
    ? createTrafficFeed({
      subscribeEvents: options.sandboxEvents,
      onChange: () => {
        if (mounted) render();
      },
    })
    : null;

  /**
   * Traffic's rows: the request stream the page delivers, plus the runtime's own
   * error feed for the failures that are not requests at all. An operation that
   * reached both is one row, keyed by the sandbox event id both carry.
   */
  const trafficRows = (): ChipRequest[] => {
    const byId = new Map<string, ChipRequest>();
    for (const request of trafficFeed?.requests() ?? []) byId.set(request.id, request);
    for (const error of snapshot.errors) {
      if (byId.has(error.id)) continue;
      byId.set(error.id, {
        id: error.id,
        at: error.at,
        service: error.service ?? null,
        method: error.method ?? null,
        path: error.path ?? null,
        // A thrown error is not always a call. When it names neither service
        // nor method, the message is the only true thing to print.
        label: error.message,
        verdict: isPermissionDeniedCode(error.code) ? 'denied' : 'error',
        reason: null,
      });
    }
    const ordered = orderChipRequests([...byId.values()], Date.now());
    const kept = trafficFilter === 'denied' ? ordered.filter((request) => request.verdict !== 'ok') : ordered;
    return kept.slice(0, MAX_ROWS);
  };

  // ── Which view is showing ──────────────────────────────────────────────────
  const tabStorage = pageChipTabStorage(documentLike);
  const signals = (): ChipTabSignals => {
    const now = Date.now();
    const failedRecently = trafficFeed?.failedRecently(now) === true
      || snapshot.errors.some((error) => now - error.at <= RECENT_FAILURE_MS);
    return {
      failedRecently,
      duplicateListener: listenerOutlines.some((outline) => outline.incident?.pattern === 'duplicate-listener'),
      updatePending: snapshot.updateAvailable,
    };
  };
  let tab: ChipTab = openingChipTab(signals(), readRememberedChipTab(tabStorage));
  let open = options.initiallyOpen ?? false;
  /** The `open` value the view was last built for; the panel's enter animation plays only when it changes. */
  let renderedOpen: boolean | null = null;
  const openPanel = (): void => {
    tab = openingChipTab(signals(), readRememberedChipTab(tabStorage));
    if (tab === 'identity' && usersFailed) usersRequested = false;
    open = true;
  };

  const showTab = (next: ChipTab): void => {
    if (next === 'identity' && usersFailed) usersRequested = false;
    tab = next;
    writeRememberedChipTab(tabStorage, next);
    render();
  };

  /** The Theme dialog, built on the first open: the panel usually never asks. */
  let themeDialogController: ChipThemeDialogController | null = null;
  const themeDialog = (): ChipThemeDialogController => {
    if (themeDialogController !== null) return themeDialogController;
    themeDialogController = createChipThemeDialog({
      shadowRoot: root,
      storage: pageOverlayThemeStorage(documentLike),
      readTheme: () => ensureListenerMode()?.overlayTheme() ?? {},
      applyTheme: (theme) => {
        ensureListenerMode()?.setOverlayTheme(theme);
      },
    });
    return themeDialogController;
  };

  // ── The four views ─────────────────────────────────────────────────────────

  /** The listener a row click singled out on the page, if any. */
  let activeListenerId: string | null = null;

  /** The pending worker update as the first tab's first row, while it lasts. */
  const updateRowHtml = (): string => {
    if (!snapshot.updateAvailable) return '';
    return rowHtml({
      c1: 'Worker update available',
      s1: `<span class="mono">${escapeAttribute(snapshot.servedEpoch?.slice(0, 8) ?? '')}</span>`,
      slot: buttonHtml(`data-update-worker aria-disabled="${snapshot.updatingWorker}"`, snapshot.updatingWorker ? 'Updating' : 'Update'),
      className: 'pending',
      attributes: 'data-update-row',
    });
  };

  const userProviders = (record: AuthUserRecord | undefined): string[] =>
    record === undefined ? [] : [...new Set(getUserProviders(record))];
  const providersHtml = (record: AuthUserRecord | undefined): string =>
    userProviders(record).slice(0, PROVIDER_ICON_LIMIT).map((provider) =>
      `<span class="provider" role="img" aria-label="${escapeAttribute(provider)}" title="${escapeAttribute(provider)}">${iconHtml(provider)}</span>`).join('');
  const identityRecordHtml = (row: string, record: AuthUserRecord | undefined): string => {
    const providers = userProviders(record);
    if (providers.length <= PROVIDER_ICON_LIMIT) return `<div class="identity-record">${row}</div>`;
    const entries = providers.map((provider) => `<span class="provider-entry">${iconHtml(provider)}<span>${escapeAttribute(provider)}</span></span>`).join('');
    return `<div class="identity-record">${row}<div class="provider-disclosure"><details class="provider-details" data-user-providers="${escapeAttribute(record!.uid)}"><summary aria-label="Show all ${providers.length} providers for ${escapeAttribute(userDisplayLabel(record!))}">${iconHtml('chevron')}<span>+${providers.length - PROVIDER_ICON_LIMIT} providers</span></summary><div class="provider-body"><div class="provider-list">${entries}</div></div></details></div></div>`;
  };

  const identityViewHtml = (activeUid: string | null, isAdmin: boolean): ChipView => {
    const session = readCurrentUser();
    // An impersonated identity must never borrow the app session's profile.
    const user = session?.uid === activeUid ? session : null;
    const record = knownUsers.find((candidate) => candidate.uid === activeUid);
    const name = user?.displayName ?? record?.displayName ?? null;
    const email = user?.email ?? record?.email ?? null;
    const label = name ?? email ?? activeUid ?? 'Signed out';
    const current = rowHtml({
      c1: escapeAttribute(label),
      s1: activeUid === null ? 'Choose a user below to sign in' : escapeAttribute(name ? email ?? activeUid : activeUid),
      s1Right: providersHtml(record),
      leading: activeUid === null ? `<span class="avatar">${iconHtml('user')}</span>` : avatarHtml(user?.photoURL ?? record?.photoUrl, label),
      slot: activeUid === null ? '' : buttonHtml('data-sign-out', 'Sign out'),
      attributes: 'data-identity-row',
      title: activeUid,
    });
    const query = identityQuery.trim();
    if (filteredDirectory?.users !== knownUsers || filteredDirectory.query !== identityQuery || filteredDirectory.uid !== activeUid) {
      filteredDirectory = { users: knownUsers, query: identityQuery, uid: activeUid, matches: filterUsers(knownUsers, identityQuery).filter((candidate) => candidate.uid !== activeUid) };
    }
    const available = filteredDirectory.matches;
    identityPage = Math.min(identityPage, Math.max(0, Math.ceil(available.length / USER_PAGE_SIZE) - 1));
    const offset = identityPage * USER_PAGE_SIZE;
    const matches = available.slice(offset, offset + USER_PAGE_SIZE);
    const matched = matches.map((candidate) => {
      const label = userDisplayLabel(candidate);
      return identityRecordHtml(buttonRowHtml({
        c1: escapeAttribute(label),
        s1: escapeAttribute(label === candidate.email ? candidate.uid : candidate.email ?? candidate.uid),
        s1Right: providersHtml(candidate),
        leading: avatarHtml(candidate.photoUrl, label),
        slot: '<span class="btn" aria-hidden="true">Sign in</span>',
        attributes: `data-switch-user="${escapeAttribute(candidate.uid)}"`,
        label: `Sign in as ${label}`,
        title: candidate.uid,
      }), candidate);
    });
    const buttons: string[] = [];
    if (query !== '' && matches.length === 0 && !usersLoading && !usersFailed) {
      buttons.push(buttonHtml('data-create-user', 'Create user', `Create a user for ${query}`));
    }
    buttons.push(buttonHtml(`data-toggle-bypass aria-pressed="${isAdmin}"`, 'Bypass rules', isAdmin ? 'Rules are bypassed' : 'Evaluate rules as the session'));
    const search = `<div class="field">${iconHtml('search')}<input type="text" data-identity-query placeholder="Search name, email, or provider" autocomplete="off" aria-label="Search users" value="${escapeAttribute(identityQuery)}"></div>`;
    const empty = !usersRequested || usersLoading ? emptyHtml('Loading users', 'Reading the sandbox user directory.')
      : usersFailed ? emptyHtml('Could not load users', 'Reopen Identity to try reading the sandbox directory again.')
      : query ? emptyHtml('No matching users', 'Try another name, email, or provider. You can also create a user below.')
      : emptyHtml('No other users yet', 'Users created by your app will appear here for quick switching.');
    const range = available.length ? `${(offset + 1).toLocaleString()}–${(offset + matches.length).toLocaleString()} of ${available.length.toLocaleString()}` : '0 users';
    const pagination = available.length > USER_PAGE_SIZE ? `<div class="pagination"><div class="pagination-line"><span class="section-meta" data-user-range>${range}</span><span class="actions"><button class="btn icon-button" type="button" data-user-previous aria-label="Previous users"${identityPage === 0 ? ' disabled' : ''}>${iconHtml('chevron')}</button><button class="btn icon-button" type="button" data-user-next aria-label="Next users"${offset + USER_PAGE_SIZE >= available.length ? ' disabled' : ''}>${iconHtml('chevron')}</button></span></div></div>` : '';
    const update = updateRowHtml();
    return {
      body: `${update ? `<div class="rows">${update}</div>` : ''}${sectionHtml('Current identity', `<div class="rows">${identityRecordHtml(current, record)}</div>`, isAdmin ? 'Rules bypassed' : getLensFn()?.mode === 'as' ? 'Impersonating' : '')}${sectionHtml('Switch user', `${search}${pagination}<div class="rows" data-user-rows>${matched.join('')}</div>${matched.length ? '' : empty}`, pluralize(available.length, 'user'))}`,
      bar: barHtml(buttons, isAdmin ? 'Rules bypassed' : 'Rules enforced'),
    };
  };

  const listenersViewHtml = (): ChipView => {
    const outlinesOn = listenerMode?.enabled() === true;
    const paintMode: ListenerPaintMode = listenerMode?.mode() ?? paintModeBeforeBuild;
    const flowReason = listenerMode === null ? null : listenerMode.flowUnavailableReason();
    const pressed = (candidate: ListenerPaintMode): boolean => outlinesOn && paintMode === candidate;

    const incidents = listenerOutlines.filter((outline) => outline.incident?.pattern === 'duplicate-listener');
    const ordered = [...listenerOutlines]
      .sort((a, b) => b.deliveryCount - a.deliveryCount || a.label.localeCompare(b.label));

    const rows = [
      ...incidents.map((outline) => buttonRowHtml({
        c1: 'Duplicate subscription',
        s1: `<span class="mono">${escapeAttribute(displayTarget(outline))}</span>`,
        title: displayTarget(outline),
        slot: `<span class="mono">${outline.incident!.count}</span>`,
        className: 'problem',
        attributes: `data-listener-incident="${escapeAttribute(outline.listenerId)}" data-activate-listener="${escapeAttribute(outline.listenerId)}"`,
        label: `Outline the ${outline.incident!.count} subscriptions to ${displayTarget(outline)}`,
        pressed: activeListenerId === outline.listenerId,
      })),
      ...ordered.map((outline) => {
        const target = displayTarget(outline);
        const hue = listenerColors(outline.listenerId).swatch;
        return buttonRowHtml({
          c1: escapeAttribute(outline.labelIsOwner ? outline.label : target),
          s1: outline.labelIsOwner ? `<span class="mono">${escapeAttribute(target)}</span>` : escapeAttribute(outline.service === 'database' ? 'Realtime Database' : 'Firestore'),
          leading: `<span class="listener-mark" style="--listener-color:${escapeAttribute(hue)}"></span>`,
          slot: `<span class="listener-fact"><strong>${outline.deliveryCount}</strong><span>${activeListenerId === outline.listenerId ? 'Highlighted' : 'deliveries'}</span></span>`,
          className: 'listener-row',
          title: `${target} — ${activeListenerId === outline.listenerId ? 'Click to show all listeners' : 'Click to highlight on the page'}`,
          attributes: `data-listener-row="${escapeAttribute(outline.listenerId)}" data-activate-listener="${escapeAttribute(outline.listenerId)}"`,
          label: `Outline ${outline.labelIsOwner ? outline.label : target} on the page`,
          pressed: activeListenerId === outline.listenerId,
        });
      }),
    ];
    const blocked = outlinesRefused;
    const allOn = outlinesOn && paintMode === 'overview' && activeListenerId === null && listenerOutlines.every((outline) => listenerMode?.isListenerVisible(outline.listenerId));
    const toggle = `<button type="button" class="listener-toggle" data-listener-all aria-pressed="${allOn}"><span class="toggle-track" aria-hidden="true"></span>Show all</button>`;
    const bar = barHtml([
      buttonHtml(`data-listener-mode="flow" aria-pressed="${pressed('flow')}"${flowReason === null ? '' : ' disabled'}`, 'Flow', flowReason ?? 'Show what rendered after each delivery'),
      buttonHtml('data-open-overlay-theme', 'Theme', "Edit the overlay's custom properties"),
    ]);
    const detail = blocked ?? (listenerMode?.flowWaiting() ? 'Waiting for the next delivery to show what rendered.' : activeListenerId ? 'Selected listener highlighted. Use Show all to restore every outline.' : 'Select a listener to highlight its components on your page.');
    const flowHint = flowReason ? `<span class="hint" data-flow-unavailable>${escapeAttribute(flowReason)}</span>` : '';
    return { body: `${introHtml('Listeners on this page', detail, flowHint)}${sectionHtml(pluralize(listenerOutlines.length, 'listener'), `<div class="rows" data-listener-rows>${rows.join('')}</div>${rows.length ? '' : emptyHtml('No listeners attached', 'Open a part of your app that subscribes to data to see it here.')}`, '', toggle)}`, bar };
  };

  let expandedRequestId: string | null = null;
  const trafficViewHtml = (): ChipView => {
    const rows = trafficRows().map((request) => {
      // Keep named cells stable for copying while the path owns the main line.
      const named = request.service !== null && request.method !== null;
      const call = named ? `${request.service}.${request.method}` : 'runtime';
      const what = named ? request.path ?? '' : request.label ?? request.service ?? request.method ?? '';
      return buttonRowHtml({
        c1: escapeAttribute(call),
        c2: named ? `<span class="mono">${escapeAttribute(what)}</span>` : escapeAttribute(what),
        s1: `<span class="mono">${clockTime(request.at)}</span>`,
        s2: escapeAttribute(request.reason ?? ''),
        slot: `<span class="verdict ${request.verdict === 'ok' ? 'ok' : ''}">${request.verdict}</span>`,
        className: `traffic-row${request.verdict === 'ok' ? '' : ' problem'}`,
        title: [call, what, request.reason].filter(Boolean).join(' —'),
        attributes: `data-request-row="${escapeAttribute(request.id)}" data-inspect-request="${escapeAttribute(request.id)}"`,
        label: `${call}: ${what}. ${request.verdict}. ${expandedRequestId === request.id ? 'Collapse' : 'Expand'} full path`,
        expanded: expandedRequestId === request.id,
      });
    });
    const copy = `<button class="btn icon-button" type="button" data-copy-traffic aria-label="Copy traffic" title="Copy traffic"${clipboard && rows.length ? '' : ' disabled'}>${iconHtml('copy')}</button>`;
    const bar = barHtml([
      buttonHtml(`data-traffic-denied aria-pressed="${trafficFilter === 'denied'}"`, 'Denied only'),
    ]);
    return { body: `${introHtml('Recent traffic', 'Select a request to expand its full path.')}${sectionHtml(trafficFilter === 'denied' ? 'Denied & failed' : 'Latest requests', `<div class="rows" data-traffic-rows>${rows.join('')}</div>${rows.length ? '' : emptyHtml(trafficFilter === 'denied' ? 'No denied or failed requests' : 'No requests yet', 'Use your app to see its data activity here.')}`, `${rows.length} shown`, copy)}`, bar };
  };

  const sandboxViewHtml = (): ChipView => {
    const aiState = aiEngineState();
    const rows = [
      rowHtml({ c1: 'Model', s1: aiState.detail ? escapeAttribute(aiState.detail) : aiState.primary === 'sandbox (scripted)' ? 'Scripted responses for local development' : 'Responses use the configured provider', slot: escapeAttribute(aiState.primary.replace(/^sandbox \((.*)\)$/, '$1')), attributes: 'data-ai-row', title: aiState.detail ?? aiState.primary }),
      rowHtml({ c1: 'Worker', s1: snapshot.updateAvailable ? 'A newer version is available' : snapshot.runningEpoch ? 'Current sandbox version' : 'Waiting for the sandbox to connect', slot: `<span class="mono" data-running-epoch>${escapeAttribute(snapshot.runningEpoch?.slice(0, 8) ?? 'Pending')}</span>`, attributes: 'data-worker-row', title: snapshot.runningEpoch }),
    ];
    const theme = rowHtml({ c1: 'Theme', s1: 'Colors and outlines for listeners', slot: buttonHtml(`data-open-overlay-theme${options.listeners ? '' : ' disabled'}`, 'Edit', options.listeners ? "Edit the overlay's custom properties" : 'Listener overlays are unavailable on this page'), attributes: 'data-theme-row' });
    return {
      body: `${introHtml('Your local sandbox', 'The configuration behind this page.')}${sectionHtml('Runtime', `<div class="rows">${rows.join('')}</div>`)}${sectionHtml('Page overlays', `<div class="rows">${theme}</div>`)}`,
      bar: barHtml([buttonHtml('data-dismiss-chip', 'Hide', 'Hide pyric on this page')], 'Hide until reload'),
    };
  };

  const viewHtml = (activeUid: string | null, isAdmin: boolean): ChipView => {
    if (tab === 'identity') return identityViewHtml(activeUid, isAdmin);
    if (tab === 'listeners') return options.listeners ? listenersViewHtml() : { body: emptyHtml('Listeners unavailable', 'This page has no listener event source. Connect the sandbox to inspect subscriptions.'), bar: barHtml([]) };
    if (tab === 'traffic') return trafficViewHtml();
    return sandboxViewHtml();
  };

  const render = (next = snapshot): void => {
    const openProviders = [...root.querySelectorAll<HTMLDetailsElement>('[data-user-providers][open]')].map((details) => details.dataset.userProviders);
    const providerFocus = root.activeElement?.closest('[data-user-providers]')?.getAttribute('data-user-providers');
    const previousView = root.querySelector<HTMLElement>('[data-chip-view]');
    const scrollTop = previousView?.dataset.chipView === tab ? previousView.scrollTop : 0;
    const active = root.activeElement as HTMLElement | null;
    const focusAttribute = [
      'data-identity-query',
      'data-collapse',
      'data-expand',
      'data-open-studio',
      'data-chip-tab',
      'data-sign-out',
      'data-toggle-bypass',
      'data-switch-user',
      'data-create-user',
      'data-user-previous',
      'data-user-next',
      'data-listener-all',
      'data-listener-mode',
      'data-activate-listener',
      'data-inspect-request',
      'data-traffic-denied',
      'data-copy-traffic',
      'data-open-overlay-theme',
      'data-update-worker',
      'data-dismiss-chip',
    ].find((attribute) => active?.hasAttribute(attribute));
    const focusToken = focusAttribute === undefined
      ? null
      : {
          attribute: focusAttribute,
          value: active?.getAttribute(focusAttribute) ?? null,
          caret: isTextField(active) ? active.selectionStart : null,
        };
    snapshot = next;
    renderedFlowWaiting = listenerMode?.flowWaiting() === true;

    const lens = getLensFn();
    const user = readCurrentUser();
    const isAdmin = lens?.mode === 'admin';
    const activeUid = (lens?.mode === 'as' ? lens.uid : user?.uid) ?? null;
    const errorCount = snapshot.errors.length;

    const current = signals();
    const problem = problemTab(current);
    // The pill's border is the page's state: the error colour outranks the
    // warning colour because a failure is about the page as it is running.
    const chipTone = current.failedRecently || current.duplicateListener ? ' error' : current.updatePending ? ' warning' : '';
    const chipTitle = current.failedRecently
      ? 'A request failed in the last minute'
      : current.duplicateListener ? 'A listener is attached twice' : current.updatePending ? 'New worker available' : '';
    const tabsHtml = CHIP_TABS.map((candidate) => {
      const tone = candidate !== problem
        ? ''
        : current.failedRecently || current.duplicateListener ? ' problem' : ' pending';
      return `<button class="tab${tone}" type="button" role="tab" id="pyric-tab-${candidate}" data-chip-tab="${candidate}" tabindex="${candidate === tab ? 0 : -1}" aria-selected="${candidate === tab}" aria-controls="pyric-view">${CHIP_TAB_LABELS[candidate]}</button>`;
    }).join('');

    const studioSection = tab === 'identity'
      ? { section: 'auth', query: undefined }
      : tab === 'listeners'
        ? { section: 'traffic', query: 'view=listeners' }
        : tab === 'traffic'
          ? { section: 'traffic', query: undefined }
          : { section: 'settings', query: undefined };
    const studioHref = studioUrl === null || studioUrl === undefined
      ? null
      : studioSectionUrl(studioUrl, studioSection.section, studioSection.query);
    const studioHtml = studioHref === null
      ? `<span class="btn" data-open-studio aria-disabled="true" title="Pyric Studio is disabled">Studio${iconHtml('external')}</span>`
      : `<a class="btn" data-open-studio href="${escapeAttribute(studioHref)}" target="_blank" rel="noopener noreferrer" title="Open this view in Studio">Studio${iconHtml('external')}</a>`;

    if (open) installChipFonts(documentLike);
    const built = open ? viewHtml(activeUid, isAdmin) : { body: '', bar: '' };
    view.innerHTML = open
      ? `<section class="panel" role="dialog" aria-label="pyric"><div class="panel-column">
        <header class="panel-header">
          <span class="brand"><span class="panel-name">pyric</span></span>
          <span class="actions">${studioHtml}<button class="btn icon-button" type="button" data-collapse title="Minimize pyric" aria-label="Minimize pyric">${iconHtml('minimize')}<span class="sr-only">Close</span></button></span>
        </header>
        <div class="tabs" role="tablist" aria-label="pyric views">${tabsHtml}</div>
        <div class="view" id="pyric-view" role="tabpanel" data-chip-view="${tab}" aria-labelledby="pyric-tab-${tab}"><div class="view-content">${built.body}</div></div>
        ${built.bar}
      </div></section>`
      : `<button class="chip${chipTone}" type="button" data-expand aria-label="Open pyric" aria-expanded="false"${chipTitle ? ` title="${chipTitle}"` : ''}>pyric</button>`;

    for (const details of root.querySelectorAll<HTMLDetailsElement>('[data-user-providers]')) {
      details.open = openProviders.includes(details.dataset.userProviders);
      if (providerFocus === details.dataset.userProviders) details.querySelector('summary')?.focus({ preventScroll: true });
    }
    const scrollView = root.querySelector<HTMLElement>('[data-chip-view]');
    if (scrollView) scrollView.scrollTop = scrollTop;
    for (const photo of root.querySelectorAll<HTMLImageElement>('[data-avatar]')) {
      photo.addEventListener('error', () => { photo.hidden = true; });
    }

    const announcement = `${errorCount === 0 ? 'No runtime errors' : `${errorCount} runtime ${errorCount === 1 ? 'error' : 'errors'}`}.${open ? ` ${CHIP_TAB_LABELS[tab]}.` : ''}`;
    if (announcer.textContent !== announcement) announcer.textContent = announcement;

    if (renderedOpen !== open) {
      // The panel is a new surface on every open, so it fades in each time. The
      // chip fades in once, when the page first gets it; coming back from the
      // panel is a return, not an arrival.
      if (open) view.querySelector('.panel')?.classList.add('entering');
      renderedOpen = open;
    }

    root.querySelector('[data-expand]')?.addEventListener('click', () => {
      openPanel();
      render();
      root.querySelector<HTMLButtonElement>('[data-collapse]')?.focus();
    });
    root.querySelector('[data-collapse]')?.addEventListener('click', () => {
      open = false;
      render();
      root.querySelector<HTMLButtonElement>('[data-expand]')?.focus();
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-chip-tab]')) {
      button.addEventListener('keydown', (event) => {
        const index = CHIP_TABS.indexOf(tab);
        const nextIndex = event.key === 'ArrowRight' ? (index + 1) % CHIP_TABS.length
          : event.key === 'ArrowLeft' ? (index + CHIP_TABS.length - 1) % CHIP_TABS.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? CHIP_TABS.length - 1 : null;
        if (nextIndex === null) return;
        event.preventDefault();
        showTab(CHIP_TABS[nextIndex]!);
        root.querySelector<HTMLButtonElement>(`[data-chip-tab="${tab}"]`)?.focus();
      });
      button.addEventListener('click', () => {
        const next = button.dataset.chipTab;
        if (next === undefined) return;
        showTab(next as ChipTab);
      });
    }
    const queryInput = root.querySelector<HTMLInputElement>('[data-identity-query]');
    queryInput?.addEventListener('input', () => {
      identityQuery = queryInput.value;
      identityPage = 0;
      render();
    });
    for (const direction of ['previous', 'next'] as const) {
      root.querySelector(`[data-user-${direction}]`)?.addEventListener('click', () => {
        identityPage += direction === 'next' ? 1 : -1;
        render();
        const userRows = root.querySelector('[data-user-rows]');
        userRows?.scrollIntoView?.({ block: 'nearest' });
      });
    }
    root.querySelector('[data-sign-out]')?.addEventListener('click', () => {
      void identity.signOut();
    });
    root.querySelector('[data-toggle-bypass]')?.addEventListener('click', () => {
      setLensFn(getLensFn()?.mode === 'admin' ? undefined : { mode: 'admin' });
      render();
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-switch-user]')) {
      button.addEventListener('click', () => {
        const uid = button.dataset.switchUser;
        if (uid === undefined) return;
        void identity.switchUser(uid);
      });
    }
    root.querySelector('[data-create-user]')?.addEventListener('click', () => {
      identity.openCreateUser();
    });
    root.querySelector('[data-listener-all]')?.addEventListener('click', () => {
      const mode = ensureListenerMode();
      if (!mode) return;
      const allOn = mode.enabled() && mode.mode() === 'overview' && activeListenerId === null && mode.outlines().every((outline) => mode.isListenerVisible(outline.listenerId));
      activeListenerId = null;
      for (const outline of mode.outlines()) mode.setListenerVisible(outline.listenerId, true);
      if (!allOn) mode.setMode('overview');
      mode.setEnabled(!allOn);
      outlinesRefused = !allOn && !mode.enabled() ? 'Listener attribution is off in this build, so there are no owners to outline.' : null;
      listenerOutlines = mode.outlines();
      render();
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-listener-mode]')) {
      button.addEventListener('click', () => {
        const mode = ensureListenerMode();
        if (mode === null) return;
        const paint: ListenerPaintMode = button.dataset.listenerMode === 'flow' ? 'flow' : 'overview';
        // A pressed mode pressed again is the outlines going off; anything
        // else is that mode going on.
        if (mode.enabled() && mode.mode() === paint) {
          mode.setEnabled(false);
          activeListenerId = null;
          for (const outline of mode.outlines()) mode.setListenerVisible(outline.listenerId, true);
          outlinesRefused = null;
        } else {
          mode.setMode(paint);
          mode.setEnabled(true);
          outlinesRefused = mode.enabled()
            ? mode.mode() === paint ? null : mode.flowUnavailableReason()
            : 'Listener attribution is off in this build, so there are no owners to outline.';
        }
        listenerOutlines = mode.outlines();
        render();
      });
    }
    // A listener row singles its listener out on the page: the outlines come
    // on if they were off, and only that listener is painted until the row is
    // pressed again.
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-activate-listener]')) {
      button.addEventListener('click', () => {
        const mode = ensureListenerMode();
        const listenerId = button.dataset.activateListener;
        if (mode === null || listenerId === undefined) return;
        activeListenerId = activeListenerId === listenerId ? null : listenerId;
        for (const outline of mode.outlines()) {
          mode.setListenerVisible(outline.listenerId, activeListenerId === null || outline.listenerId === activeListenerId);
        }
        if (activeListenerId !== null && !mode.enabled()) {
          mode.setMode('overview');
          mode.setEnabled(true);
        }
        if (!mode.enabled()) {
          activeListenerId = null;
          outlinesRefused = 'Listener attribution is off in this build, so there are no owners to outline.';
        } else {
          outlinesRefused = null;
        }
        listenerOutlines = mode.outlines();
        render();
      });
    }
    for (const row of root.querySelectorAll<HTMLButtonElement>('[data-inspect-request]')) {
      row.addEventListener('click', () => {
        expandedRequestId = expandedRequestId === row.dataset.inspectRequest ? null : row.dataset.inspectRequest ?? null;
        render();
      });
    }
    root.querySelector('[data-traffic-denied]')?.addEventListener('click', () => {
      trafficFilter = trafficFilter === 'denied' ? 'all' : 'denied';
      render();
    });
    root.querySelector('[data-copy-traffic]')?.addEventListener('click', (event) => {
      if (!clipboard) return;
      const button = event.currentTarget as HTMLButtonElement;
      const lines = [...root.querySelectorAll<HTMLElement>('[data-request-row]')]
        .map((row) => {
          const cell = (selector: string): string => row.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          return [cell('.c1'), cell('.c2'), cell('.slot'), cell('.s1'), cell('.s2')].filter((part) => part !== '').join('  ');
        });
      if (lines.length === 0) return;
      void clipboard.writeText(lines.join('\n')).catch(() => {
        button.setAttribute('data-copy-failed', '');
        button.title = 'Copy failed';
      });
    });
    root.querySelector('[data-open-overlay-theme]')?.addEventListener('click', (event) => {
      if (ensureListenerMode() === null) return;
      themeDialog().open(event.currentTarget as HTMLElement);
    });
    root.querySelector('[data-update-worker]')?.addEventListener('click', () => {
      if (!snapshot.updateAvailable || snapshot.updatingWorker) return;
      void options.runtime.updateWorker().catch(() => { /* status records and renders the failure */ });
    });
    root.querySelector('[data-dismiss-chip]')?.addEventListener('click', () => {
      host.style.display = 'none';
    });

    if (focusToken) {
      const candidates = root.querySelectorAll<HTMLElement>(`[${focusToken.attribute}]`);
      const replacement = [...candidates].find((candidate) =>
        focusToken.value === null || candidate.getAttribute(focusToken.attribute) === focusToken.value);
      replacement?.focus({ preventScroll: true });
      if (focusToken.caret !== null && isTextField(replacement)) {
        replacement.setSelectionRange(focusToken.caret, focusToken.caret);
      }
    }
    // The sandbox's users are only read when the view that lists them is up.
    if (open && tab === 'identity' && !usersRequested) void loadUsers();
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

  // The Listeners rows and the collapsed count read the mode's fold, so the
  // mode exists from the start; the control only turns the painting on.
  ensureListenerMode();

  const unsubAuth = identity.subscribeAuth((next) => {
    clientUser = next;
    render();
  });

  mounted = true;
  render();
  // The chip fades in once, when the page first gets it. The class sits on the
  // stable container rather than on the chip, so a render right behind the
  // mount can neither replay the animation nor cut it short.
  view.classList.add('entering');

  return {
    element: host,
    dispose() {
      unsubscribe();
      unsubLens();
      unsubAuth();
      documentLike.removeEventListener('astro:after-swap', reattachAfterAstroSwap);
      themeDialogController?.dispose();
      trafficFeed?.dispose();
      listenerMode?.dispose();
      host.remove();
    },
  };
}
