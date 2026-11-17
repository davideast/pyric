/**
 * Shared SIGINT/SIGTERM restore coordinator, in-flight mutation barrier, and
 * 3-attempt RTDB rules read-back verifier for conformance oracle runners.
 *
 * Ensures every rule-deploying capture script:
 *   1. Uses `process.on` (never `process.once`) so a second Ctrl-C awaits the
 *      already-active restore promise rather than killing it midway.
 *   2. Awaits any in-flight rules deploy/restore HTTP mutation before starting
 *      baseline restoration so a racing PUT cannot land after read-back.
 *   3. Retries RTDB rules PUT + GET read-back up to 3 times (`RESTORE_ATTEMPTS`).
 */

export const ORACLE_RESTORE_ATTEMPTS = 3;

export interface OracleRtdbProbeSubtree {
  runId: string;
  rules: Record<string, unknown>;
  stripTopLevelGrants?: boolean;
}

const ORACLE_RTDB_NAMESPACE_KEY = 'pyric_oracle';
const ORACLE_RTDB_BLOCK = {
  '.read': 'auth != null',
  '.write': 'auth != null',
  $run: {
    $probe: {
      list: {
        '.indexOn': ['pos', 'group'],
      },
    },
  },
};

export type RtdbRulesMerge =
  | { outcome: 'already-configured' }
  | { outcome: 'fresh' | 'merged'; next: string };

export function mergeOracleRtdbRules(
  source: string,
  probeSubtree?: OracleRtdbProbeSubtree,
): RtdbRulesMerge {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    throw new Error(`parse RTDB rules failed: ${reason}`);
  }
  const current = (parsed ?? {}) as { rules?: Record<string, unknown> };
  const currentRules = current.rules ?? {};
  const isEmpty = Object.keys(currentRules).length === 0;

  if (probeSubtree) {
    let existingBlock: Record<string, unknown> = {};
    const existingRaw = currentRules[ORACLE_RTDB_NAMESPACE_KEY];
    if (typeof existingRaw === 'object' && existingRaw !== null) {
      existingBlock = existingRaw as Record<string, unknown>;
    }
    let nextOracleBlock: Record<string, unknown>;
    if (probeSubtree.stripTopLevelGrants) {
      const { ['.read']: _r, ['.write']: _w, ...rest } = existingBlock;
      nextOracleBlock = { ...rest, [probeSubtree.runId]: probeSubtree.rules };
    } else {
      nextOracleBlock = { ...existingBlock, [probeSubtree.runId]: probeSubtree.rules };
    }
    let nextRoot: Record<string, unknown>;
    if (isEmpty) {
      nextRoot = { '.read': false, '.write': false, [ORACLE_RTDB_NAMESPACE_KEY]: nextOracleBlock };
    } else {
      nextRoot = { ...currentRules, [ORACLE_RTDB_NAMESPACE_KEY]: nextOracleBlock };
    }
    let mergeOutcome: 'fresh' | 'merged' = 'merged';
    if (isEmpty) {
      mergeOutcome = 'fresh';
    }
    return { outcome: mergeOutcome, next: JSON.stringify({ rules: nextRoot }) };
  }

  const existing = currentRules[ORACLE_RTDB_NAMESPACE_KEY];
  const blockMatches = JSON.stringify(existing) === JSON.stringify(ORACLE_RTDB_BLOCK);
  if (existing !== undefined && blockMatches) return { outcome: 'already-configured' };
  let rules: Record<string, unknown>;
  if (isEmpty) {
    rules = { '.read': false, '.write': false, [ORACLE_RTDB_NAMESPACE_KEY]: ORACLE_RTDB_BLOCK };
  } else {
    rules = { ...currentRules, [ORACLE_RTDB_NAMESPACE_KEY]: ORACLE_RTDB_BLOCK };
  }
  let mergeOutcome: 'fresh' | 'merged' = 'merged';
  if (isEmpty) {
    mergeOutcome = 'fresh';
  }
  return { outcome: mergeOutcome, next: JSON.stringify({ rules }) };
}

export function installOracleSignalRestoreGuard(
  label: string,
  restore: () => Promise<void>,
): () => void {
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`${label} ${signal}: restoring live project rules before exit`);
    restore().then(
      () => process.exit(130),
      (err: unknown) => {
        if (err instanceof Error) {
          console.error(err.message);
        } else {
          console.error(String(err));
        }
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

export interface SignalRestoreCoordinator {
  readonly isStopping: boolean;
  trackMutation<T>(promise: Promise<T>): Promise<T>;
  registerCleanup(cleanup: () => Promise<void>): () => void;
  runRestore(): Promise<void>;
  installSignals(): () => void;
}

export function createSignalRestoreCoordinator(label: string): SignalRestoreCoordinator {
  const inFlight = new Set<Promise<unknown>>();
  const cleanups: Array<() => Promise<void>> = [];
  let activeRestore: Promise<void> | null = null;
  let stopping = false;

  const drainMutations = async (): Promise<void> => {
    while (inFlight.size > 0) {
      const pending = [...inFlight];
      await Promise.allSettled(pending);
    }
  };

  const performRestore = async (): Promise<void> => {
    await drainMutations();
    const toRun = [...cleanups].reverse();
    cleanups.length = 0;
    const errors: string[] = [];
    for (const fn of toRun) {
      try {
        await fn();
      } catch (err) {
        if (err instanceof Error) {
          errors.push(err.message);
        } else {
          errors.push(String(err));
        }
      }
    }
    if (errors.length > 0) {
      throw new Error(`${label} rules restore failed: ${errors.join('; ')}`);
    }
  };

  const runRestore = async (): Promise<void> => {
    stopping = true;
    if (activeRestore !== null) {
      return activeRestore;
    }
    if (inFlight.size === 0 && cleanups.length === 0) {
      return;
    }
    const promise = performRestore();
    activeRestore = promise;
    try {
      await promise;
    } finally {
      activeRestore = null;
    }
  };

  return {
    get isStopping(): boolean {
      return stopping;
    },
    trackMutation<T>(promise: Promise<T>): Promise<T> {
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      inFlight.add(settled);
      void settled.finally(() => {
        inFlight.delete(settled);
      });
      return promise;
    },
    registerCleanup(cleanup: () => Promise<void>): () => void {
      cleanups.push(cleanup);
      return () => {
        const idx = cleanups.indexOf(cleanup);
        if (idx >= 0) {
          cleanups.splice(idx, 1);
        }
      };
    },
    runRestore,
    installSignals(): () => void {
      return installOracleSignalRestoreGuard(label, runRestore);
    },
  };
}

function defaultCanonicalJson(text: string): string {
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, '');
  return JSON.stringify(JSON.parse(withoutComments));
}

export async function restoreRtdbRulesWithRetry(options: {
  beforeText: string;
  writeText: (source: string) => Promise<void>;
  readText: () => Promise<string>;
  canonicalize?: (text: string) => string;
  attempts?: number;
}): Promise<void> {
  const maxAttempts = options.attempts ?? ORACLE_RESTORE_ATTEMPTS;
  const canonicalize = options.canonicalize ?? defaultCanonicalJson;
  const beforeCanonical = canonicalize(options.beforeText);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isLast = attempt === maxAttempts;
    try {
      await options.writeText(options.beforeText);
      const afterText = await options.readText();
      if (afterText === options.beforeText || canonicalize(afterText) === beforeCanonical) {
        return;
      }
      if (isLast) {
        throw new Error('RTDB rules read-back after restore did not match pre-run snapshot');
      }
    } catch (err) {
      if (isLast) {
        throw err;
      }
    }
  }
}
