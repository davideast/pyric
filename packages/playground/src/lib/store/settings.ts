/**
 * Per-user playground settings — persisted to localStorage so the
 * user's preferences survive reloads. Kept deliberately tiny:
 * playground-level UX knobs only, not feature flags.
 *
 *   - `autoFoldOlder` — when on, every new turn auto-collapses the
 *     prior ones, leaving only the latest open. The same gesture can
 *     be triggered manually via the `[` hotkey or the gear-icon
 *     settings modal.
 *   - `collapseSignal` — incrementing counter that Turn components
 *     watch. Bumped by the hotkey, by the auto-fold-on-new-turn
 *     effect, or by the settings modal's "Collapse older now" button.
 *     Not persisted (it's a transient gesture).
 *   - `contextCompactSignal` — incrementing counter consumed by the
 *     session host. Bumped by Agent → Context's "Compact now" button.
 *     Not persisted; it only forces compaction on the next submit.
 */
import { create } from 'zustand';
import { IS_STATIC_PLAYGROUND_BUILD } from '~/lib/build-env';

const STORAGE_KEY = 'pyric:settings';

interface PersistedSettings {
  autoFoldOlder?: boolean;
  /** Master switch for pyric's diagnostic layer — inline rules lint
   *  + denials + pitfalls in the system prompt, plus the `ctx.lint`
   *  helper on the tool context, plus any registered diagnostic
   *  tools under `~/lib/tools/diagnostics/`. Core write/run tools
   *  stay registered either way. Toggled off for qualitative
   *  A/B comparisons of agent quality without pyric's enhancements. */
  pyricDiagnosticsEnabled?: boolean;
  /** Per-tool toggles for entries in the diagnostic-tool manifest.
   *  Keyed by manifest `key` (e.g. `firestore_discover`). Absent keys
   *  default to enabled — the agent sees a new tool the first time it
   *  ships unless the user has explicitly turned it off. The outer
   *  `pyricDiagnosticsEnabled` master gate still has to be on for any
   *  per-tool flag to matter. */
  diagnosticToolsEnabled?: Record<string, boolean>;
  /** LEGACY (pre-default-flip) resumable toggle. Ignored on read: it was
   *  default-OFF, so a persisted `false` meant "never chose", not an
   *  opt-out — flipping the default required a fresh key. Kept in the
   *  type so old blobs still parse. */
  resumableServerMode?: boolean;
  /** Route inference through the same-origin server with a resumable
   *  buffered stream (Option C). The server holds the provider
   *  connection and buffers it into a durable job store; the client
   *  reconnects with an offset after a backgrounding drop — this is what
   *  lets a turn survive a backgrounded mobile tab. ON by default (the
   *  page-direct fetch structurally cannot survive backgrounding);
   *  page-direct remains the automatic fallback when the server path
   *  is unavailable. See plans/sw-inference-backgrounding-recovery.md. */
  resumableServerModeV2?: boolean;
  /** ✨ Enhance prompt toggle — when on, hitting Send runs the rough
   *  input through a single-turn enhancer call first and surfaces the
   *  result as an approval card in the activity thread. Off by
   *  default — opt-in feature. See `lib/agent/prompt-enhancer/`. */
  enhancePromptEnabled?: boolean;
  /** Cap on the agent's react-loop iterations per user prompt. Hit
   *  too often means the agent runs out of room before settling on
   *  a final answer; hit too rarely means the agent burned tool
   *  calls in circles without being stopped. Clamped to [4, 64] when
   *  read. ABSENT = no explicit choice — the effective cap is then
   *  lane-aware (see `resolveMaxTurns`): 16 on hosted reasoning lanes
   *  (OpenRouter — a 1.18M-token Kimi K2.6 trace burned 32
   *  iterations without settling), 32 on local/stub lanes. */
  maxTurns?: number;
  /** Opt-in: run parallel-safe tool calls in a turn concurrently
   *  (`@inbrowser/agent@0.2.0` `parallelDispatch`). Only tools tagged
   *  `parallelSafe` (reads/simulations) run together; mutations still
   *  serialise after. Traces are byte-identical to a serial run — the
   *  only difference is wall-clock. A latency lever for the
   *  many-simulate-calls rules workload. Off by default. */
  parallelDispatch?: boolean;
  /** Opt-in: Reflexion critique-and-retry pass after a candidate final
   *  answer (`@inbrowser/agent@0.2.0`). A second LLM call critiques the
   *  reply against the prior tool results; on `ok: false` the loop
   *  retries with the feedback injected. Trades latency for correctness
   *  — correctness-critical for rules edits, but adds a critique call
   *  (and up to `reflexionMaxRetries` extra loops) per answer. Off by
   *  default. */
  reflexionEnabled?: boolean;
  /** Retries after the critique flags problems. 0 = critique runs and
   *  is surfaced but never triggers a retry. Clamped to [0, 3] when
   *  read. Default 1 (the library default). */
  reflexionMaxRetries?: number;
  /** OpenRouter provider-routing sort. `throughput` (default) routes to
   *  the fastest provider — OpenRouter's own default optimizes price and
   *  lands on congested cheap providers (measured 2026-06-11: 19–63
   *  tok/s effective vs 200 tok/s throughput-sorted). `default` omits
   *  the sort field entirely, deferring to OpenRouter's load-balanced
   *  routing. */
  openrouterSort?: OpenrouterSort;
  /** Max provider price for PROMPT tokens, in USD per MILLION tokens
   *  (OpenRouter `provider.max_price.prompt`). Unset = no ceiling.
   *  Clamped to (0, 1000] when read — non-positive collapses to unset. */
  openrouterMaxPromptPrice?: number;
  /** Max provider price for COMPLETION tokens, USD per MILLION tokens
   *  (OpenRouter `provider.max_price.completion`). Unset = no ceiling. */
  openrouterMaxCompletionPrice?: number;
}

