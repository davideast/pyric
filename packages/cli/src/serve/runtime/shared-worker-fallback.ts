/**
 * Characterizes degraded in-page runtime fallback when a browser lacks
 * `SharedWorker` (for example, Safari < 16.4 or mobile Chrome) or blocks
 * worker startup, and formats an actionable signpost toward `--hosted`.
 */

type SharedWorkerFallbackReason =
  | 'shared-worker-unsupported'
  | 'shared-worker-blocked'
  | 'forced-in-page';

export interface SharedWorkerFallbackInfo {
  readonly reason: SharedWorkerFallbackReason;
  readonly tabSyncAvailable: boolean;
}

interface ClassifySharedWorkerFallbackInput {
  readonly hasSharedWorker: boolean;
  readonly forceInPage: boolean;
  readonly workerConnected: boolean;
  readonly hasBroadcastChannel: boolean;
}

/**
 * Classify why a non-hosted browser page fell back to the in-page sandbox, or
 * return `null` when a shared worker transport is active.
 */
export function classifySharedWorkerFallback(
  input: ClassifySharedWorkerFallbackInput,
): SharedWorkerFallbackInfo | null {
  if (input.forceInPage) {
    return {
      reason: 'forced-in-page',
      tabSyncAvailable: input.hasBroadcastChannel,
    };
  }
  if (!input.hasSharedWorker) {
    return {
      reason: 'shared-worker-unsupported',
      tabSyncAvailable: input.hasBroadcastChannel,
    };
  }
  if (!input.workerConnected) {
    return {
      reason: 'shared-worker-blocked',
      tabSyncAvailable: input.hasBroadcastChannel,
    };
  }
  return null;
}

/**
 * Format an actionable console signpost describing degraded in-page behavior
 * for unsupported or policy-blocked `SharedWorker` contexts.
 *
 * Returns `null` when in-page mode was explicitly forced by the host
 * (`__PYRIC_FORCE_INPAGE__`), which is an intentional embedder choice rather
 * than a browser capability gap.
 */
export function formatSharedWorkerFallbackSignpost(
  fallback: SharedWorkerFallbackInfo,
): string | null {
  if (fallback.reason === 'forced-in-page') {
    return null;
  }

  let lead = '[pyric sandbox] SharedWorker failed to start in this browser context.';
  if (fallback.reason === 'shared-worker-unsupported') {
    lead = '[pyric sandbox] SharedWorker is unavailable in this browser '
      + '(for example, Safari < 16.4 or mobile Chrome).';
  }

  let tabBehavior =
    'Running an isolated in-page sandbox per tab (BroadcastChannel is also unavailable, '
    + 'so tabs do not sync)';
  if (fallback.tabSyncAvailable) {
    tabBehavior =
      'Running an in-page sandbox per tab with BroadcastChannel cross-tab sync';
  }

  return `${lead} ${tabBehavior}; worker-backed Storage sharing and the live Studio `
    + 'worker plane are unavailable here. Run `pyric sandbox --hosted` '
    + '(or `pyric({ hosted: true })` in Vite) to share one server-hosted backend '
    + 'across tabs and browsers.';
}

const warnedRealms = new WeakSet<object>();

/**
 * Emit the `SharedWorker` fallback signpost at most once per browser realm.
 */
export function warnSharedWorkerFallbackOnce(
  fallback: SharedWorkerFallbackInfo | null,
  options: {
    readonly realm?: object;
    readonly warn?: (message: string) => void;
  } = {},
): boolean {
  if (fallback === null) {
    return false;
  }
  const message = formatSharedWorkerFallbackSignpost(fallback);
  if (message === null) {
    return false;
  }
  const realm = options.realm ?? globalThis;
  if (warnedRealms.has(realm)) {
    return false;
  }
  warnedRealms.add(realm);
  const warn = options.warn ?? console.warn;
  warn(message);
  return true;
}

/**
 * Actionable error thrown when code explicitly opens a worker transport in a
 * browser context where no `SharedWorker` or hosted connection is active.
 */
export function formatMissingWorkerTransportError(options: {
  readonly hasSharedWorker: boolean;
}): string {
  if (!options.hasSharedWorker) {
    return 'No Pyric worker transport is initialized in this browser context: '
      + 'SharedWorker is unavailable here (for example, Safari < 16.4 or mobile Chrome). '
      + 'Run `pyric sandbox --hosted` (or `pyric({ hosted: true })` in Vite) when '
      + 'shared worker-backed state is required.';
  }
  return 'No Pyric worker transport is initialized in this browser context: '
    + 'SharedWorker could not be started or in-page mode was forced. '
    + 'Run `pyric sandbox --hosted` (or `pyric({ hosted: true })` in Vite) when '
    + 'shared worker-backed state is required.';
}
