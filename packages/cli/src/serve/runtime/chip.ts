import { requestStatusLabel } from 'pyric/sandbox/internal';
import { workerAiRates } from './worker-ai-rates.js';
import { aiModelHtml } from './ai-model-label.js';
import { projectCaptures, captureList, captureEditor } from './project-captures.js';
import type { CaptureEntry } from '../rate-capture-store.js';
import { buildRateCapture, readRateCapture, readSessionFixture } from './rate-capture.js';
import { createThresholdConfigClient, type ThresholdConfigClient } from './threshold-config-client.js';
import { createThresholdSettings, thresholdSettingsHtml, refreshThresholdForm, THRESHOLD_STYLES } from './threshold-settings.js';
import { createRateThresholdMonitor } from './rate-threshold-monitor.js';
import { isThresholdService } from './rate-threshold-config.js';
import { createRateHistory, bindHistory } from './rate-history.js';
import { serviceLabel } from './service-presentation.js';
import { RATE_STYLES, rateView, refreshRateView } from './chip-rates.js';
import { sdkRates, sdkActivity } from 'pyric/sandbox/internal';
import { RULE_EVIDENCE_STYLES } from './chip-rules-evidence-styles.js';
import { INDEX_STYLES, indexDetailsHtml, indexActionHtml } from './chip-indexes.js';
import { createIndexInspector, createIndexConfigClient, type IndexConfigClient } from './index-config-client.js';
import type { ServiceIndexQuery } from 'pyric/sandbox/internal';
import { rulesEvidenceHtml, rulesSummary } from './chip-rules-evidence.js';
import { createDenialMarkers } from './denial-markers.js';
import { activityDisplayTarget } from './activity-history.js';
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
  aiTrafficRequest,
  isPermissionDeniedCode,
  orderChipRequests,
  RECENT_FAILURE_MS,
  type ChipRequest,
  type TrafficFeed,
} from './chip-traffic.js';
import { createChipDataView, type ChipDataView } from './chip-data-view.js';
import {
  barHtml,
  buttonHtml,
  buttonRowHtml,
  clockTime,
  emptyHtml,
  escapeAttribute,
  iconHtml,
  pluralize,
  rowHtml,
  sectionHtml,
  type ChipView,
} from './chip-markup.js';
import type { SandboxEventSource } from './listener-event-source.js';
import {
  getLens as defaultGetLens,
  setLens as defaultSetLens,
  subscribeLens as defaultSubscribeLens,
} from '../worker/client/core.js';

