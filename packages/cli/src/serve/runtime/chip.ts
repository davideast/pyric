/**
 * The runtime chip: a collapsed pill on a served page, and an open panel of
 * four views behind it.
 *
 * The pill carries three things and no words for them: which identity the page
 * is running as, the name, and how many listeners are attached. Problems reach
 * it as colour on the part they are about.
 *
 * The panel answers the three reasons a developer clicks that pill. Something
 * went red, so Traffic holds the last requests and what Rules said about them.
 * They want to be someone else, so Identity switches the user and bypasses the
 * rules. They want to see what the page is doing, so Listeners lists what is
 * attached and Sandbox states which runtime is running it. The panel opens on
 * the view the strongest current signal names, which is usually the view the
 * colour on the pill came from.
 *
 * Every view has the same macro: a control zone, a list of rows, and an action
 * bar on the panel's bottom edge. Every row is the same three tracks — a 16px
 * mark, a primary column, a right-aligned fact — and a row is never anything
 * but itself: no button, toggle, or link lives inside one. Whatever a view can
 * do lives in its control zone or its bar, in the same place on every tab, so
 * four unrelated subjects read as one panel and nothing moves between them.
 */
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
import { studioListenerUrl, type ListenerMode } from './listener-mode.js';
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
    --pyric-bg: #1e1e24;
    --pyric-border: #33333f;
    --pyric-border-soft: #2a2a35;
    --pyric-text: #fbfbfe;
    --pyric-muted: #89899f;
    --pyric-warning: #e6c79c;
    --pyric-error: #f0a0a0;
    all: initial;
    position: fixed;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    z-index: 2147483000;
    color: var(--pyric-text);
    font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-synthesis: none;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  .announcer { height: 1px; overflow: hidden; position: absolute; width: 1px; clip: rect(0 0 0 0); white-space: nowrap; }
  button, a, input { font: inherit; }
  :focus-visible { outline: 1px solid var(--pyric-muted); outline-offset: 2px; }
  .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }

  /*
   * The pill is the word and nothing else, one fixed box. Its border carries
   * the page's state: the error colour for a denial or a duplicate listener,
   * the warning colour for a pending worker update. Nothing inside it changes.
   */
  .chip {
    align-items: center;
    background: var(--pyric-bg);
    border: 1px solid var(--pyric-border);
    border-radius: 999px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, .38);
    color: var(--pyric-text);
    cursor: pointer;
    display: flex;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    height: 32px;
    justify-content: center;
    width: 72px;
  }
  .chip:hover { border-color: #4a4a58; }
  .chip.error { border-color: var(--pyric-error); }
  .chip.warning { border-color: var(--pyric-warning); }

  /*
   * The panel is a grid whose outer tracks are the 16px insets, so every
   * child's left edge is line L and every right edge is line R without a single
   * padding or margin. Inside, the column stacks header, strip, view, and bar
   * with one 20px section gap. Height is fixed: 16 + 40 + 20 + 32 + 20 + 300 +
   * 20 + 32 + 16.
   */
  .panel {
    background: var(--pyric-bg);
    border: 1px solid var(--pyric-border);
    border-radius: 10px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, .48);
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) 16px;
    grid-template-rows: 16px minmax(0, 1fr) 16px;
    height: 496px;
    max-width: calc(100vw - 32px);
    overflow: hidden;
    width: 384px;
  }
  .panel-column { display: flex; flex-direction: column; gap: 20px; grid-column: 2; grid-row: 2; min-height: 0; }
  .panel-header { align-items: center; display: flex; flex: 0 0 40px; justify-content: space-between; }
  .panel-name { font-size: 13px; font-weight: 500; line-height: 20px; }
  .actions { align-items: center; display: flex; gap: 8px; justify-content: flex-end; }

  .tabs { border-bottom: 1px solid var(--pyric-border-soft); display: flex; flex: 0 0 32px; gap: 20px; }
  .tab {
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--pyric-muted);
    cursor: pointer;
    font-size: 13px;
    line-height: 20px;
  }
  .tab:hover { color: var(--pyric-text); }
  .tab[aria-selected="true"] { border-bottom-color: var(--pyric-text); color: var(--pyric-text); }
  .tab.problem { color: var(--pyric-error); }
  .tab.problem[aria-selected="true"] { border-bottom-color: var(--pyric-error); }
  .tab.pending { color: var(--pyric-warning); }
  .tab.pending[aria-selected="true"] { border-bottom-color: var(--pyric-warning); }

  /* The view is the one section that scrolls; its sections are 20 apart and its
     rows 8 apart. */
  .view { display: flex; flex: 0 0 300px; flex-direction: column; gap: 20px; min-height: 0; overflow-y: auto; }
  .view::-webkit-scrollbar { width: 8px; }
  .view::-webkit-scrollbar-thumb { background: var(--pyric-border); border-radius: 4px; }
  .rows { display: flex; flex-direction: column; gap: 8px; }
  .field {
    align-items: center;
    background: rgba(0,0,0,.22);
    border: 1px solid var(--pyric-border-soft);
    border-radius: 6px;
    display: grid;
    flex: 0 0 32px;
    grid-template-columns: 8px minmax(0, 1fr) 8px;
  }
  .field:focus-within { border-color: #4a4a58; }
  .field input { background: transparent; border: 0; color: var(--pyric-text); font-size: 13px; grid-column: 2; line-height: 20px; outline: none; width: 100%; }

  /*
   * One row, every tab: three columns and two lines. Column one starts at L,
   * column two at L2 (112 from L), and the slot ends at R. A tab without a
   * fixed first column spans its text across one and two. The slot holds the
   * row's fact or its one button, never both.
   */
  .row {
    column-gap: 8px;
    display: grid;
    grid-template-columns: 112px minmax(0, 1fr) 84px;
    grid-template-rows: 20px;
    row-gap: 4px;
    text-align: left;
    width: 100%;
  }
  .row.sub { grid-template-rows: 20px 16px; }
  button.row { background: transparent; border: 0; border-radius: 4px; color: inherit; cursor: pointer; }
  button.row:hover { background: rgba(255,255,255,.05); }
  button.row[aria-pressed="true"] { background: rgba(255,255,255,.09); }
  .c1, .c2 { font-size: 13px; line-height: 20px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c1.wide { grid-column: 1 / 3; }
  .s1, .s2 { color: var(--pyric-muted); font-size: 12px; grid-row: 2; line-height: 16px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s1 { grid-column: 1; }
  .s1.wide { grid-column: 1 / 3; }
  .s2 { grid-column: 2; }
  .s1.split { display: flex; gap: 8px; justify-content: space-between; }
  .s1.split .right { display: flex; gap: 8px; }
  .slot { align-items: center; color: var(--pyric-muted); display: flex; font-size: 12px; grid-column: 3; grid-row: 1; justify-content: flex-end; line-height: 20px; min-width: 0; overflow: hidden; white-space: nowrap; }
  .row.problem .c1, .row.problem .c2, .row.problem .slot { color: var(--pyric-error); }
  .row.pending .c1, .row.pending .slot { color: var(--pyric-warning); }
  .slot.ok { color: var(--pyric-muted); }

  /* The one button. */
  .btn {
    align-items: center;
    background: transparent;
    border: 1px solid var(--pyric-border-soft);
    border-radius: 4px;
    color: var(--pyric-muted);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 84px;
    font-size: 12px;
    height: 32px;
    justify-content: center;
    line-height: 20px;
    text-decoration: none;
    width: 84px;
  }
  .btn:hover:not(:disabled) { border-color: #3a3a48; color: var(--pyric-text); }
  .btn:disabled, .btn[aria-disabled="true"] { cursor: not-allowed; opacity: .42; }
  .btn[aria-pressed="true"] { background: rgba(255,255,255,.09); border-color: #3a3a48; color: var(--pyric-text); }
  .slot .btn { height: 20px; }
  .bar { flex: 0 0 32px; }

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
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The target the way the app wrote it: `conversations (query)`, `users/u1`. */
function displayTarget(outline: ListenerOutline): string {
  return outline.isQuery ? `${outline.target} (query)` : outline.target;
}

/** A view: what the scrolling area holds, and its action bar. */
interface ChipView { body: string; bar: string }

/** How many rows a view lists. Past this the answer is Studio's. */
const MAX_ROWS = 7;

/** One cell's text, escaped, or nothing. */
interface RowCells {
  /** Column one, or the whole text width when `c2` is absent. */
  c1: string;
  /** Column two, at L2. Present only on a tab with a fixed first column. */
  c2?: string;
  /** The sub-row under column one; with `c2`, under the first column only. */
  s1?: string;
  /** The sub-row under column two. */
  s2?: string;
  /** The sub-row's right-aligned cell, ending at R. Only without `c2`. */
  s1Right?: string;
  /** The slot at R: a fact or one button, already escaped or built. */
  slot: string;
  className?: string;
  attributes?: string;
  title?: string | null;
}

/** A row: two lines, three columns, the same cells on every tab. */
function rowHtml(cells: RowCells): string {
  const hasSub = cells.s1 !== undefined || cells.s2 !== undefined || cells.s1Right !== undefined;
  const wide = cells.c2 === undefined;
  const classes = `row${hasSub ? ' sub' : ''}${cells.className ? ` ${cells.className}` : ''}`;
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
  return `<div class="${classes}"${title}${attributes}>${html}</div>`;
}

/** A row whose own click is its action; `pressed` marks it active. */
function buttonRowHtml(cells: RowCells & { label: string; pressed?: boolean }): string {
  const inner = rowHtml(cells);
  const body = inner.slice(inner.indexOf('>') + 1, -'</div>'.length);
  const hasSub = cells.s1 !== undefined || cells.s2 !== undefined || cells.s1Right !== undefined;
  const classes = `row${hasSub ? ' sub' : ''}${cells.className ? ` ${cells.className}` : ''}`;
  const title = cells.title ? ` title="${escapeAttribute(cells.title)}"` : '';
  return `<button class="${classes}" type="button" aria-label="${escapeAttribute(cells.label)}"${cells.pressed === undefined ? '' : ` aria-pressed="${cells.pressed}"`}${title} ${cells.attributes ?? ''}>${body}</button>`;
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
function barHtml(buttons: readonly string[]): string {
  return `<div class="actions bar" data-action-bar>${buttons.join('')}</div>`;
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
  /** The sandbox's users, read once the Identity view is first shown. */
  let knownUsers: AuthUserRecord[] = [];
  let usersRequested = false;
  const loadUsers = async (): Promise<void> => {
    usersRequested = true;
    try {
      knownUsers = await identity.listUsers();
    } catch {
      knownUsers = [];
    }
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
    open = true;
  };

  const showTab = (next: ChipTab): void => {
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

  const providersHtml = (record: AuthUserRecord | undefined): string =>
    record === undefined ? '' : getUserProviders(record).map((provider) => `<span>${escapeAttribute(provider)}</span>`).join('');

  const identityViewHtml = (activeUid: string | null, isAdmin: boolean): ChipView => {
    const user = readCurrentUser();
    const rows: string[] = [updateRowHtml()];
    const matched: string[] = [];
    if (activeUid === null) {
      rows.push(rowHtml({ c1: 'Signed out', slot: '', attributes: 'data-identity-row' }));
    } else {
      const record = knownUsers.find((candidate) => candidate.uid === activeUid);
      const name = user?.displayName ?? record?.displayName ?? null;
      const email = user?.email ?? record?.email ?? null;
      const sub = name === null ? '' : escapeAttribute(email ?? '');
      const providers = providersHtml(record);
      rows.push(rowHtml({
        c1: escapeAttribute(name ?? email ?? activeUid),
        ...(sub === '' && providers === '' ? {} : { s1: sub, s1Right: providers }),
        slot: buttonHtml('data-sign-out', 'Sign out'),
        attributes: 'data-identity-row',
        title: activeUid,
      }));
    }

    const query = identityQuery.trim();
    const matches = filterUsers(knownUsers, identityQuery)
      .filter((candidate) => candidate.uid !== activeUid)
      .slice(0, MAX_ROWS);
    for (const candidate of matches) {
      const label = userDisplayLabel(candidate);
      const email = candidate.email ?? '';
      const sub = label === email ? '' : escapeAttribute(email);
      const providers = providersHtml(candidate);
      matched.push(buttonRowHtml({
        c1: escapeAttribute(label),
        ...(sub === '' && providers === '' ? {} : { s1: sub, s1Right: providers }),
        slot: '<span class="btn" aria-hidden="true">Sign in</span>',
        attributes: `data-switch-user="${escapeAttribute(candidate.uid)}"`,
        label: `Sign in as ${label}`,
        title: candidate.uid,
      }));
    }

    const buttons: string[] = [];
    if (query !== '' && matches.length === 0) {
      buttons.push(buttonHtml('data-create-user', 'Create user', `Create a user for ${query}`));
    }
    buttons.push(buttonHtml(`data-toggle-bypass aria-pressed="${isAdmin}"`, 'Bypass rules', isAdmin ? 'Rules are bypassed' : 'Evaluate rules as the session'));
    const search = `<div class="field"><input type="text" data-identity-query placeholder="Search users" autocomplete="off" aria-label="Search users" value="${escapeAttribute(identityQuery)}"></div>`;
    return { body: `<div class="rows">${rows.join('')}</div>${search}<div class="rows" data-user-rows>${matched.join('')}</div>`, bar: barHtml(buttons) };
  };

  const listenersViewHtml = (): ChipView => {
    const outlinesOn = listenerMode?.enabled() === true;
    const paintMode: ListenerPaintMode = listenerMode?.mode() ?? paintModeBeforeBuild;
    const flowReason = listenerMode === null ? null : listenerMode.flowUnavailableReason();
    const pressed = (candidate: ListenerPaintMode): boolean => outlinesOn && paintMode === candidate;

    const incidents = listenerOutlines.filter((outline) => outline.incident?.pattern === 'duplicate-listener');
    const ordered = [...listenerOutlines]
      .sort((a, b) => b.deliveryCount - a.deliveryCount || a.label.localeCompare(b.label))
      .slice(0, MAX_ROWS);

    const rows = [
      ...incidents.map((outline) => buttonRowHtml({
        c1: 'Duplicate subscription',
        s1: `<span class="mono">${escapeAttribute(displayTarget(outline))}</span>`,
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
          s1: `<span class="mono" style="color:${escapeAttribute(hue)}">${escapeAttribute(outline.labelIsOwner ? target : '')}</span>`,
          slot: `<span class="mono">${outline.deliveryCount}</span>`,
          attributes: `data-listener-row="${escapeAttribute(outline.listenerId)}" data-activate-listener="${escapeAttribute(outline.listenerId)}"`,
          label: `Outline ${outline.labelIsOwner ? outline.label : target} on the page`,
          pressed: activeListenerId === outline.listenerId,
        });
      }),
    ];
    const blocked = outlinesRefused;
    const bar = barHtml([
      buttonHtml(`data-listener-mode="overview" aria-pressed="${pressed('overview')}"${blocked === null ? '' : ' aria-disabled="true"'}`, 'Overview', blocked ?? 'Outline every attached listener'),
      buttonHtml(`data-listener-mode="flow" aria-pressed="${pressed('flow')}"${(flowReason ?? blocked) === null ? '' : ' aria-disabled="true"'}`, 'Flow', flowReason ?? blocked ?? 'Outline what rendered after each delivery'),
      buttonHtml('data-open-overlay-theme', 'Theme', "Edit the overlay's custom properties"),
    ]);
    return { body: `<div class="rows" data-listener-rows>${rows.join('')}</div>`, bar };
  };

  const trafficViewHtml = (): ChipView => {
    const rows = trafficRows().map((request) => {
      // A failure that names no call sits in the path column, under a
      // `runtime` call, so column one stays the call column on every row.
      const named = request.service !== null && request.method !== null;
      const call = named ? `${request.service}.${request.method}` : 'runtime';
      const what = named ? request.path ?? '' : request.label ?? request.service ?? request.method ?? '';
      return rowHtml({
        c1: escapeAttribute(call),
        c2: named ? `<span class="mono">${escapeAttribute(what)}</span>` : escapeAttribute(what),
        s1: `<span class="mono">${clockTime(request.at)}</span>`,
        s2: escapeAttribute(request.reason ?? ''),
        slot: `<span class="${request.verdict === 'ok' ? 'ok' : ''}">${request.verdict}</span>`,
        className: request.verdict === 'ok' ? '' : 'problem',
        attributes: `data-request-row="${escapeAttribute(request.id)}"`,
      });
    });
    const bar = barHtml([
      buttonHtml(`data-traffic-denied aria-pressed="${trafficFilter === 'denied'}"`, 'Denied only'),
      buttonHtml(`data-copy-traffic${clipboard ? '' : ' disabled'}`, 'Copy', clipboard ? 'Copy these rows as plain text' : 'Clipboard unavailable'),
    ]);
    return { body: `<div class="rows" data-traffic-rows>${rows.join('')}</div>`, bar };
  };

  const sandboxViewHtml = (): ChipView => {
    const aiState = aiEngineState();
    const rows = [
      // The model is the fact a user knows; the sandbox engine reads as `scripted`.
      rowHtml({ c1: 'Model', slot: escapeAttribute(aiState.primary.replace(/^sandbox \((.*)\)$/, '$1')), attributes: 'data-ai-row', title: aiState.detail }),
      rowHtml({ c1: 'Worker', slot: `<span class="mono" data-running-epoch>${escapeAttribute(snapshot.runningEpoch?.slice(0, 8) ?? '')}</span>`, attributes: 'data-worker-row' }),
      rowHtml({ c1: 'Theme', slot: buttonHtml('data-open-overlay-theme', 'Edit', "Edit the overlay's custom properties"), attributes: 'data-theme-row' }),
    ];
    return { body: `<div class="rows">${rows.join('')}</div>`, bar: barHtml([buttonHtml('data-dismiss-chip', 'Hide', 'Hide pyric on this page')]) };
  };

  const viewHtml = (activeUid: string | null, isAdmin: boolean): ChipView => {
    if (tab === 'identity') return identityViewHtml(activeUid, isAdmin);
    if (tab === 'listeners') return options.listeners ? listenersViewHtml() : { body: '<div class="rows"></div>', bar: barHtml([]) };
    if (tab === 'traffic') return trafficViewHtml();
    return sandboxViewHtml();
  };

  const render = (next = snapshot): void => {
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
      'data-listener-mode',
      'data-activate-listener',
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
      return `<button class="tab${tone}" type="button" role="tab" id="pyric-tab-${candidate}" data-chip-tab="${candidate}" aria-selected="${candidate === tab}" aria-controls="pyric-view">${CHIP_TAB_LABELS[candidate]}</button>`;
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
      ? '<span class="btn" data-open-studio aria-disabled="true" title="Pyric Studio is disabled">Studio</span>'
      : `<a class="btn" data-open-studio href="${escapeAttribute(studioHref)}" target="_blank" rel="noopener noreferrer" title="Open this view in Studio">Studio</a>`;

    const built = open ? viewHtml(activeUid, isAdmin) : { body: '', bar: '' };
    view.innerHTML = open
      ? `<section class="panel" role="dialog" aria-label="pyric"><div class="panel-column">
        <header class="panel-header">
          <span class="panel-name">pyric</span>
          <span class="actions">${studioHtml}${buttonHtml('data-collapse', 'Close', 'Close pyric')}</span>
        </header>
        <div class="tabs" role="tablist" aria-label="pyric views">${tabsHtml}</div>
        <div class="view" id="pyric-view" role="tabpanel" data-chip-view="${tab}" aria-labelledby="pyric-tab-${tab}">${built.body}</div>
        ${built.bar}
      </div></section>`
      : `<button class="chip${chipTone}" type="button" data-expand aria-label="Open pyric" aria-expanded="false"${chipTitle ? ` title="${chipTitle}"` : ''}>pyric</button>`;

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
      button.addEventListener('click', () => {
        const next = button.dataset.chipTab;
        if (next === undefined) return;
        showTab(next as ChipTab);
      });
    }
    const queryInput = root.querySelector<HTMLInputElement>('[data-identity-query]');
    queryInput?.addEventListener('input', () => {
      identityQuery = queryInput.value;
      render();
    });
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
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-listener-mode]')) {
      button.addEventListener('click', () => {
        const mode = ensureListenerMode();
        if (mode === null) return;
        const paint: ListenerPaintMode = button.dataset.listenerMode === 'flow' ? 'flow' : 'overview';
        // A pressed mode pressed again is the outlines going off; anything
        // else is that mode going on.
        if (mode.enabled() && mode.mode() === paint) {
          mode.setEnabled(false);
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
        listenerOutlines = mode.outlines();
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
      replacement?.focus();
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
