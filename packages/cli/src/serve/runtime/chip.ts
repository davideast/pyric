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
 * Every view is built from one row: a 16px mark, a primary column, and a
 * right-aligned fact. A row's own click is its only action unless its fact is a
 * single control. That one shape is what lets four unrelated subjects read as
 * one panel.
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
import { filterUsers, userDisplayLabel } from './chip-user-search.js';
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
  button, a, input { font: inherit; }
  button { margin: 0; }
  :focus-visible { outline: 1px solid var(--pyric-muted); outline-offset: 2px; }

  /*
   * The pill is one box, always. Its three slots are each a fixed width, so a
   * session signing in, a rules bypass, a count arriving, and a count reaching
   * three digits all change colour and glyph inside boxes that never move. Only
   * the colour ever differs between states: no weight, no size, no border.
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
    gap: 8px;
    height: 36px;
    padding: 0 12px;
    width: 118px;
  }
  .chip:hover { border-color: #4a4a58; }
  .brand-label {
    flex: 1 1 auto;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .brand-label.error { color: var(--pyric-error); }
  .brand-label.warning { color: var(--pyric-warning); }
  .identity { align-items: center; color: var(--pyric-muted); display: inline-flex; flex: 0 0 16px; justify-content: center; width: 16px; }
  .identity[data-state="in"] { color: var(--pyric-text); }
  .identity[data-state="admin"] { color: var(--pyric-warning); }
  .identity-icon { height: 14px; width: 14px; }
  /* Three monospace characters, reserved whether or not there is a count. */
  .chip-count {
    color: var(--pyric-muted);
    flex: 0 0 22px;
    font: 11px/11px "JetBrains Mono", ui-monospace, monospace;
    height: 11px;
    text-align: right;
    width: 22px;
  }
  .chip-count.error { color: var(--pyric-error); }

  /*
   * One size for every view. The height is the tallest view the design admits:
   * the 48 header, the 40 strip, and a view of 12 padding, a 44 control row, a
   * 12 gap, eight 44 rows, and 12 padding — 520 in all. A view with fewer rows
   * leaves the rest empty rather than shrinking, and a list that would run past
   * the bottom scrolls inside itself.
   */
  .panel {
    background: var(--pyric-bg);
    border: 1px solid var(--pyric-border);
    border-radius: 10px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, .48);
    display: flex;
    flex-direction: column;
    height: 520px;
    max-width: calc(100vw - 40px);
    overflow: hidden;
    width: 384px;
  }
  .panel-header { align-items: center; display: flex; flex: 0 0 48px; height: 48px; justify-content: space-between; padding: 0 16px; }
  .panel-name { font-size: 13px; font-weight: 500; line-height: 20px; }
  .header-controls { align-items: center; display: inline-flex; gap: 12px; }
  .header-studio { color: var(--pyric-muted); font-size: 12px; line-height: 20px; text-decoration: none; white-space: nowrap; }
  a.header-studio:hover { color: var(--pyric-text); }
  .header-studio[aria-disabled="true"] { cursor: not-allowed; opacity: .5; }
  .icon-button { align-items: center; background: transparent; border: 0; border-radius: 4px; color: var(--pyric-muted); cursor: pointer; display: inline-flex; height: 24px; justify-content: center; padding: 0; width: 24px; }
  .icon-button:hover { background: rgba(255,255,255,.05); color: var(--pyric-text); }
  .icon { height: 15px; width: 15px; }

  .tabs { align-items: stretch; border-bottom: 1px solid var(--pyric-border-soft); display: flex; flex: 0 0 40px; gap: 20px; height: 40px; padding: 0 16px; }
  .tab {
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--pyric-muted);
    cursor: pointer;
    font-size: 13px;
    line-height: 20px;
    padding: 0;
  }
  .tab:hover { color: var(--pyric-text); }
  .tab[aria-selected="true"] { border-bottom-color: var(--pyric-text); color: var(--pyric-text); }
  .tab.problem { color: var(--pyric-error); }
  .tab.problem[aria-selected="true"] { border-bottom-color: var(--pyric-error); }
  .tab.pending { color: var(--pyric-warning); }
  .tab.pending[aria-selected="true"] { border-bottom-color: var(--pyric-warning); }

  .view { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden; padding: 12px 0; }
  .rows { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow-y: auto; }
  .rows::-webkit-scrollbar { width: 8px; }
  .rows::-webkit-scrollbar-thumb { background: var(--pyric-border); border-radius: 4px; }
  .control { flex: 0 0 44px; }
  .control + .rows { margin-top: 12px; }
  .row { flex: 0 0 44px; }
  .row {
    align-items: center;
    column-gap: 12px;
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) minmax(0, auto);
    height: 44px;
    padding: 0 16px;
    width: 100%;
  }
  a.row, button.row { background: transparent; border: 0; color: inherit; cursor: pointer; text-align: left; text-decoration: none; }
  a.row:hover, button.row:hover { background: rgba(255,255,255,.05); }
  .row-mark { align-items: center; display: inline-flex; height: 16px; justify-content: center; width: 16px; }
  .row-glyph { height: 16px; width: 16px; }
  .row-mark .identity { color: inherit; }
  .row-dot { background: var(--pyric-accent); border-radius: 50%; height: 8px; width: 8px; }
  .row-dot.pending { background: var(--pyric-warning); }
  .row-swatch { border-radius: 2px; height: 10px; width: 10px; }
  .row-primary { font-size: 13px; line-height: 20px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-secondary { color: var(--pyric-muted); font-size: 12px; }
  .row-fact { align-items: center; color: var(--pyric-muted); display: inline-flex; font-size: 12px; gap: 12px; justify-content: flex-end; line-height: 20px; min-width: 0; white-space: nowrap; }
  /* A uid or an epoch pair is bounded so it can never squeeze the primary out
     of its own row. */
  .row-fact > .mono { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
  /* A sandbox uid runs to forty characters. It is the row's fact, not its
     subject, so it yields to the name beside it. */
  .row-fact > [data-identity-uid] { max-width: 88px; }
  .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
  .row.problem .row-primary, .row.problem .row-fact, .row.problem .row-secondary { color: var(--pyric-error); }
  .row-action {
    background: transparent;
    border: 1px solid var(--pyric-border-soft);
    border-radius: 4px;
    color: var(--pyric-muted);
    cursor: pointer;
    font-size: 12px;
    height: 28px;
    line-height: 20px;
    padding: 0 10px;
  }
  .row-action:hover:not(:disabled) { border-color: #3a3a48; color: var(--pyric-text); }
  .row-action:disabled, .row-action[aria-disabled="true"] { cursor: not-allowed; opacity: .42; }
  .row-action[aria-pressed="true"] { border-color: rgba(230,199,156,.45); color: var(--pyric-warning); }
  .row-field {
    align-items: center;
    background: rgba(0,0,0,.22);
    border: 1px solid var(--pyric-border-soft);
    border-radius: 6px;
    display: flex;
    grid-column: 2 / -1;
    height: 32px;
    padding: 0 10px;
  }
  .row-field:focus-within { border-color: #4a4a58; }
  .row-field input { background: transparent; border: 0; color: var(--pyric-text); font-size: 13px; line-height: 20px; outline: none; width: 100%; }
  .segmented { border: 1px solid var(--pyric-border-soft); border-radius: 999px; display: inline-flex; flex: none; overflow: hidden; }
  .segmented button {
    background: transparent;
    border: 0;
    color: var(--pyric-muted);
    cursor: pointer;
    font-size: 11px;
    line-height: 20px;
    padding: 3px 6px;
  }
  .segmented button:hover { color: var(--pyric-text); }
  .segmented button[aria-pressed="true"] { background: rgba(255,255,255,.09); color: var(--pyric-text); }
  .segmented button[aria-disabled="true"] { cursor: not-allowed; opacity: .45; }

  @media (max-width: 460px) {
    :host { bottom: max(12px, env(safe-area-inset-bottom)); right: 12px; }
    .panel { max-width: calc(100vw - 24px); }
  }
  @media (prefers-reduced-motion: no-preference) {
    [data-view], .panel { transform-origin: bottom right; }
    .entering { animation: pyric-enter 120ms ease-out; }
    @keyframes pyric-enter { from { opacity: 0; transform: translateY(4px) scale(.98); } }
  }

  ${THEME_DIALOG_STYLES}
`;

const icons = {
  minimize: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14"/></svg>',
};

/** The head-and-shoulders outline both identity glyphs are drawn from. */
const IDENTITY_PATH = 'M12 4.2a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z M5 19.8a7 7 0 0 1 14 0Z';

/**
 * One drawing, two states. A signed-in session fills the silhouette; a signed
 * out page strokes the same path, so the eye reads one slot rather than two
 * icons.
 */
function identityGlyph(state: 'in' | 'out', className: string): string {
  if (state === 'out') {
    return `<svg class="${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="${IDENTITY_PATH}"/></svg>`;
  }
  return `<svg class="${className}" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="${IDENTITY_PATH}"/></svg>`;
}

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

/** How many rows any one view draws. Past this the answer is Studio's. */
const MAX_ROWS = 8;

/** One row's three cells, as markup. */
function rowHtml(input: {
  mark: string;
  primary: string;
  fact: string;
  className?: string;
  attributes?: string;
  href?: string | null;
  title?: string | null;
}): string {
  const classes = `row${input.className ? ` ${input.className}` : ''}`;
  const title = input.title ? ` title="${escapeAttribute(input.title)}"` : '';
  const attributes = input.attributes ? ` ${input.attributes}` : '';
  const cells = `<span class="row-mark">${input.mark}</span><span class="row-primary">${input.primary}</span><span class="row-fact">${input.fact}</span>`;
  if (input.href) {
    return `<a class="${classes}" href="${escapeAttribute(input.href)}" target="_blank" rel="noopener noreferrer"${title}${attributes}>${cells}</a>`;
  }
  return `<div class="${classes}"${title}${attributes}>${cells}</div>`;
}

/** A row whose own click is its action. */
function buttonRowHtml(input: {
  mark: string;
  primary: string;
  fact: string;
  className?: string;
  attributes: string;
  label: string;
}): string {
  const classes = `row${input.className ? ` ${input.className}` : ''}`;
  return `<button class="${classes}" type="button" aria-label="${escapeAttribute(input.label)}" ${input.attributes}><span class="row-mark">${input.mark}</span><span class="row-primary">${input.primary}</span><span class="row-fact">${input.fact}</span></button>`;
}

/** `true` for an element with a text caret to preserve across a rebuild. */
function isTextField(element: Element | null | undefined): element is HTMLInputElement {
  return element !== null && element !== undefined && element.tagName === 'INPUT';
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
  let everReportedListeners = false;
  /** Why the outlines refused to come on, for the control's own title. */
  let outlinesRefused: string | null = null;
  /** Whether the last rendered panel carried the Flow waiting fact. */
  let renderedFlowWaiting = false;
  const ensureListenerMode = (): ListenerMode | null => {
    if (listenerMode !== null) return listenerMode;
    const build = options.listeners;
    if (build === undefined) return null;
    listenerMode = build((outlines) => {
      everReportedListeners = true;
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
      });
    }
    return orderChipRequests([...byId.values()], Date.now()).slice(0, MAX_ROWS);
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

  const identityViewHtml = (activeUid: string | null, isAdmin: boolean): string => {
    const user = readCurrentUser();
    const control = `<div class="row control"><span class="row-mark"></span><span class="row-field"><input type="text" data-identity-query placeholder="Switch user: uid or email" autocomplete="off" aria-label="Switch user by uid or email" value="${escapeAttribute(identityQuery)}"></span></div>`;

    const rows: string[] = [];
    if (activeUid === null) {
      rows.push(rowHtml({
        mark: `<span class="identity" data-panel-identity data-state="out">${identityGlyph('out', 'row-glyph')}</span>`,
        primary: 'Signed out',
        fact: '',
        attributes: 'data-identity-row',
      }));
    } else {
      const email = user?.email ?? null;
      const primary = email ?? activeUid;
      rows.push(rowHtml({
        mark: `<span class="identity" data-panel-identity data-state="in">${identityGlyph('in', 'row-glyph')}</span>`,
        primary: escapeAttribute(primary),
        fact: `${email === null ? '' : `<span class="mono" data-identity-uid>${escapeAttribute(activeUid)}</span>`}<button class="row-action" type="button" data-sign-out>Sign out</button>`,
        attributes: 'data-identity-row',
        title: activeUid,
      }));
    }
    rows.push(rowHtml({
      mark: '',
      primary: 'Bypass rules',
      fact: `<button class="row-action" type="button" data-toggle-bypass aria-pressed="${isAdmin}">${isAdmin ? 'on' : 'off'}</button>`,
    }));

    const query = identityQuery.trim();
    if (query !== '') {
      const matches = filterUsers(knownUsers, identityQuery)
        .filter((candidate) => candidate.uid !== activeUid)
        .slice(0, MAX_ROWS - rows.length);
      for (const candidate of matches) {
        const label = userDisplayLabel(candidate);
        rows.push(buttonRowHtml({
          mark: `<span class="identity" data-state="out">${identityGlyph('out', 'row-glyph')}</span>`,
          primary: escapeAttribute(label),
          // The uid is the fact only when the row is not already named by it.
          fact: label === candidate.uid ? '' : `<span class="mono">${escapeAttribute(candidate.uid)}</span>`,
          attributes: `data-switch-user="${escapeAttribute(candidate.uid)}"`,
          label: `Switch to ${label}`,
        }));
      }
      // Nothing in the sandbox answers to what was typed, so the row that is
      // left offers to make it. The address is the query, which is why this row
      // exists only while one is typed.
      if (matches.length === 0) {
        rows.push(buttonRowHtml({
          mark: `<span class="identity" data-state="out">${identityGlyph('out', 'row-glyph')}</span>`,
          primary: escapeAttribute(query),
          fact: 'Create user',
          attributes: 'data-create-user',
          label: `Create a user for ${query}`,
        }));
      }
    }
    return `${control}<div class="rows">${rows.slice(0, MAX_ROWS).join('')}</div>`;
  };

  const listenersViewHtml = (): string => {
    const outlinesOn = listenerMode?.enabled() === true;
    // The remembered mode says how the painting would go, not that it is going:
    // a page that remembers Flow and has the outlines off shows `off` pressed.
    const paintMode: ListenerPaintMode = listenerMode?.mode() ?? paintModeBeforeBuild;
    const flowReason = listenerMode === null ? null : listenerMode.flowUnavailableReason();
    const pressed = (candidate: 'off' | ListenerPaintMode): boolean =>
      candidate === 'off' ? !outlinesOn : outlinesOn && paintMode === candidate;
    const offTitle = outlinesRefused === null ? 'Paint nothing' : outlinesRefused;
    const flowBlocked = flowReason ?? outlinesRefused;
    const overviewBlocked = outlinesRefused;
    renderedFlowWaiting = listenerMode?.flowWaiting() === true;
    // Flow paints on delivery, so an idle page shows nothing and reads as
    // broken. The fact says what the mode is waiting for, and it sits beside the
    // label rather than beside the control, because the control's own place must
    // not move when the waiting starts or stops.
    const waiting = `<span class="row-secondary" data-flow-waiting>${renderedFlowWaiting ? ' · waiting for a delivery' : ''}</span>`;
    const control = `<div class="row control">
        <span class="row-mark"></span>
        <span class="row-primary">Outlines${waiting}</span>
        <span class="row-fact"><span class="segmented" role="group" aria-label="How listeners are painted" data-listener-modes><button type="button" data-listener-mode="off" aria-pressed="${pressed('off')}" title="${escapeAttribute(offTitle)}">off</button><button type="button" data-listener-mode="overview" aria-pressed="${pressed('overview')}"${overviewBlocked === null ? ' title="Outline every attached listener"' : ` aria-disabled="true" title="${escapeAttribute(overviewBlocked)}"`}>Overview</button><button type="button" data-listener-mode="flow" aria-pressed="${pressed('flow')}"${flowBlocked === null ? ' title="Outline what rendered after each delivery"' : ` aria-disabled="true" title="${escapeAttribute(flowBlocked)}"`}>Flow</button></span></span>
      </div>`;

    const ordered = [...listenerOutlines].sort((a, b) => {
      const duplicate = (outline: ListenerOutline): number =>
        outline.incident?.pattern === 'duplicate-listener' ? 0 : 1;
      return duplicate(a) - duplicate(b)
        || b.deliveryCount - a.deliveryCount
        || a.label.localeCompare(b.label);
    }).slice(0, MAX_ROWS);

    const rows = ordered.map((outline) => {
      const target = displayTarget(outline);
      const isDuplicate = outline.incident?.pattern === 'duplicate-listener';
      const title = isDuplicate
        ? `${target} attached ${outline.incident!.count === 2 ? 'twice' : `${outline.incident!.count} times`}`
        : outline.labelIsOwner ? `${outline.label} · ${target}` : target;
      // An owner names the row and the target reads as its secondary. With
      // nothing on the page to name it, the target is all there is, so it
      // becomes the primary rather than being printed twice.
      const primary = outline.labelIsOwner
        ? `${escapeAttribute(outline.label)} <span class="row-secondary mono">${escapeAttribute(target)}</span>`
        : `<span class="mono">${escapeAttribute(target)}</span>`;
      return rowHtml({
        mark: `<span class="row-swatch" data-listener-swatch style="background:${escapeAttribute(listenerColors(outline.listenerId).swatch)}"></span>`,
        primary,
        fact: `<span class="mono">${outline.deliveryCount}</span>`,
        className: isDuplicate ? 'problem' : '',
        attributes: `data-listener-row="${escapeAttribute(outline.listenerId)}"`,
        href: studioUrl ? studioListenerUrl(studioUrl, outline) : null,
        title,
      });
    });
    return `${control}<div class="rows" data-listener-rows>${rows.join('')}</div>`;
  };

  const trafficViewHtml = (): string => {
    const rows = trafficRows().map((request) => {
      const call = request.service !== null && request.method !== null
        ? `${request.service}.${request.method}`
        : request.label ?? request.service ?? request.method ?? '';
      const path = request.path === null ? '' : ` <span class="mono row-secondary">${escapeAttribute(request.path)}</span>`;
      return rowHtml({
        mark: '',
        primary: `<span class="mono row-secondary">${clockTime(request.at)}</span> ${escapeAttribute(call)}${path}`,
        fact: request.verdict,
        className: request.verdict === 'ok' ? '' : 'problem',
        attributes: `data-request-row="${escapeAttribute(request.id)}"`,
        href: studioUrl ? studioSectionUrl(studioUrl, 'traffic', `request=${encodeURIComponent(request.id)}`) : null,
        title: `${call}${request.path === null ? '' : ` ${request.path}`} · ${request.verdict}`,
      });
    });
    return `<div class="rows" data-traffic-rows>${rows.join('')}</div>`;
  };

  const sandboxViewHtml = (): string => {
    const aiState = aiEngineState();
    const modeLabel = snapshot.mode === 'in-page'
      ? 'in-page'
      : snapshot.mode === 'shared-worker' ? 'shared worker' : 'starting';
    const runtimePrimary = snapshot.mode === 'starting' ? modeLabel : `${modeLabel} · running`;
    const runningEpoch = snapshot.runningEpoch?.slice(0, 8) ?? '';
    const rows: string[] = [
      rowHtml({
        mark: `<span class="row-dot${snapshot.updateAvailable ? ' pending' : ''}"></span>`,
        primary: escapeAttribute(runtimePrimary),
        fact: runningEpoch === '' ? '' : `<span class="mono" data-running-epoch>${escapeAttribute(runningEpoch)}</span>`,
        attributes: 'data-runtime-row',
      }),
      rowHtml({
        mark: '',
        primary: 'AI engine',
        fact: escapeAttribute(aiState.primary),
        attributes: 'data-ai-row',
        title: aiState.detail,
      }),
      rowHtml({
        mark: '',
        primary: 'Overlay theme',
        fact: '<button class="row-action" type="button" data-open-overlay-theme>Edit</button>',
      }),
    ];
    if (snapshot.updateAvailable) {
      const epochs = `${snapshot.runningEpoch?.slice(0, 8) ?? 'unknown'} → ${snapshot.servedEpoch?.slice(0, 8) ?? 'unknown'}`;
      rows.push(rowHtml({
        mark: '',
        primary: 'Update worker',
        fact: `<span class="mono" data-worker-epochs>${escapeAttribute(epochs)}</span><button class="row-action" type="button" data-update-worker aria-disabled="${snapshot.updatingWorker}">${snapshot.updatingWorker ? 'Updating' : 'Update'}</button>`,
      }));
    } else {
      // The row's place is held, so an update arriving moves nothing under it.
      // It keeps the three cells and says nothing in them, because there is
      // nothing to say.
      rows.push(rowHtml({ mark: '', primary: '', fact: '', attributes: 'data-update-slot' }));
    }
    rows.push(rowHtml({
      mark: '',
      primary: 'Hide pyric on this page',
      fact: '<button class="row-action" type="button" data-dismiss-chip>Hide</button>',
    }));
    return `<div class="rows">${rows.join('')}</div>`;
  };

  const viewHtml = (activeUid: string | null, isAdmin: boolean): string => {
    if (tab === 'identity') return identityViewHtml(activeUid, isAdmin);
    if (tab === 'listeners') return options.listeners ? listenersViewHtml() : '<div class="rows"></div>';
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

    // The collapsed chip carries identity in one slot: which glyph says whether
    // there is a session, its colour says whether rules are bypassed, and the
    // title carries the uid. No text.
    const identityState = isAdmin ? 'admin' : activeUid ? 'in' : 'out';
    const identityTitle = isAdmin
      ? activeUid ? `bypass rules · ${activeUid}` : 'bypass rules'
      : activeUid ?? 'Signed out';
    const identityIconHtml = `<span class="identity" data-identity-icon data-state="${identityState}" title="${escapeAttribute(identityTitle)}">${identityGlyph(identityState === 'out' ? 'out' : 'in', 'identity-icon')}</span>`;

    // The name carries the two page-wide problems as colour. Errors outrank an
    // available worker, because an error is about the page as it is running.
    const errorCount = snapshot.errors.length;
    const brandTone = errorCount > 0 ? ' error' : snapshot.updateAvailable ? ' warning' : '';
    const brandTitle = errorCount > 0
      ? pluralize(errorCount, 'error')
      : snapshot.updateAvailable ? 'New worker available' : '';
    const brandHtml = `<span class="brand-label${brandTone}"${brandTitle ? ` title="${escapeAttribute(brandTitle)}"` : ''}>pyric</span>`;

    const hasListenerIncident = listenerOutlines.some((outline) => outline.incident !== null);
    // A bare number, and only once the mode has something to count: a zero on a
    // page that has not reported yet says nothing. The slot is drawn either way,
    // so the count arriving cannot resize the pill.
    const counted = everReportedListeners ? listenerOutlines.length : 0;
    const countText = counted === 0 ? '' : counted > 99 ? '99+' : String(counted);
    const countTitle = counted === 0 ? '' : pluralize(counted, 'listener');
    const listenerCountHtml = `<span class="chip-count${hasListenerIncident ? ' error' : ''}" data-listener-count${countTitle === '' ? '' : ` title="${escapeAttribute(countTitle)}"`}>${countText}</span>`;

    const problem = problemTab(signals());
    const tabsHtml = CHIP_TABS.map((candidate) => {
      const tone = candidate !== problem
        ? ''
        : candidate === 'sandbox' ? ' pending' : ' problem';
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
      ? '<span class="header-studio" data-open-studio aria-disabled="true" title="Pyric Studio is disabled">Studio ↗</span>'
      : `<a class="header-studio" data-open-studio href="${escapeAttribute(studioHref)}" target="_blank" rel="noopener noreferrer">Studio ↗</a>`;

    view.innerHTML = open
      ? `<section class="panel" role="dialog" aria-label="pyric">
        <header class="panel-header">
          <span class="panel-name">pyric</span>
          <span class="header-controls">${studioHtml}<button class="icon-button" type="button" data-collapse aria-label="Minimize pyric">${icons.minimize}</button></span>
        </header>
        <div class="tabs" role="tablist" aria-label="pyric views">${tabsHtml}</div>
        <div class="view" id="pyric-view" role="tabpanel" data-chip-view="${tab}" aria-labelledby="pyric-tab-${tab}">${viewHtml(activeUid, isAdmin)}</div>
      </section>`
      : `<button class="chip" type="button" data-expand aria-label="Open pyric" aria-expanded="false">${brandHtml}${identityIconHtml}${listenerCountHtml}</button>`;

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
        const wanted = button.dataset.listenerMode;
        if (wanted === 'off') {
          mode.setEnabled(false);
          outlinesRefused = null;
        } else {
          const paint: ListenerPaintMode = wanted === 'flow' ? 'flow' : 'overview';
          mode.setMode(paint);
          mode.setEnabled(true);
          // The mode refuses Flow on a page whose renders it cannot read, and
          // refuses either mode when listener attribution is off. Say which,
          // on the control, rather than leaving it still.
          outlinesRefused = mode.enabled()
            ? mode.mode() === paint ? null : mode.flowUnavailableReason()
            : 'Listener attribution is off in this build, so there are no owners to outline.';
        }
        listenerOutlines = mode.outlines();
        render();
      });
    }
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