/** OpenRouter provider-routing sort modes. The first three map 1:1 to
 *  the wire `provider.sort` values; `default` means "send no sort" —
 *  OpenRouter's own (price-biased, load-balanced) routing. */
export type OpenrouterSort = 'throughput' | 'price' | 'latency' | 'default';

/** Bounds for `maxTurns` — applied at read time so a stale persisted
 *  value (or a bad manual edit of localStorage) can't push the agent
 *  into either an instant-cap or a runaway loop. */
export const MAX_TURNS_MIN = 4;
export const MAX_TURNS_MAX = 64;
export const MAX_TURNS_DEFAULT = 32;
/** Default react-loop cap on hosted reasoning lanes. Every iteration
 *  re-sends the whole history at real-money
 *  token prices — the order-food Kimi K2.6 evidence trace spent all 32
 *  default iterations (Σ 1.18M input tokens) without settling, and the
 *  back half was circling. Local/stub lanes keep `MAX_TURNS_DEFAULT`:
 *  iterations there cost nothing. An explicit user setting always wins. */
export const MAX_TURNS_DEFAULT_HOSTED = 16;

/** Lanes whose react-loop iterations bill per token (hosted reasoning
 *  models). Gemini stays on the local default for now — this fix targets
 *  OpenRouter per the live-economics evidence. */
const HOSTED_REASONING_LANES = new Set(['openrouter']);

/** Lane-aware default for the react-loop turn cap. */
export function defaultMaxTurnsForLane(providerId: string): number {
  return HOSTED_REASONING_LANES.has(providerId) ? MAX_TURNS_DEFAULT_HOSTED : MAX_TURNS_DEFAULT;
}

/** Effective react-loop turn cap: the user's explicit setting (already
 *  clamped at write/read time) always wins; otherwise the lane default. */
export function resolveMaxTurns(explicit: number | undefined, providerId: string): number {
  return explicit === undefined ? defaultMaxTurnsForLane(providerId) : explicit;
}

/** Bounds for Reflexion retries. 0 disables the retry (critique still
 *  runs + is surfaced); 3 caps the worst-case extra-loop latency. */
export const REFLEXION_RETRIES_MIN = 0;
export const REFLEXION_RETRIES_MAX = 3;
export const REFLEXION_RETRIES_DEFAULT = 1;

/** Default routing sort — preserves the measured-2026-06-11 fix that
 *  moved OpenRouter calls off congested price-default providers. */
export const OPENROUTER_SORT_DEFAULT: OpenrouterSort = 'throughput';
/** Generous ceiling for the price caps (USD per million tokens). No
 *  curated model costs anywhere near this; it only exists so a mistyped
 *  localStorage value can't persist something absurd. */
