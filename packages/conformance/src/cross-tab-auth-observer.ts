export interface CrossTabAuthState {
  currentUid: string | null;
  events: Array<string | null>;
}

export interface AuthStorageSignal {
  key: string | null;
  newValue: string | null;
}

/** Match the exact app persistence key and the signed-in source uid. */
export function authStorageSignalMatches(
  signal: AuthStorageSignal,
  expectedKey: string,
  sourceUid: string,
): boolean {
  if (signal.key !== expectedKey || signal.newValue === null) return false;
  try {
    const value = JSON.parse(signal.newValue) as { uid?: unknown };
    return value?.uid === sourceUid;
  } catch {
    return false;
  }
}

export interface CrossTabAuthObservationOptions {
  sourceUid: string;
  /** A causal persistence signal from the source tab, not an elapsed guess. */
  waitForPersistenceSignal(): Promise<void>;
  readState(): Promise<CrossTabAuthState>;
  quietWindowMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Observe a negative cross-tab Auth result only after the sibling receives the
 * source tab's persistence event, then continuously allow a delayed Auth
 * callback to overturn that result for a bounded quiet window.
 */
export async function observeCrossTabAuthAfterPersistenceSignal(
  options: CrossTabAuthObservationOptions,
): Promise<CrossTabAuthState> {
  const quietWindowMs = options.quietWindowMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  await options.waitForPersistenceSignal();
  const deadline = now() + quietWindowMs;
  let state = await options.readState();
  while (
    !(state.currentUid === options.sourceUid && state.events.includes(options.sourceUid))
    && now() < deadline
  ) {
    await sleep(Math.min(pollIntervalMs, deadline - now()));
    state = await options.readState();
  }
  return state;
}