export interface PyricRuntimeChipOptions {
  /** Host configuration for future AI actions; request evidence remains in Traffic. */
  aiConfiguration?: {
    getSnapshot(): { backend: string; requestedModel: string; route: string };
    subscribe(listener: () => void): () => void;
  };
  rates?: Pick<typeof sdkRates, 'snapshot'>;
  indexConfig?: IndexConfigClient | null;
  thresholdConfig?: ThresholdConfigClient | null;
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
  /** Optional in-page session fixture provider; otherwise use the protected CLI capture endpoint. */
  captureSession?: () => Promise<unknown>;
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

function configuredAiRoute(): string {
  const engine = (globalThis as { __PYRIC_AI_ENGINE__?: { kind?: string; model?: string } }).__PYRIC_AI_ENGINE__;
  if (engine?.kind === 'scripted') return 'No model invoked';
  return engine?.model ?? 'Not reported';
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
  .panel-column { display: grid; grid-template-rows: 64px 44px minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
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
  .request-response { position:relative; background:var(--pyric-content); border:1px solid var(--pyric-border-soft); border-radius:8px; overflow:hidden; }
  .request-response-body { margin:0; max-height:320px; overflow:auto; white-space:pre; overflow-wrap:normal; line-height:1.5; padding:var(--space-3); padding-right:52px; }
  .request-response-copy { position:absolute; top:8px; right:8px; }
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
  .slot .verdict { width: 80px; min-width: 80px; }
  .row.problem .slot, .row.problem .c1 { color: var(--pyric-error); }
  .row.pending .slot, .row.pending .c1 { color: var(--pyric-warning); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); width: 88px; height: 32px; flex: 0 0 88px; border: 1px solid #454b59; border-radius: 6px; background: #282d37; color: #dbe1ed; cursor: pointer; font-size: 11px; font-weight: 550; line-height: 16px; text-decoration: none; white-space: nowrap; }
  .btn:hover:not(:disabled):not([aria-disabled="true"]) { background: #343d4d; border-color: #76839b; color: #fff; }
  .btn:disabled, .btn[aria-disabled="true"] { cursor: not-allowed; opacity: .5; }
  .btn[aria-pressed="true"] { background: #35435e; border-color: #829ac9; color: #dce6ff; }
  .btn.icon-button { width: 32px; flex-basis: 32px; background: transparent; }
  [data-open-studio] { background: transparent; border-color: var(--pyric-border-soft); }
  .bar { min-height: 64px; border-top: 1px solid var(--pyric-border-soft); background: var(--pyric-content); }
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
  .source-row { display:grid; grid-template-columns:minmax(0,1fr) 32px var(--space-3); align-items:center; }
  .source-row + .source-row { border-top:1px solid var(--pyric-border-soft); }
  .source-row .row { min-width:0; }
  .source-highlight { width:32px; height:32px; display:flex; align-items:center; justify-content:center; color:var(--pyric-muted); border:1px solid transparent; border-radius:4px; cursor:pointer; }
  .source-highlight .icon { width:16px; height:16px; }
  .source-highlight:hover,.source-highlight[aria-pressed="true"] { color:var(--pyric-accent); background:var(--pyric-content); border-color:var(--pyric-border); }
  .source-highlight:disabled { opacity:.4; cursor:not-allowed; color:var(--pyric-muted); background:none; border-color:transparent; }
  .unplaced-reason { display:block; color:var(--pyric-muted); }
  .source-highlight:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:2px; }
  .listener-mark { width: 10px; height: 10px; border: 2px solid var(--listener-color); border-radius: 3px; }
  .source-row:has(.source-highlight[aria-pressed="true"]) .listener-mark { background: var(--listener-color); }
  .listener-row .row-content { grid-template-columns: 12px minmax(0, 1fr) 88px; }
  .listener-row .c1.wide, .listener-row .s1.wide { grid-column: 2; }
  .listener-row .s2 { grid-column: 2; grid-row: 3; white-space: normal; overflow-wrap: anywhere; }
  .listener-fact { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1); }
  .listener-fact strong { color: #dce2ed; font-weight: 550; font-variant-numeric: tabular-nums; }
  .row[aria-pressed="true"] .listener-fact { color: var(--pyric-accent); }
  .traffic-row .row-content { grid-template-columns: minmax(0, 1fr) 72px 80px; grid-template-rows: 24px auto; align-items: start; column-gap: var(--space-2); }
  .traffic-row .c1 { grid-column: 1; grid-row: 1; color: var(--pyric-muted); font-size: 11px; font-weight: 400; line-height: 24px; }
  .traffic-row .c2 { grid-column: 1 / -1; grid-row: 2; }
  .traffic-row .s1 { grid-column: 2; grid-row: 1; text-align: left; line-height: 24px; }
  .traffic-row .s1 .mono { font-size: 11px; }
  .traffic-row .s2 { grid-column: 1 / -1; grid-row: 3; white-space: normal; overflow-wrap: anywhere; }
  .traffic-row .s2:empty { display: none; }
  .traffic-row[aria-expanded="true"] .c2 { white-space: normal; overflow-wrap: anywhere; }
  [data-chip-view="sandbox"] .s1 { white-space: normal; overflow-wrap: anywhere; }
  .traffic-row .slot { grid-column: 3; grid-row: 1; align-self: start; }
  .activity-detail { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; grid-template-rows: 0 auto 0; gap: var(--record-inset); border-top: 1px solid var(--pyric-border-soft); }
  .activity-detail-content { grid-column: 2; grid-row: 2; display: grid; gap: var(--space-2); font-size: 11px; }
  .activity-path { overflow-wrap: anywhere; }
  .data-path { display: flex; align-items: baseline; min-width: 0; font-family: "Pyric Geist Mono", ui-monospace, monospace; font-size: 12px; font-weight: 400; }
  .data-path-parent { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pyric-muted); }
  .data-path-leaf { flex: 0 0 auto; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pyric-text); }
  .data-breadcrumbs { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 24px; font-size: 12px; }
  .data-breadcrumbs button { font: inherit; color: var(--pyric-accent); background: transparent; border: 0; height: 28px; cursor: pointer; }
  .data-breadcrumbs .icon { width: 12px; height: 12px; flex: 0 0 12px; }
  .breadcrumb-service { font-weight: 600; white-space: nowrap; }
  .breadcrumb-target { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .source-navigation { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; }
  ${RULE_EVIDENCE_STYLES}
  ${INDEX_STYLES}
  ${RATE_STYLES}
  ${THRESHOLD_STYLES}
  .request-facts { all: unset; }
  .request-detail, .request-facts { display: grid; gap: 16px; }
  .request-fact { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; font-size: 12px; }
  .request-fact dt { color: var(--pyric-muted); }
  .request-fact dd { all: unset; min-width: 0; overflow-wrap: anywhere; }
  .nav-link { display: inline-flex; align-items: center; gap: 4px; height: 28px; font-size: 12px; color: var(--pyric-accent); text-decoration: underline; text-underline-offset: 3px; white-space: nowrap; }
  .nav-link .icon { width: 12px; height: 12px; }
  .source-actions, .history-summary, .activity-fact { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .source-actions { font-weight: 600; }
  .history-body { display: grid; gap: 12px; min-width: 0; }
  .history-summary { font-size: 11px; color: var(--pyric-muted); }
  .history-summary .btn { width: 48px; flex-basis: 48px; height: 28px; }
  .history-context { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; column-gap: var(--record-inset); }
  .history-context > * { grid-column: 2; }
  .history-pagination { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .history-row .row-content { grid-template-columns: minmax(0, 1fr) 132px; }
  .history-row .c1.wide, .history-row .s1.wide { grid-column: 1; }
  .history-row .slot { grid-column: 2; grid-row: 1 / 3; align-self: start; }
  .history-row .listener-fact { font-size: 11px; }
  .history-row .s2 { grid-column: 1 / -1; grid-row: 3; white-space: normal; overflow-wrap: anywhere; }
  .listener-toolbar { display: grid; grid-template-columns: auto minmax(0, 1fr) 32px; align-items: center; gap: var(--space-2); width: 100%; min-width: 0; }
  .paint-switch { display: grid; grid-template-columns: repeat(2, 64px); gap: 4px; }
  .paint-switch .btn { width: 64px; min-width: 0; font-size: 11px; }
  .listener-toolbar select, .request-controls select { font: inherit; font-size: 11px; color: var(--pyric-text); background: var(--pyric-content); border: 1px solid var(--pyric-border); border-radius: 6px; width: 100%; height: 32px; min-width: 0; text-overflow: ellipsis; }
  .listener-toolbar select:focus-visible, .request-controls select:focus-visible { outline: 2px solid var(--pyric-accent); outline-offset: 2px; }
  .request-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding-inline-end: var(--record-inset); }
  .request-controls select { appearance: none; padding-inline: var(--space-3) 28px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%23a4acbb' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right var(--space-2) center; background-size: 16px; }
  .request-pagination .btn { width: auto; padding-inline: var(--space-3); justify-self: start; }
  .request-retention { margin: 0; }
  .sandbox-ai-facts { grid-column: 2; grid-row: 2; display: grid; gap: var(--space-3); min-width: 0; margin: 0; }
  .sandbox-ai-facts > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); align-items: baseline; gap: var(--space-3); }
  .sandbox-ai-facts dt { color: var(--pyric-muted); font-size: 11px; }
  .sandbox-ai-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: "Pyric Geist Mono", ui-monospace, monospace; font-size: 12px; }

  .listener-toolbar .icon-button { grid-column: 3; }
  .listener-toolbar-notice { grid-column: 1 / -1; display: flex; align-items: center; gap: var(--space-2); }

  .listener-toggle { display: flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: 11px; color: var(--pyric-muted); height: 32px; }
  .toggle-track { width: 28px; height: 16px; display: grid; grid-template-columns: 0 1fr 0; gap: 2px; align-items: center; background: #3a3e49; border: 1px solid #697488; border-radius: 8px; }
  .toggle-track::after { content: ''; grid-column: 2; width: 10px; height: 10px; background: #dce1eb; border-radius: 50%; justify-self: start; }
  .listener-toggle[aria-pressed="true"] .toggle-track { background: #536b9d; border-color: var(--pyric-accent); }
  .listener-toggle[aria-pressed="true"] .toggle-track::after { justify-self: end; }
  .verdict { --verdict-border: #705b62; display: grid; grid-template-columns: 24px minmax(0, 1fr) 8px; align-items: center; box-sizing: border-box; width: 80px; min-width: 80px; height: 24px; border: 1px solid var(--verdict-border); border-radius: 4px; background: #2c282e; color: #d2c6ca; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; }
  .verdict-icon { display: grid; place-items: center; height: 100%; border-right: 1px solid var(--verdict-border); color: #d6a7ae; }
  .verdict-label { text-align: right; }
  .verdict .icon { width: 12px; height: 12px; }
  .verdict.ok { --verdict-border: #586b60; background: #252e2c; color: #c4d2cb; }
  .verdict.ok .verdict-icon { color: #a4c7b5; }
  .traffic-row.problem .c1 { color: #d6a7ae; }
  .traffic-row.pending .c1 { color: #d6c096; }
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

function avatarHtml(photoUrl: string | null | undefined, label: string): string {
  const initials = label.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
  // Profile images may be relative served assets or remote HTTP images.
  const safePhoto = photoUrl && /^(https?:\/\/|\/(?!\/))/.test(photoUrl) ? photoUrl : null;
  return `<span class="avatar" aria-hidden="true"><span>${escapeAttribute(initials || '?')}</span>${safePhoto ? `<img data-avatar src="${escapeAttribute(safePhoto)}" alt="" referrerpolicy="no-referrer">` : ''}</span>`;
}

function introHtml(title: string, hint: string, detail = ''): string {
  return `<div class="intro-rail"><div class="intro"><span class="section-title">${escapeAttribute(title)}</span><span class="hint">${escapeAttribute(hint)}</span>${detail}</div></div>`;
}

/** Traffic is a bounded recent feed; the identity directory has searchable pages. */
const REQUEST_PAGE_SIZE = 25;
const USER_PAGE_SIZE = 20;
const PROVIDER_ICON_LIMIT = 3;

/**
 * Whether a change to the chip's view came from outside render. Opening or
 * closing a details element is not: render carries that state over from the
 * previous view.
 */
function isViewEdit(record: MutationRecord): boolean {
  return !(record.type === 'attributes' && record.attributeName === 'open' && record.target.nodeName === 'DETAILS');
}

/** `true` for an element with a text caret to preserve across a rebuild. */
function isTextField(element: Element | null | undefined): element is HTMLInputElement {
  return element !== null && element !== undefined && element.tagName === 'INPUT';
}

/** A shared icon and label track keeps request statuses aligned across rows. */
function trafficBadgeHtml(verdict: ChipRequest['verdict'], indexMissing: boolean): string {
  const badges = {
    ok: { label: 'Allowed', icon: 'check', tone: 'ok', title: 'Succeeded' },
    denied: { label: 'Denied', icon: 'unavailable', tone: '', title: 'Denied' },
    error: { label: 'Failed', icon: 'warning', tone: '', title: 'Failed' },
    unsupported: { label: 'N/A', icon: 'unavailable', tone: '', title: 'Unsupported operation' },
  };
  const badge = indexMissing && verdict !== 'denied'
    ? { label: 'Index', icon: 'warning', tone: 'index-warning', title: 'Index missing from config' }
    : badges[verdict];
  return `<span class="verdict ${badge.tone}" title="${badge.title}" aria-label="${badge.title}"><span class="verdict-icon">${iconHtml(badge.icon)}</span><span class="verdict-label">${badge.label}</span></span>`;
}

/** Mount the framework-independent runtime chip in an isolated shadow root. */
export function mountPyricRuntimeChip(options: PyricRuntimeChipOptions): PyricRuntimeChip {
  const documentLike = options.document ?? document;
  const existingHost = documentLike.querySelector<HTMLElement>(
    '[data-pyric-runtime-chip-host], pyric-runtime-chip',
  );
  const hasExistingHost = existingHost !== null;
  if (hasExistingHost) {
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
  const view = root.querySelector<HTMLElement>('[data-view]');
  const announcer = root.querySelector<HTMLElement>('.announcer');
  const isMissingView = view === null || announcer === null;
  if (isMissingView) throw new Error('Pyric chip markup is incomplete.');
  const clipboard = options.clipboard ?? documentLike.defaultView?.navigator.clipboard;
  const hasStudioOverride = 'studioUrl' in options;
  const getStudioUrl = (): string | null | undefined => (hasStudioOverride
    ? options.studioUrl
    : options.runtime.getSnapshot().manifest.studioUrl);
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

  // ── Traffic view state ─────────────────────────────────────────────────────
  /** Which requests Traffic lists. A page session remembers nothing here: the
   * filter is a way of reading the last minute, not a preference. */
  let trafficFilter: 'all' | 'denied' = 'all';
  let requestPageSize = REQUEST_PAGE_SIZE;
  let requestService = '';
  let pinnedRequestIds: Set<string> | null = null;
  let requestListScroll = 0;
  let projectAiRates: ReturnType<typeof workerAiRates> | undefined;
  let ratesDirty = true;
  let observesHostAi = false;
  let trafficDisplay: 'requests' | 'rates' = 'requests';
  let selectedRateService: string | null = null;
  let rateSection: 'chart' | 'incidents' | 'measurements' | 'captures' | 'capture-rename' | 'capture-delete' = 'chart';
  const serviceHistories = { ai: createRateHistory('ai'), firestore: createRateHistory('firestore'), rtdb: createRateHistory('rtdb'), storage: createRateHistory('storage') };
  const currentRateHistory = () => serviceHistories[isThresholdService(selectedRateService) ? selectedRateService : 'rtdb'];
  const localRates = options.rates ?? sdkRates;
  const rates = { snapshot: () => {
    const snapshot = localRates.snapshot();
    if (!options.sandboxEvents) return snapshot;
    if (ratesDirty) {
      const ai = (trafficFeed?.requests() ?? []).flatMap(request => request.aiRequest ? [request.aiRequest] : []);
      observesHostAi ||= ai.length > 0;
      projectAiRates = observesHostAi ? workerAiRates(ai) : undefined;
      ratesDirty = false;
    }
    return projectAiRates?.(snapshot) ?? snapshot;
  } };
  let captureError = '';
  let savedCaptureList: CaptureEntry[] | null = null;
  let capturesLoading = false;
  let selectedSavedCapture: CaptureEntry | null = null;
  let captureEditBusy = false;
  let captureNameDraft = '';
  const captureClient = projectCaptures(documentLike.defaultView?.fetch?.bind(documentLike.defaultView) ?? fetch);
  const importedCaptures = new Map<string, string>();
  const captureEvents: import('pyric/sandbox').SandboxEvent[] = [];
  const unsubscribeCapture = options.sandboxEvents?.(events => {
    captureEvents.push(...events);
    const cutoff = Date.now() - 1800_000;
    while (captureEvents.length && (captureEvents[0]!.at < cutoff || captureEvents.length > 20000)) captureEvents.shift();
  });
  const thresholdMonitor = createRateThresholdMonitor();
  let thresholdSignature = '';
  const pageWindow = documentLike.defaultView;
  const canFetchThresholds = pageWindow?.fetch !== undefined && /^https?:$/.test(pageWindow.location.protocol);
  const disablesThresholds = options.thresholdConfig === null;
  let thresholdClient = options.thresholdConfig ?? undefined;
  const needsThresholdClient = !disablesThresholds && thresholdClient === undefined && canFetchThresholds;
  if (needsThresholdClient) thresholdClient = createThresholdConfigClient(pageWindow.fetch.bind(pageWindow));
  const thresholdSettings = createThresholdSettings(thresholdClient, () => { if (mounted) render(); });
  /** `false` until the first render. The fold's history batch arrives while this
   * function is still running, before there is a view for it to rebuild. */
  let mounted = false;
  /** The Data view, built once the index helpers it shares with Traffic exist. */
  let dataView: ChipDataView | null = null;
  const denials = createDenialMarkers({
    document: documentLike,
    related: (service, path) => dataView?.mode()?.relatedRegion?.(service, path) ?? null,
    select: request => {
      selectedRequest = request;
      open = true;
      showTab('traffic');
      root.querySelector<HTMLButtonElement>('[data-request-back]')?.focus();
    },
  });
  const sandboxEvents = options.sandboxEvents;
  const observesSandboxEvents = sandboxEvents !== undefined && sandboxEvents !== null;
  const trafficFeed: TrafficFeed | null = observesSandboxEvents
    ? createTrafficFeed({
      subscribeEvents: sandboxEvents,
      onRequest: (request, event) => {
        const showsDenials = mounted && dataView?.mode()?.enabled() === true;
        if (showsDenials) denials.show(request, event);
      },
      onChange: () => {
        ratesDirty = true;
        const isHydrating = !mounted;
        if (isHydrating) return;
        const showsRequestEvidence = tab === 'sandbox' || (tab === 'traffic' && trafficDisplay === 'requests');
        const needsRender = !open || showsRequestEvidence;
        if (needsRender) render();
      },
    })
    : null;

  /**
   * Traffic's rows: the request stream the page delivers, plus the runtime's own
   * error feed for the failures that are not requests at all. An operation that
   * reached both is one row, keyed by the sandbox event id both carry.
   */
  let trafficSource: { service: string; target: string } | null = null;
  const trafficRows = (): ChipRequest[] => {
    const byId = new Map<string, ChipRequest>();
    const recorded = trafficFeed?.requests() ?? [];
    observesHostAi ||= recorded.some(request => request.aiRequest !== undefined);
    if (!observesHostAi) {
      for (const request of localRates.snapshot().services.find(service => service.service === 'ai')?.aiRequests ?? []) byId.set(request.id, aiTrafficRequest(request));
    }
    for (const request of recorded) byId.set(request.id, request);
    for (const error of snapshot.errors) {
      const representedByHost = observesHostAi && error.service === 'ai';
      const alreadyRepresented = representedByHost || byId.has(error.id);
      if (alreadyRepresented) continue;
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
        identity: null,
      });
    }
    const ordered = orderChipRequests([...byId.values()], Date.now());
    const kept = trafficFilter === 'denied' ? ordered.filter((request) => request.verdict !== 'ok') : ordered;
    const matching = kept.filter(request => !trafficSource || ((request.service === trafficSource.service || (request.service === 'rtdb' && trafficSource.service === 'database')) && activityDisplayTarget(request.path ?? '').replace(/^\//, '') === trafficSource.target.replace(/^\//, '')));
    return matching.filter(request => !requestService || request.service === requestService);
  };

  // ── Which view is showing ──────────────────────────────────────────────────
  const tabStorage = pageChipTabStorage(documentLike);
  const disablesIndexes = options.indexConfig === null;
  let indexClient = options.indexConfig ?? undefined;
  const needsIndexClient = !disablesIndexes && indexClient === undefined && pageWindow?.fetch !== undefined;
  if (needsIndexClient) indexClient = createIndexConfigClient(pageWindow.fetch.bind(pageWindow));
  const indexInspector = createIndexInspector(indexClient, () => { if (mounted) render(); });
  const missingIndex = (query: ServiceIndexQuery | undefined): boolean => query !== undefined && indexInspector.finding(query).status === 'missing';
  const requestMissingIndex = (request: ChipRequest): boolean => {
    if (missingIndex(request.indexQuery)) return true;
    return request.indexFailure === true && (!request.indexQuery || indexInspector.finding(request.indexQuery).status === 'unavailable');
  };
  const signals = (): ChipTabSignals => {
    const now = Date.now();
    const failedRecently = trafficFeed?.failedRecently(now) === true
      || snapshot.errors.some((error) => now - error.at <= RECENT_FAILURE_MS);
    return {
      failedRecently,
      rateThreshold: thresholdMonitor.pending(),
      missingIndex: (trafficFeed?.requests() ?? []).some(requestMissingIndex) || (dataView?.outlines() ?? []).some(outline => missingIndex(outline.activity?.indexQuery)),
      duplicateListener: (dataView?.outlines() ?? []).some((outline) => outline.incident?.pattern === 'duplicate-listener'),
      updatePending: snapshot.updateAvailable,
    };
  };
  let tab: ChipTab = openingChipTab(signals(), readRememberedChipTab(tabStorage));
  let open = options.initiallyOpen ?? false;
  /** The `open` value the view was last built for; the panel's enter animation plays only when it changes. */
  let renderedOpen: boolean | null = null;
  /** The markup the view was last built from, or null once the view is edited outside render. */
  let renderedMarkup: string | null = null;
  const ViewObserver = documentLike.defaultView?.MutationObserver;
  const viewEdits = ViewObserver === undefined ? null : new ViewObserver((records) => { if (records.some(isViewEdit)) renderedMarkup = null; });
  viewEdits?.observe(view, { subtree: true, childList: true, attributes: true, characterData: true });
  const openPanel = (): void => {
    tab = openingChipTab(signals(), readRememberedChipTab(tabStorage));
    if (thresholdMonitor.pending() && !signals().failedRecently) { trafficDisplay = 'rates'; selectedRateService = null; }
    if (tab === 'identity' && usersFailed) usersRequested = false;
    open = true;
  };

  const showTab = (next: ChipTab): void => {
    if (next !== 'listeners') dataView?.leave();
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
      readTheme: () => dataView?.mode()?.overlayTheme() ?? {},
      applyTheme: (theme) => {
        dataView?.mode()?.setOverlayTheme(theme);
      },
    });
    return themeDialogController;
  };

  // ── The four views ─────────────────────────────────────────────────────────

  /** The listener a row click singled out on the page, if any. */
  const indexTargets = new Map<string, { query: ServiceIndexQuery; sourceId?: string }>();
  const indexBlock = (query: ServiceIndexQuery | undefined, key: string, sourceId?: string): string => {
    if (!query) return '';
    indexTargets.set(key, { query, sourceId });
    indexInspector.prepare(key, query);
    return indexDetailsHtml(query, key, indexInspector, escapeAttribute, iconHtml('chevron'), iconHtml('copy'));
  };


  dataView = createChipDataView({
    document: documentLike,
    build: options.listeners,
    render: () => render(),
    showing: () => open && tab === 'listeners',
    reveal: () => { tab = 'listeners'; open = true; },
    showTraffic: (source) => {
      if (source) trafficSource = source;
      trafficFilter = 'all'; trafficDisplay = 'requests'; selectedRequest = null; showTab('traffic');
    },
    missingIndex,
    indexBlock,
    indexAction: (query, key) => indexActionHtml(query, key, indexInspector, escapeAttribute),
  });

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

  let selectedRequest: ChipRequest | null = null;
  const trafficToolbar = (): string => {
    const modes = `<div class="paint-switch" role="group" aria-label="Traffic view">${buttonHtml(`data-traffic-display="requests" aria-pressed="${trafficDisplay === 'requests'}"`, 'Requests')}${buttonHtml(`data-traffic-display="rates" aria-pressed="${trafficDisplay === 'rates'}"`, 'Rates')}</div>`;
    let filter = '';
    if (trafficDisplay === 'requests') filter = buttonHtml(`data-traffic-denied aria-pressed="${trafficFilter === 'denied'}"`, 'Denied only');
    if (trafficDisplay === 'rates' && isThresholdService(selectedRateService)) {
      if (rateSection === 'capture-rename' || rateSection === 'capture-delete') return barHtml([`<div class="traffic-toolbar"><div class="traffic-view-switch">${buttonHtml('data-capture-edit-cancel', 'Cancel')}</div><div class="traffic-actions">${buttonHtml(`data-capture-edit-save ${captureEditBusy ? 'disabled' : ''}`, rateSection === 'capture-delete' ? 'Delete' : 'Save')}</div></div>`]);
      const frame = currentRateHistory().view(rates.snapshot());
      const label = frame?.imported ? 'Return to live' : frame?.paused ? 'Resume live' : 'Pause';
      const primary = rateSection === 'chart' ? buttonHtml(`data-history-toggle data-history-mode="${frame?.paused ? 'live' : 'pause'}"`, label) : buttonHtml('data-rate-chart', 'Back to activity');
      const captureActions = `<button type="button" data-capture-open>Open capture…</button>${frame?.imported ? '<button type="button" data-capture-download>Download JSON</button>' : ''}`;
      const menuActions = rateSection === 'captures' ? '<button type="button" data-capture-import>Open file…</button>'
        : frame?.imported && selectedSavedCapture ? `<button type="button" data-capture-rename>Rename…</button><button type="button" data-capture-delete>Delete…</button>${captureActions}`
        : `<button type="button" data-capture-export>Save capture…</button>${captureActions}${frame?.imported ? '' : `<button type="button" data-open-thresholds>Thresholds…</button><button type="button" data-rate-incidents="${selectedRateService}">Incidents</button><button type="button" data-rate-measurements>Measurements</button>`}`;
      const menu = `<details class="rate-menu"><summary class="btn" role="button" aria-label="More actions" title="More actions"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="13" cy="8" r="1" fill="currentColor"/></svg></summary><div class="rate-menu-items">${menuActions}</div></details>`;
      return barHtml([`<div class="traffic-toolbar">${primary}${menu}</div>`]);
    }
    return barHtml([`<div class="traffic-toolbar">${modes}${filter}</div>`]);
  };
  const trafficViewHtml = (): ChipView => {
    if (trafficDisplay === 'rates') {
      const settings = thresholdSettings.state();
      const crumbs = (service: string, editing = false) => `<div class="history-context"><nav class="data-breadcrumbs" aria-label="Breadcrumb"><button type="button" data-rates-back>Services</button>${iconHtml('chevron')}${editing ? `<button type="button" data-threshold-cancel>${escapeAttribute(serviceLabel(service))}</button>${iconHtml('chevron')}<span aria-current="page">Thresholds</span>` : `<span aria-current="page">${escapeAttribute(serviceLabel(service))}</span>`}</nav></div>`;
      if (settings.service) {
        const footer = `<div class="threshold-footer"><button type="button" class="btn" data-threshold-defaults ${settings.busy ? 'disabled' : ''}>Use defaults</button><span><button type="button" class="btn" data-threshold-cancel ${settings.busy ? 'disabled' : ''}>Cancel</button><button type="button" class="btn" data-threshold-save ${settings.busy || !settings.loaded || !settings.dirty || settings.invalid ? 'disabled' : ''}>${settings.saving ? 'Saving' : 'Save'}</button></span></div>`;
        return { body: crumbs(settings.service, true) + sectionHtml('Thresholds', thresholdSettingsHtml(thresholdSettings, escapeAttribute), settings.saving ? 'Saving' : settings.busy ? 'Loading' : settings.project ? 'Project' : 'This session'), bar: barHtml([footer]) };
      }
      const alerts = thresholdMonitor.incidents().filter(incident => !selectedRateService || incident.service === selectedRateService);
      const alertHtml = alerts.length ? sectionHtml('Recorded incidents', `<div class="rows">${alerts.map(incident => `<button type="button" class="rate-alert" data-rate-incident="${escapeAttribute(incident.id)}"><span>${escapeAttribute(incident.label)}<small>${escapeAttribute(serviceLabel(incident.service))} · ${new Date(incident.at).toLocaleTimeString()}</small><small>Peak ${incident.peak}/s · limit ${incident.limit}/s</small><small>${incident.aboveSeconds}s above limit / ${incident.to - incident.from + 1}s elapsed</small></span><span class="rate-alert-status">${iconHtml('warning')}<span>Exceeded</span></span></button>`).join('')}</div>`) : '';
      const incidentCounts = new Map(['firestore', 'rtdb', 'storage', 'ai'].map(service => [service, thresholdMonitor.incidents().filter(incident => incident.service === service).length]));
      const frame = isThresholdService(selectedRateService) ? currentRateHistory().view(rates.snapshot()) : undefined;
      const measured = rateView(rates.snapshot(), selectedRateService, serviceLabel, escapeAttribute, frame, iconHtml('chevron'), incidentCounts, rateSection === 'measurements' ? 'measurements' : 'chart');
      if (!selectedRateService) return { body: sectionHtml(measured.title, measured.body), bar: trafficToolbar() };
      const secondary = rateSection === 'capture-rename' ? 'Rename capture' : rateSection === 'capture-delete' ? 'Delete capture' : rateSection === 'chart' ? '' : rateSection === 'incidents' ? 'Incidents' : rateSection === 'captures' ? 'Captures' : 'Measurements';
      const breadcrumb = frame?.imported && selectedSavedCapture && rateSection === 'chart'
        ? `<div class="history-context"><nav class="data-breadcrumbs" aria-label="Breadcrumb"><button type="button" data-rates-back>Services</button>${iconHtml('chevron')}<button type="button" data-capture-open>Captures</button>${iconHtml('chevron')}<span aria-current="page">${escapeAttribute(selectedSavedCapture.name || serviceLabel(selectedRateService))}</span></nav></div>`
        : secondary ? `<div class="history-context"><nav class="data-breadcrumbs" aria-label="Breadcrumb"><button type="button" data-rates-back>Services</button>${iconHtml('chevron')}${rateSection === 'captures' ? '' : rateSection === 'capture-rename' || rateSection === 'capture-delete' ? `<button type="button" data-capture-open>Captures</button>${iconHtml('chevron')}` : `<button type="button" data-rate-chart>${escapeAttribute(serviceLabel(selectedRateService))}</button>${iconHtml('chevron')}`}<span aria-current="page">${secondary}</span></nav></div>` : crumbs(selectedRateService);
      const body = selectedSavedCapture && (rateSection === 'capture-rename' || rateSection === 'capture-delete') ? captureEditor(rateSection === 'capture-rename' ? { ...selectedSavedCapture, name: captureNameDraft } : selectedSavedCapture, rateSection === 'capture-delete', escapeAttribute) : rateSection === 'captures' ? `<section class="section">${captureList(savedCaptureList, capturesLoading, escapeAttribute)}</section>` : rateSection === 'incidents' ? alertHtml || emptyHtml('No incidents', 'No thresholds have been exceeded.') : `<section class="section">${measured.body}</section>`;
      return { body: breadcrumb + `<input type="file" data-capture-file accept="application/json,.json" hidden><p class="threshold-error" data-capture-error role="alert" ${captureError ? '' : 'hidden'}>${escapeAttribute(captureError)}</p>` + body, bar: trafficToolbar() };
    }
    if (selectedRequest) {
      const request = trafficRows().find(row => row.id === selectedRequest!.id) ?? selectedRequest;
      const method = request.method ?? 'Request';
      const target = request.path ?? request.label ?? 'Request';
      const service = serviceLabel(request.service);
      const outcome = request.aiRequest ? requestStatusLabel(request.aiRequest.status) : { ok: 'Succeeded', denied: 'Denied', error: 'Failed', unsupported: 'Unsupported' }[request.verdict];
      const fact = (label: string, value: string, cell: string) => `<div class="request-fact"><dt>${label}</dt><dd class="${cell} activity-path">${escapeAttribute(value)}</dd></div>`;
      let identityFact = '';
      if (request.identity) identityFact = fact('Identity', request.identity, 's2');
      let evidenceDetails = '';
      let reasonFact = request.indexFailure ? fact('Reason', 'The required index was missing.', '') : '';
      if (request.service === 'firestore') {
        reasonFact = fact('Reason', rulesSummary(request), '');
        evidenceDetails = rulesEvidenceHtml(request, escapeAttribute, iconHtml('chevron'));
      }
      if (request.aiRequest) {
        const response = request.aiRequest.response;
        const content = response
          ? `<div class="request-response"><pre class="request-response-body mono" tabindex="0" aria-label="Returned response">${escapeAttribute(response.text)}</pre><button class="btn icon-button request-response-copy" type="button" data-copy-response aria-label="Copy response" title="Copy response"${clipboard ? '' : ' disabled'}>${iconHtml('copy')}</button></div>${response.truncated ? '<p class="rules-privacy">Response preview was truncated.</p>' : ''}`
          : `<p class="rules-privacy">${request.aiRequest.status === 'pending' ? 'Waiting for the completed response.' : request.aiRequest.status === 'failed' ? 'No successful response was returned.' : 'Response content was not recorded for this request.'}</p>`;
        evidenceDetails += `<details class="rules-disclosure" data-request-response="${escapeAttribute(request.id)}"><summary><span>Response</span><span class="rules-chevron">${iconHtml('chevron')}</span></summary><div class="rules-detail-body">${content}</div></details>`;
      }
      evidenceDetails += indexBlock(request.indexQuery, request.id);
      const copy = `<button class="btn icon-button" type="button" data-copy-traffic aria-label="Copy request" title="Copy request"${clipboard ? '' : ' disabled'}>${iconHtml('copy')}</button>`;
      return {
        body: `<div class="history-context"><nav class="data-breadcrumbs" aria-label="Breadcrumb"><button type="button" data-clear-traffic-source>Traffic</button>${iconHtml('chevron')}<button type="button" class="breadcrumb-target" data-request-back title="${escapeAttribute(target)}">${escapeAttribute(target)}</button>${iconHtml('chevron')}<span aria-current="page">${escapeAttribute(method)}</span></nav></div>`
          + `<div class="history-context"><section class="request-detail" data-traffic-detail data-request-row="${escapeAttribute(request.id)}"><div class="history-summary"><strong>${escapeAttribute(service)}</strong>${copy}</div><dl class="request-facts">${fact('Method', method, 'c1')}${request.aiRequest ? fact('Requested', target, 'c2') + fact('Routed to', request.aiRequest.detail.routedModel ?? (request.aiRequest.detail.engine === 'scripted' ? 'Scripted — no model invoked' : 'Unknown'), 'c2') + fact('Reported by backend', request.aiRequest.detail.reportedModel ?? 'Not reported', 'c2') : fact('Path', target, 'c2')}${fact('Time', new Date(request.at).toISOString(), 's1')}${fact('Outcome', outcome, 'slot')}${identityFact}${reasonFact}</dl>${evidenceDetails}</section></div>`,
        bar: barHtml([indexActionHtml(request.indexQuery, request.id, indexInspector, escapeAttribute), getStudioUrl() ? `<a class="btn" href="${escapeAttribute(studioSectionUrl(getStudioUrl()!, 'traffic', 'inspect=' + encodeURIComponent(request.id) + '&service=' + encodeURIComponent(request.service ?? '')))}" target="_blank" rel="noopener">Inspect in Studio</a>` : '']),
      };
    }
    const retained = trafficRows();
    const retainedById = new Map(retained.map(request => [request.id, request]));
    const browsing = pinnedRequestIds ? [...pinnedRequestIds].flatMap(id => {
      const request = retainedById.get(id);
      return request ? [request] : [];
    }) : retained;
    const newCount = retained.length - browsing.length;
    const shown = browsing.slice(0, requestPageSize);
    const rows = shown.map((request) => {
      // Keep named cells stable for copying while the path owns the main line.
      const indexMissing = requestMissingIndex(request);
      const named = request.service !== null && request.method !== null;
      const call = named ? `${request.service}.${request.method}` : 'runtime';
      const what = named ? request.path ?? '' : request.label ?? request.service ?? request.method ?? '';
      return buttonRowHtml({
        c1: escapeAttribute(call),
        c2: request.aiRequest ? aiModelHtml(request.aiRequest.detail, escapeAttribute, request.method ?? undefined) : named ? `<span class="mono">${escapeAttribute(what)}</span>` : escapeAttribute(what),
        s1: `<span class="mono">${clockTime(request.at)}</span>`,
        s2: escapeAttribute(request.identity ?? ''),
        slot: request.aiRequest ? `<span class="listener-fact">${requestStatusLabel(request.aiRequest.status)}</span>` : trafficBadgeHtml(request.verdict, indexMissing),
        className: `traffic-row${indexMissing && request.verdict !== 'denied' ? ' pending' : request.verdict === 'ok' ? '' : ' problem'}`,
        title: [call, what, request.identity].filter(Boolean).join(' —'),
        attributes: `data-request-row="${escapeAttribute(request.id)}" data-inspect-request="${escapeAttribute(request.id)}"`,
        label: `Inspect ${call}: ${what}. ${request.verdict}`,
      });
    });
    const copy = `<button class="btn icon-button" type="button" data-copy-traffic aria-label="Copy traffic" title="Copy traffic"${clipboard && rows.length ? '' : ' disabled'}>${iconHtml('copy')}</button>`;
    const bar = trafficToolbar();
    const updatesPaused = pinnedRequestIds !== null;
    const updateLabel = updatesPaused ? `Resume live${newCount ? ` · ${newCount} new` : ''}` : 'Pause updates';
    const updateIcon = updatesPaused ? 'play' : 'pause';
    const controls = `<div class="request-controls"><select data-request-service aria-label="Request service">${['', 'ai', 'firestore', 'rtdb', 'storage', 'auth'].map(service => `<option value="${service}" ${service === requestService ? 'selected' : ''}>${service ? serviceLabel(service) : 'All services'}</option>`).join('')}</select><button type="button" class="btn icon-button" data-request-pause aria-label="${updateLabel}" title="${updateLabel}">${iconHtml(updateIcon)}</button></div>`;
    const older = browsing.length > shown.length ? '<div class="history-context request-pagination"><button type="button" class="btn" data-request-older>Load older</button></div>' : '';
    const omitted = trafficFeed?.omittedCount() ?? 0;
    const retention = omitted ? `<div class="history-context"><p class="hint request-retention">Older history discarded (${omitted} events). Retention is limited by age and memory.</p></div>` : '';
    return { body: `${controls}${trafficSource ? `<div class="history-context"><nav class="data-breadcrumbs" aria-label="Breadcrumb"><button type="button" data-clear-traffic-source>Traffic</button>${iconHtml('chevron')}<span class="breadcrumb-service">${serviceLabel(trafficSource.service)}</span>${iconHtml('chevron')}<span class="mono breadcrumb-target" aria-current="page" title="${escapeAttribute(trafficSource.target)}">${trafficSource.service === 'ai' ? 'Model requests' : escapeAttribute(trafficSource.target)}</span></nav></div>` : ''}${sectionHtml(trafficFilter === 'denied' ? 'Denied & failed' : 'Requests', `<div class="rows" data-traffic-rows>${rows.join('')}</div>${rows.length ? '' : emptyHtml(trafficFilter === 'denied' ? 'No denied or failed requests' : 'No requests yet', 'Use your app to see its data activity here.')}`, `${rows.length} of ${retained.length} retained`, copy)}${older}${retention}`, bar };
  };

  const sandboxViewHtml = (): ChipView => {
    const isHosted = snapshot.mode === 'hosted';
    const hostedLabels = { connecting: 'Connecting', restoring: 'Restoring app session', attached: 'Connected', interrupted: 'Reconnecting', closed: 'Connection closed — reload after repairing the host' };
    const hostedLabel = hostedLabels[snapshot.hostedConnection ?? 'connecting'];
    const hasRunningEpoch = snapshot.runningEpoch !== null;
    const hasUpdate = snapshot.updateAvailable;
    let workerDetail = 'Waiting for the sandbox to connect';
    if (hasRunningEpoch) workerDetail = 'Current sandbox version';
    if (hasUpdate) workerDetail = 'A newer version is available';
    let workerRow = rowHtml({ c1: 'Worker', s1: workerDetail, slot: `<span class="mono" data-running-epoch>${escapeAttribute(snapshot.runningEpoch?.slice(0, 8) ?? 'Pending')}</span>`, attributes: 'data-worker-row', title: snapshot.runningEpoch });
    const persistenceFailed = snapshot.persistenceUnhealthy === true;
    if (isHosted) workerRow = rowHtml({ c1: 'Hosted', s1: persistenceFailed ? 'Persistence failed — mutations blocked. Repair the store and restart.' : undefined, slot: escapeAttribute(hostedLabel), attributes: 'data-worker-row' });
    const isInPage = snapshot.mode === 'in-page';
    if (isInPage) workerRow = rowHtml({ c1: 'Runtime', s1: 'Services run in this page', slot: 'In-page', attributes: 'data-runtime-row' });
    const configuration = options.aiConfiguration?.getSnapshot();
    const modelFact = (label: string, value: string, attributes = '') => `<div ${attributes}><dt>${label}</dt><dd>${escapeAttribute(value)}</dd></div>`;
    const routes = new Map<string, { requestedModel: string; route: string }>();
    const hasConfiguration = configuration !== undefined;
    if (hasConfiguration) {
      routes.set(configuration.requestedModel, configuration);
    } else {
      const hostRequests = (trafficFeed?.requests() ?? []).flatMap(request => request.aiRequest ? [request.aiRequest] : []);
      const pageRequests = localRates.snapshot().services.find(service => service.service === 'ai')?.aiRequests ?? [];
      const hasHostRequests = hostRequests.length > 0;
      const requests = hasHostRequests ? hostRequests : pageRequests;
      for (const request of requests) {
        const requestedModel = request.detail.requestedModel.replace(/^models\//, '');
        const route = request.detail.routedModel ?? 'Not reported';
        routes.set(`${requestedModel}:${route}`, { requestedModel, route });
      }
    }
    const hasNoRoutes = routes.size === 0;
    if (hasNoRoutes) routes.set('unobserved', { requestedModel: 'Not reported', route: configuredAiRoute() });
    const modelRows = [...routes.values()].map(({ requestedModel, route }) => {
      const facts = modelFact('Model', requestedModel, 'data-ai-requested-row') + modelFact('Routed model', route, 'data-ai-route-row');
      return `<div class="row" data-ai-row><dl class="sandbox-ai-facts">${facts}</dl></div>`;
    });
    const rows = [...modelRows, workerRow];
    const supportsListeners = options.listeners !== undefined;
    const listenerHint = supportsListeners ? "Edit the overlay's custom properties" : 'Listener overlays are unavailable on this page';
    const theme = rowHtml({ c1: 'Theme', s1: 'Colors and outlines for listeners', slot: buttonHtml(`data-open-overlay-theme${supportsListeners ? '' : ' disabled'}`, 'Edit', listenerHint), attributes: 'data-theme-row' });
    return {
      body: `${introHtml('Your local sandbox', 'The configuration behind this page.')}${sectionHtml('Runtime', `<div class="rows">${rows.join('')}</div>`)}${sectionHtml('Page overlays', `<div class="rows">${theme}</div>`)}`,
      bar: barHtml([buttonHtml('data-dismiss-chip', 'Hide', 'Hide pyric on this page')], 'Hide until reload'),
    };
  };

  const viewHtml = (activeUid: string | null, isAdmin: boolean): ChipView => {
    if (tab === 'identity') return identityViewHtml(activeUid, isAdmin);
    if (tab === 'listeners') return options.listeners && dataView ? dataView.view() : { body: emptyHtml('Data unavailable', 'This page has no listener event source. Connect the sandbox to inspect subscriptions.'), bar: barHtml([]) };
    if (tab === 'traffic') return trafficViewHtml();
    return sandboxViewHtml();
  };

  let pointerActive = false;
  let deferredRender = false;
  let pointerRenderTimer: ReturnType<typeof setTimeout> | undefined;
  root.addEventListener('pointerdown', event => {
    pointerActive = true;
    if (!(event.target as Element).closest('.rate-menu')) root.querySelector<HTMLDetailsElement>('.rate-menu')?.removeAttribute('open');
  });
  const finishPointer = () => {
    pointerActive = false;
    if (deferredRender) {
      clearTimeout(pointerRenderTimer);
      pointerRenderTimer = setTimeout(() => { deferredRender = false; render(); }, 0);
    }
  };
  documentLike.addEventListener('pointerup', finishPointer);
  documentLike.addEventListener('pointercancel', finishPointer);
  const render = (next = snapshot): void => {
    if (pointerActive) { snapshot = next; deferredRender = true; return; }
    indexTargets.clear();
    const menuOpen = root.querySelector<HTMLDetailsElement>('.rate-menu')?.open;
    const openRateNotes = root.querySelector<HTMLDetailsElement>('[data-rate-notes][open]')?.dataset.rateNotes;
    const focusedRateNotes = root.activeElement?.closest('[data-rate-notes]')?.getAttribute('data-rate-notes');
    const openIndexJson = root.querySelector<HTMLDetailsElement>('[data-index-json][open]')?.dataset.indexJson;
    const responseDetails = root.querySelector<HTMLDetailsElement>('[data-request-response]');
    const responseOpen = responseDetails?.open ? responseDetails.dataset.requestResponse : undefined;
    const responseScroll = responseDetails?.querySelector('pre')?.scrollTop ?? 0;
    const responseFocus = responseDetails?.contains(root.activeElement) ? root.activeElement?.tagName : undefined;
    const openRuleDetails = root.querySelector<HTMLDetailsElement>('[data-rule-details][open]')?.dataset.ruleDetails;
    const previousRuleDetails = root.querySelector<HTMLDetailsElement>('[data-rule-details]');
    const previousExpressions = [...(previousRuleDetails?.querySelectorAll<HTMLElement>('.rule-expression') ?? [])];
    const expressionScroll = previousExpressions.map(expression => expression.scrollLeft);
    const rateMethods = [...root.querySelectorAll<HTMLElement>('[data-rate-method] code')];
    const rateScroll = new Map(rateMethods.map(code => [code.parentElement?.parentElement?.dataset.rateMethod, code.scrollLeft]));
    const focusedRate = rateMethods.find(code => code === root.activeElement)?.parentElement?.parentElement?.dataset.rateMethod;
    const focusedExpression = previousExpressions.findIndex(expression => expression === root.activeElement);
    const ruleDetailsFocus = root.activeElement?.closest('[data-rule-details]')?.getAttribute('data-rule-details');
    const openProviders = [...root.querySelectorAll<HTMLDetailsElement>('[data-user-providers][open]')].map((details) => details.dataset.userProviders);
    const providerFocus = root.activeElement?.closest('[data-user-providers]')?.getAttribute('data-user-providers');
    const previousView = root.querySelector<HTMLElement>('[data-chip-view]');
    const scrollTop = previousView?.dataset.chipView === tab ? previousView.scrollTop : 0;
    const active = root.activeElement as HTMLElement | null;
    const focusAttribute = [
      'data-index-action',
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
      'data-source-traffic',
      'data-highlight-source',
      'data-clear-traffic-source',
      'data-sources-back',
      'data-history-entry',
      'data-history-page',
      'data-clear-activity-history',
      'data-listener-all',
      'data-listener-mode',
      'data-flow-treatment',
      'data-activate-listener',
      'data-request-back',
      'data-inspect-request',
      'data-traffic-denied',
      'data-traffic-display',
      'data-inspect-rates',
      'data-rates-back',
      'data-open-thresholds',
      'data-threshold-input',
      'data-threshold-save',
      'data-threshold-defaults',
      'data-threshold-cancel',
      'data-rate-incident',
      'data-copy-traffic',
      'data-copy-response',
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

    const lens = getLensFn();
    const user = readCurrentUser();
    const isAdmin = lens?.mode === 'admin';
    const activeUid = (lens?.mode === 'as' ? lens.uid : user?.uid) ?? null;
    const errorCount = snapshot.errors.length;

    const current = signals();
    const problem = problemTab(current);
    // The pill's border is the page's state: the error colour outranks the
    // warning colour because a failure is about the page as it is running.
    const chipTone = current.failedRecently || current.duplicateListener ? ' error' : (current.missingIndex || current.rateThreshold || current.updatePending) ? ' warning' : '';
    const chipTitle = current.failedRecently
      ? 'A request failed in the last minute'
      : current.duplicateListener ? 'A listener is attached twice' : current.missingIndex ? 'A query is missing an index in local configuration' : current.rateThreshold ? 'Activity exceeded a threshold. Open Traffic to review.' : current.updatePending ? 'New worker available' : '';
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
    const studioUrl = getStudioUrl();
    const studioHref = studioUrl === null || studioUrl === undefined
      ? null
      : studioSectionUrl(studioUrl, studioSection.section, studioSection.query);
    const studioHtml = studioHref === null
      ? `<span class="btn" data-open-studio aria-disabled="true" title="Pyric Studio is disabled">Studio${iconHtml('external')}</span>`
      : `<a class="btn" data-open-studio href="${escapeAttribute(studioHref)}" target="_blank" rel="noopener noreferrer" title="Open this view in Studio">Studio${iconHtml('external')}</a>`;

    if (open) installChipFonts(documentLike);
    const built = open ? viewHtml(activeUid, isAdmin) : { body: '', bar: '' };
    const markup = open
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

    const announcement = `${errorCount === 0 ? 'No runtime errors' : `${errorCount} runtime ${errorCount === 1 ? 'error' : 'errors'}`}.${current.missingIndex ? ' A query is missing an index in local configuration.' : ''}${current.rateThreshold ? ' Activity exceeded a threshold. Open Traffic to review.' : ''}${open ? ` ${CHIP_TAB_LABELS[tab]}.` : ''}`;
    if (announcer.textContent !== announcement) announcer.textContent = announcement;
    // A view edited outside render (a refreshed rate cell, a copied-response
    // icon) is rebuilt from state even when the markup matches.
    if (viewEdits?.takeRecords().some(isViewEdit)) renderedMarkup = null;
    // Markup that matches what the view shows keeps the view's nodes. Replacing
    // them would drop a scroll that the compositor has applied and the main
    // thread has not read yet, along with hover and text selection.
    if (viewEdits !== null && markup === renderedMarkup) {
      if (open && tab === 'identity' && !usersRequested) void loadUsers();
      return;
    }
    view.innerHTML = markup;
    renderedMarkup = markup;

    const rateNotes = root.querySelector<HTMLDetailsElement>('[data-rate-notes]');
    if (rateNotes) {
      rateNotes.open = rateNotes.dataset.rateNotes === openRateNotes;
      if (rateNotes.dataset.rateNotes === focusedRateNotes) rateNotes.querySelector('summary')?.focus({ preventScroll: true });
    }
    const indexJson = root.querySelector<HTMLDetailsElement>('[data-index-json]');
    if (indexJson) indexJson.open = indexJson.dataset.indexJson === openIndexJson;
    const nextResponse = root.querySelector<HTMLDetailsElement>('[data-request-response]');
    if (nextResponse && nextResponse.dataset.requestResponse === responseDetails?.dataset.requestResponse) {
      nextResponse.open = nextResponse.dataset.requestResponse === responseOpen;
      const pre = nextResponse.querySelector('pre');
      if (pre) pre.scrollTop = responseScroll;
      if (responseFocus) nextResponse.querySelector<HTMLElement>(responseFocus === 'PRE' ? 'pre' : 'summary')?.focus({ preventScroll: true });
    }
    const ruleDetails = root.querySelector<HTMLDetailsElement>('[data-rule-details]');
    if (ruleDetails) {
      ruleDetails.open = ruleDetails.dataset.ruleDetails === openRuleDetails;
      if (ruleDetails.dataset.ruleDetails === ruleDetailsFocus) ruleDetails.querySelector('summary')?.focus({ preventScroll: true });
      // Captured conditions are stable for a request, even when new traffic refreshes the chip.
      if (ruleDetails.dataset.ruleDetails === previousRuleDetails?.dataset.ruleDetails) {
        const expressions = [...ruleDetails.querySelectorAll<HTMLElement>('.rule-expression')];
        expressions.forEach((expression, index) => { expression.scrollLeft = expressionScroll[index] ?? 0; });
        expressions[focusedExpression]?.focus({ preventScroll: true });
      }
    }
    for (const details of root.querySelectorAll<HTMLDetailsElement>('[data-user-providers]')) {
      details.open = openProviders.includes(details.dataset.userProviders);
      if (providerFocus === details.dataset.userProviders) details.querySelector('summary')?.focus({ preventScroll: true });
    }
    const scrollView = root.querySelector<HTMLElement>('[data-chip-view]');
    if (scrollView) scrollView.scrollTop = scrollTop;
    for (const code of root.querySelectorAll<HTMLElement>('[data-rate-method] code')) {
      const method = code.parentElement?.parentElement?.dataset.rateMethod;
      code.scrollLeft = rateScroll.get(method) ?? 0;
      if (method === focusedRate) code.focus({ preventScroll: true });
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-traffic-display]')) {
      button.addEventListener('click', () => {
        trafficDisplay = button.dataset.trafficDisplay === 'rates' ? 'rates' : 'requests';
        selectedRequest = null;
        render();
      });
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-inspect-rates]')) {
      button.addEventListener('click', () => {
        selectedRateService = button.dataset.inspectRates ?? null;
        rateSection = 'chart';
        if (isThresholdService(selectedRateService)) currentRateHistory().open(rates.snapshot());
        render();
        root.querySelector<HTMLButtonElement>('[data-rates-back]')?.focus({ preventScroll: true });
      });
    }
    for (const button of root.querySelectorAll<HTMLElement>('[data-rate-incidents]')) button.addEventListener('click', () => {
      selectedRateService = button.dataset.rateIncidents!; rateSection = 'incidents'; render();
    });
    for (const button of root.querySelectorAll('[data-rate-chart]')) button.addEventListener('click', () => { rateSection = 'chart'; render(); });
    root.querySelector('[data-rate-measurements]')?.addEventListener('click', () => { rateSection = 'measurements'; render(); });
    const menu = root.querySelector<HTMLDetailsElement>('.rate-menu');
    if (menu && menuOpen) menu.open = true;
    menu?.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); } });
    menu?.addEventListener('click', event => { if ((event.target as Element).closest('button')) menu.open = false; }, { capture: true });
    const refreshHistoryView = () => { const snapshot = rates.snapshot(); refreshRateView(root, snapshot, currentRateHistory().view(snapshot)); };
    bindHistory(root, currentRateHistory(), rates.snapshot, refreshHistoryView);
    for (const button of root.querySelectorAll<HTMLElement>('[data-history-mode]')) {
      button.addEventListener('click', () => {
        const imported = currentRateHistory().view(rates.snapshot())?.imported;
        if (button.dataset.historyMode === 'live') currentRateHistory().live(); else currentRateHistory().pause(rates.snapshot());
        if (imported) render(); else refreshHistoryView();
      });
    }
    async function showCaptures() {
      rateSection = 'captures'; capturesLoading = true; captureError = ''; render();
      try { savedCaptureList = await captureClient.list(); }
      catch (error) { captureError = error instanceof Error ? error.message : 'Unable to list captures.'; }
      finally { capturesLoading = false; render(); }
    }
    for (const button of root.querySelectorAll('[data-capture-open]')) button.addEventListener('click', showCaptures);
    for (const mode of ['rename', 'delete'] as const) root.querySelector(`[data-capture-${mode}]`)?.addEventListener('click', () => {
      captureNameDraft = selectedSavedCapture?.name ?? '';
      rateSection = mode === 'rename' ? 'capture-rename' : 'capture-delete'; captureError = ''; render();
      root.querySelector<HTMLInputElement>('[data-capture-name]')?.focus();
    });
    root.querySelector<HTMLInputElement>('[data-capture-name]')?.addEventListener('input', event => { captureNameDraft = (event.currentTarget as HTMLInputElement).value; });
    root.querySelector<HTMLInputElement>('[data-capture-name]')?.addEventListener('keydown', event => { if (event.key === 'Enter') root.querySelector<HTMLButtonElement>('[data-capture-edit-save]')?.click(); });
    root.querySelector('[data-capture-edit-cancel]')?.addEventListener('click', () => { if (!captureEditBusy) { rateSection = 'chart'; captureError = ''; render(); } });
    root.querySelector<HTMLButtonElement>('[data-capture-edit-save]')?.addEventListener('click', async event => {
      if (!selectedSavedCapture || captureEditBusy) return;
      captureEditBusy = true; (event.currentTarget as HTMLButtonElement).disabled = true;
      try {
        if (rateSection === 'capture-delete') {
          await captureClient.remove(selectedSavedCapture.id);
          importedCaptures.delete(selectedSavedCapture.service); selectedSavedCapture = null;
          currentRateHistory().live(); await showCaptures();
        } else {
          selectedSavedCapture = await captureClient.rename(selectedSavedCapture.id, root.querySelector<HTMLInputElement>('[data-capture-name]')!.value);
          rateSection = 'chart'; captureError = '';
        }
      } catch (error) { captureError = error instanceof Error ? error.message : 'Unable to update capture.'; }
      finally { captureEditBusy = false; render(); }
    });
    root.querySelector('[data-capture-import]')?.addEventListener('click', () => root.querySelector<HTMLInputElement>('[data-capture-file]')?.click());
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-project-capture]')) button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const text = await captureClient.read(button.dataset.projectCapture!);
        selectedSavedCapture = savedCaptureList?.find(entry => entry.id === button.dataset.projectCapture) ?? null;
        const capture = readRateCapture(text);
        importedCaptures.set(capture.frame.service.service, text);
        selectedRateService = capture.frame.service.service; rateSection = 'chart';
        currentRateHistory().load(capture.frame); captureError = ''; render();
      } catch (error) { captureError = error instanceof Error ? error.message : 'Unable to open capture.'; render(); }
    });
    function downloadCapture(text: string, name: string) {
      const blob = new Blob([text], { type: 'application/json' });
      if (blob.size > 32 * 1024 * 1024) throw new Error('Capture exceeds 32 MB.');
      const url = URL.createObjectURL(blob);
      const link = documentLike.createElement('a'); link.href = url; link.download = name;
      documentLike.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    root.querySelector('[data-capture-download]')?.addEventListener('click', () => {
      const text = importedCaptures.get(selectedRateService!);
      if (text) downloadCapture(text, `pyric-${selectedRateService}.capture.json`);
    });
    root.querySelector<HTMLInputElement>('[data-capture-file]')?.addEventListener('change', async event => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];
      selectedSavedCapture = null;
      if (!file) return;
      try {
        if (file.size > 32 * 1024 * 1024) throw new Error('Capture exceeds 32 MB.');
        const text = await file.text();
        const capture = readRateCapture(text);
        importedCaptures.set(capture.frame.service.service, text);
        selectedRateService = capture.frame.service.service;
        rateSection = 'chart';
        currentRateHistory().load(capture.frame);
        captureError = ''; render();
      } catch (error) { captureError = error instanceof Error ? error.message : 'Unable to open capture.'; render(); }
    });
    root.querySelector<HTMLButtonElement>('[data-capture-export]')?.addEventListener('click', async event => {
      const frame = currentRateHistory().view(rates.snapshot());
      if (!frame) return;
      const selected = structuredClone(frame);
      const config = structuredClone(thresholdSettings.config());
      const events = [...captureEvents];
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const fetcher = documentLike.defaultView?.fetch?.bind(documentLike.defaultView);
        const saved = selected.imported ? importedCaptures.get(selected.service.service) : undefined;
        let fixture: unknown = null;
        let attachmentError: string | null = null;
        if (!saved) {
          try { fixture = options.captureSession ? await options.captureSession() : fetcher ? await readSessionFixture(fetcher) : null; }
          catch { attachmentError = 'Session state could not be read. Measurements and retained operations are included.'; }
        }
        const capture = buildRateCapture(selected, config, events, fixture, attachmentError);
        const text = saved ?? JSON.stringify(capture, null, 2);
        const entry = await captureClient.save(text);
        if (entry) await showCaptures();
        else downloadCapture(text, `pyric-${selected.service.service}-${Math.round(selected.clockOffset + selected.from * 1000)}.capture.json`);
        captureError = '';
      } catch (error) { captureError = error instanceof Error ? error.message : 'Unable to export capture.'; }
      finally { button.disabled = false; render(); }
    });
    root.querySelector('[data-open-thresholds]')?.addEventListener('click', () => {
      if (isThresholdService(selectedRateService)) thresholdSettings.open(selectedRateService);
    });
    root.querySelector('[data-threshold-defaults]')?.addEventListener('click', () => thresholdSettings.defaults());
    root.querySelector('[data-threshold-save]')?.addEventListener('click', async () => { await thresholdSettings.save(); root.querySelector<HTMLElement>('[data-open-thresholds]')?.focus(); });
    for (const button of root.querySelectorAll('[data-threshold-cancel]')) button.addEventListener('click', () => thresholdSettings.cancel());
    for (const input of root.querySelectorAll<HTMLInputElement>('[data-threshold-input]')) input.addEventListener('input', () => {
      thresholdSettings.edit(input.dataset.thresholdInput as import('./rate-threshold-config.js').ThresholdOperation | 'sustainedSeconds', input.value);
      refreshThresholdForm(root, thresholdSettings);
    });
    for (const button of root.querySelectorAll<HTMLElement>('[data-rate-incident]')) button.addEventListener('click', () => {
      const incident = thresholdMonitor.review(button.dataset.rateIncident!);
      if (!incident) return;
      selectedRateService = incident.service;
      rateSection = 'chart';
      currentRateHistory().inspect(incident.evidence, incident.from, incident.to, incident);
      render();
      const chart = root.querySelector<HTMLElement>('[data-history-chart]');
      root.querySelector('[data-incident-context]')?.scrollIntoView({ block: 'start' }); chart?.focus({ preventScroll: true });
    });
    root.querySelector('[data-rates-back]')?.addEventListener('click', () => { selectedRateService = null; rateSection = 'chart'; thresholdSettings.cancel(); });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-index-action]')) {
      button.addEventListener('click', async () => {
        const key = button.dataset.indexKey!;
        const target = indexTargets.get(key);
        if (!target) return;
        switch (button.dataset.indexAction) {
          case 'apply':
            await indexInspector.apply(key, target.query);
            root.querySelector<HTMLButtonElement>('[data-index-action=copy]')?.focus({ preventScroll: true });
            break;
          case 'copy': await indexInspector.copy(target.query, clipboard ?? undefined); break;

        }
      });
    }
    for (const photo of root.querySelectorAll<HTMLImageElement>('[data-avatar]')) {
      photo.addEventListener('error', () => { photo.hidden = true; });
    }

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
    dataView?.bind(root);
    root.querySelector('[data-clear-traffic-source]')?.addEventListener('click', () => { trafficSource = null; selectedRequest = null; render(); });
    root.querySelector('[data-request-back]')?.addEventListener('click', () => {
      selectedRequest = null; render();
      const view = root.querySelector<HTMLElement>('[data-chip-view]');
      if (view) view.scrollTop = requestListScroll;
    });
    root.querySelector('[data-request-older]')?.addEventListener('click', () => {
      pinnedRequestIds ??= new Set(trafficRows().map(request => request.id));
      requestPageSize += REQUEST_PAGE_SIZE;
      render();
    });
    root.querySelector('[data-request-pause]')?.addEventListener('click', () => {
      pinnedRequestIds = pinnedRequestIds ? null : new Set(trafficRows().map(request => request.id));
      render();
    });
    root.querySelector<HTMLSelectElement>('[data-request-service]')?.addEventListener('change', event => {
      requestService = (event.currentTarget as HTMLSelectElement).value;
      requestPageSize = REQUEST_PAGE_SIZE; pinnedRequestIds = null;
      render();
    });
    for (const row of root.querySelectorAll<HTMLButtonElement>('[data-inspect-request]')) {
      row.addEventListener('click', () => {
        const request = trafficRows().find(request => request.id === row.dataset.inspectRequest);
        if (!request) return;
        requestListScroll = root.querySelector<HTMLElement>('[data-chip-view]')?.scrollTop ?? 0;
        pinnedRequestIds ??= new Set(trafficRows().map(row => row.id));
        selectedRequest = { ...request };
        render();
        const view = root.querySelector<HTMLElement>('.view'); if (view) view.scrollTop = 0;
        root.querySelector<HTMLButtonElement>('[data-request-back]')?.focus();
      });
    }
    root.querySelector('[data-traffic-denied]')?.addEventListener('click', () => {
      trafficFilter = trafficFilter === 'denied' ? 'all' : 'denied';
      render();
    });
    root.querySelector('[data-copy-response]')?.addEventListener('click', async (event) => {
      if (!clipboard) return;
      const button = event.currentTarget as HTMLButtonElement;
      const text = root.querySelector('[data-request-response] pre')?.textContent;
      if (text === undefined || text === null) return;
      try {
        await clipboard.writeText(text);
        button.innerHTML = iconHtml('check');
        button.title = 'Copied';
        button.setAttribute('aria-label', 'Response copied');
      } catch {
        button.title = 'Copy failed';
        button.setAttribute('aria-label', 'Copy response failed; try again');
      }
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
      if (dataView?.mode() === null) return;
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
    // This render's own writes to the view are not edits.
    viewEdits?.takeRecords();
  };

  documentLike.body.append(host);
  const reattachAfterAstroSwap = (): void => {
    if (!host.isConnected) documentLike.body.append(host);
  };
  documentLike.addEventListener('astro:after-swap', reattachAfterAstroSwap);
  const unsubscribe = options.runtime.subscribe(render);
  const unsubscribeAiConfiguration = options.aiConfiguration?.subscribe(() => { if (open && tab === 'sandbox') render(); });
  const aiTrafficSignatures = new Map<string, string>();
  const unsubscribeAi = sdkActivity.subscribe(event => {
    if (event.record.service !== 'ai' || (event.phase !== 'end' && event.phase !== 'transport')) return;
    const ai = event.record.ai;
    const signature = JSON.stringify([event.record.status, ai?.requestedModel, ai?.routedModel, ai?.reportedModel]);
    if (aiTrafficSignatures.get(event.record.id) === signature) return;
    aiTrafficSignatures.set(event.record.id, signature);
    if (aiTrafficSignatures.size > 100) aiTrafficSignatures.delete(aiTrafficSignatures.keys().next().value!);
    const showsAiEvidence = tab === 'sandbox' || (tab === 'traffic' && trafficDisplay === 'requests');
    if (open && showsAiEvidence) render();
  });

  const unsubLens = subscribeLensFn(() => {
    render();
  });

  // The Listeners rows and the collapsed count read the mode's fold, so the
  // mode exists from the start; the control only turns the painting on.
  dataView?.mode();

  const unsubAuth = identity.subscribeAuth((next) => {
    clientUser = next;
    render();
  });

  mounted = true;
  render();
  // Sampling the clock advances idle rates. Updating cells preserves controls,
  // horizontal method scrolling and focus while the developer inspects them.
  const rateClock = setInterval(() => {
    const retainedSnapshot = rates.snapshot();
    for (const history of Object.values(serviceHistories)) history.record(retainedSnapshot);
    if (thresholdSettings.ready()) {
      thresholdMonitor.sample(rates.snapshot(), thresholdSettings.config());
      for (const service of ['firestore', 'rtdb', 'storage', 'ai'] as const) serviceHistories[service].markWarnings(thresholdMonitor.incidents().filter(incident => incident.service === service).flatMap(incident => incident.aboveRanges));
      const nextSignature = JSON.stringify(thresholdMonitor.incidents().map(incident => [incident.id, incident.recovered, incident.reviewed]));
      if (thresholdSignature !== nextSignature) { thresholdSignature = nextSignature; render(); }
    }
    if (open && tab === 'traffic' && trafficDisplay === 'rates' && !thresholdSettings.state().service) { const snapshot = rates.snapshot(); refreshRateView(root, snapshot, isThresholdService(selectedRateService) ? currentRateHistory().view(snapshot) : undefined); }
  }, 1000);
  const canUnrefRateClock = typeof rateClock === 'object' && 'unref' in rateClock;
  if (canUnrefRateClock) rateClock.unref();
  void indexInspector.refresh();
  void thresholdSettings.load();
  // The chip fades in once, when the page first gets it. The class sits on the
  // stable container rather than on the chip, so a render right behind the
  // mount can neither replay the animation nor cut it short.
  view.classList.add('entering');

  return {
    element: host,
    dispose() {
      clearInterval(rateClock);
      unsubscribeCapture?.();
      clearTimeout(pointerRenderTimer);
      viewEdits?.disconnect();
      documentLike.removeEventListener('pointerup', finishPointer);
      documentLike.removeEventListener('pointercancel', finishPointer);
      unsubscribe();
      unsubscribeAi();
      unsubscribeAiConfiguration?.();
      unsubLens();
      unsubAuth();
      documentLike.removeEventListener('astro:after-swap', reattachAfterAstroSwap);
      themeDialogController?.dispose();
      trafficFeed?.dispose();
      indexInspector.dispose();
      thresholdSettings.dispose();
      denials.dispose();
      dataView?.dispose();
      host.remove();
    },
  };
}