export const OPENROUTER_PRICE_MAX = 1000;

function readPersisted(): PersistedSettings {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as PersistedSettings;
  } catch (e) {
    console.warn('[settings] localStorage read failed:', e);
    return {};
  }
}

function writePersisted(s: PersistedSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    console.warn('[settings] localStorage write failed:', e);
  }
}

interface SettingsState {
  autoFoldOlder: boolean;
  collapseSignal: number;
  contextCompactSignal: number;
  pyricDiagnosticsEnabled: boolean;
  diagnosticToolsEnabled: Record<string, boolean>;
  resumableServerMode: boolean;
  enhancePromptEnabled: boolean;
  /** Explicit user cap, or `undefined` = unset → lane-aware default
   *  (resolve through `resolveMaxTurns` at the point of use). */
  maxTurns: number | undefined;
  parallelDispatch: boolean;
  reflexionEnabled: boolean;
  reflexionMaxRetries: number;
  openrouterSort: OpenrouterSort;
  openrouterMaxPromptPrice: number | undefined;
  openrouterMaxCompletionPrice: number | undefined;
  setAutoFoldOlder(v: boolean): void;
  setPyricDiagnosticsEnabled(v: boolean): void;
  setDiagnosticToolEnabled(key: string, enabled: boolean): void;
  setResumableServerMode(v: boolean): void;
  setEnhancePromptEnabled(v: boolean): void;
  setMaxTurns(v: number | undefined): void;
  setParallelDispatch(v: boolean): void;
  setReflexionEnabled(v: boolean): void;
  setReflexionMaxRetries(v: number): void;
  setOpenrouterSort(v: OpenrouterSort): void;
  setOpenrouterMaxPromptPrice(v: number | undefined): void;
  setOpenrouterMaxCompletionPrice(v: number | undefined): void;
  bumpCollapse(): void;
  bumpContextCompact(): void;
}

const initial = readPersisted();

function persistAll(s: SettingsState): void {
  writePersisted({
    autoFoldOlder: s.autoFoldOlder,
    pyricDiagnosticsEnabled: s.pyricDiagnosticsEnabled,
    diagnosticToolsEnabled: s.diagnosticToolsEnabled,
    resumableServerModeV2: s.resumableServerMode,
    enhancePromptEnabled: s.enhancePromptEnabled,
    // `undefined` (no explicit choice) drops out of the JSON — absent
    // key = lane-aware default at read time.
    maxTurns: s.maxTurns,
    parallelDispatch: s.parallelDispatch,
    reflexionEnabled: s.reflexionEnabled,
    reflexionMaxRetries: s.reflexionMaxRetries,
    openrouterSort: s.openrouterSort,
    // `undefined` caps drop out of the JSON — absent key = no ceiling.
    openrouterMaxPromptPrice: s.openrouterMaxPromptPrice,
    openrouterMaxCompletionPrice: s.openrouterMaxCompletionPrice,
  });
}

/** Clamp the EXPLICIT `maxTurns` value at read/write time so a stale or
 *  hand-edited localStorage entry can't escape the bounds. `undefined`
 *  stays `undefined` — "no explicit choice" defers to the lane-aware
 *  default (`resolveMaxTurns`) instead of freezing a global default in. */
function clampMaxTurns(v: number | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  if (v < MAX_TURNS_MIN) return MAX_TURNS_MIN;
  if (v > MAX_TURNS_MAX) return MAX_TURNS_MAX;
  return Math.floor(v);
}

/** Clamp Reflexion retries at read time — same rationale as
 *  `clampMaxTurns`: a stale/hand-edited value can't escape the bounds. */
function clampReflexionRetries(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return REFLEXION_RETRIES_DEFAULT;
  if (v < REFLEXION_RETRIES_MIN) return REFLEXION_RETRIES_MIN;
  if (v > REFLEXION_RETRIES_MAX) return REFLEXION_RETRIES_MAX;
  return Math.floor(v);
}

/** Validate the persisted sort at read time — an unrecognized value
 *  (stale schema, hand-edited storage) falls back to the default
 *  rather than putting an invalid enum on the wire. */
function readOpenrouterSort(v: OpenrouterSort | undefined): OpenrouterSort {
  return v === 'price' || v === 'latency' || v === 'default' || v === 'throughput'
    ? v
    : OPENROUTER_SORT_DEFAULT;
}

/** Clamp a price ceiling (USD per million tokens) at read time. The
 *  caps are OPTIONAL — anything non-finite or non-positive collapses to
 *  `undefined` (no ceiling) instead of a min bound, because "0" as a
 *  ceiling would exclude every provider and hard-fail routing. */
function clampOpenrouterPrice(v: number | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(v, OPENROUTER_PRICE_MAX);
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  autoFoldOlder: initial.autoFoldOlder ?? false,
  collapseSignal: 0,
  contextCompactSignal: 0,
  pyricDiagnosticsEnabled: initial.pyricDiagnosticsEnabled ?? true,
  diagnosticToolsEnabled: initial.diagnosticToolsEnabled ?? {},
  // Default ON. Read from the V2 key only: the legacy key was default-OFF,
  // so a persisted legacy `false` was never an explicit opt-out. Forced OFF in
  // the static-site build (no server relay exists; the toggle is hidden and
  // inference is page-direct BYOK — see selectMode / SettingsModal).
  resumableServerMode: IS_STATIC_PLAYGROUND_BUILD ? false : (initial.resumableServerModeV2 ?? true),
  enhancePromptEnabled: initial.enhancePromptEnabled ?? false,
  maxTurns: clampMaxTurns(initial.maxTurns),
  parallelDispatch: initial.parallelDispatch ?? false,
  reflexionEnabled: initial.reflexionEnabled ?? false,
  reflexionMaxRetries: clampReflexionRetries(initial.reflexionMaxRetries),
  openrouterSort: readOpenrouterSort(initial.openrouterSort),
  openrouterMaxPromptPrice: clampOpenrouterPrice(initial.openrouterMaxPromptPrice),
  openrouterMaxCompletionPrice: clampOpenrouterPrice(initial.openrouterMaxCompletionPrice),
  setAutoFoldOlder: (autoFoldOlder) => {
    set({ autoFoldOlder });
    persistAll(get());
  },
  setPyricDiagnosticsEnabled: (pyricDiagnosticsEnabled) => {
    set({ pyricDiagnosticsEnabled });
    persistAll(get());
  },
  setDiagnosticToolEnabled: (key, enabled) => {
    set({
      diagnosticToolsEnabled: {
        ...get().diagnosticToolsEnabled,
        [key]: enabled,
      },
    });
    persistAll(get());
  },
  setResumableServerMode: (resumableServerMode) => {
    set({ resumableServerMode });
    persistAll(get());
  },
  setEnhancePromptEnabled: (enhancePromptEnabled) => {
    set({ enhancePromptEnabled });
    persistAll(get());
  },
  setMaxTurns: (v) => {
    set({ maxTurns: clampMaxTurns(v) });
    persistAll(get());
  },
  setParallelDispatch: (parallelDispatch) => {
    set({ parallelDispatch });
    persistAll(get());
  },
  setReflexionEnabled: (reflexionEnabled) => {
    set({ reflexionEnabled });
    persistAll(get());
  },
  setReflexionMaxRetries: (v) => {
    set({ reflexionMaxRetries: clampReflexionRetries(v) });
    persistAll(get());
  },
  setOpenrouterSort: (v) => {
    set({ openrouterSort: readOpenrouterSort(v) });
    persistAll(get());
  },
  setOpenrouterMaxPromptPrice: (v) => {
    set({ openrouterMaxPromptPrice: clampOpenrouterPrice(v) });
    persistAll(get());
  },
  setOpenrouterMaxCompletionPrice: (v) => {
    set({ openrouterMaxCompletionPrice: clampOpenrouterPrice(v) });
    persistAll(get());
  },
  bumpCollapse: () => set({ collapseSignal: get().collapseSignal + 1 }),
  bumpContextCompact: () => set({ contextCompactSignal: get().contextCompactSignal + 1 }),
}));

/**
 * Read a per-tool flag with the "default to enabled" convention. New
 * diagnostic tools light up the first time they ship without requiring
 * a settings write; the user opts out explicitly.
 */
export function isDiagnosticToolEnabled(
  state: Pick<SettingsState, 'diagnosticToolsEnabled'>,
  key: string,
): boolean {
  const v = state.diagnosticToolsEnabled[key];
  return v === undefined ? true : v;
}
