import { useCallback, useEffect, useRef, useState } from 'react';
import {
  replay as runSandboxReplay,
  type LocalSandbox,
  type ReplayOptions,
  type ReplayResult,
  type SandboxEvent,
} from 'pyric/sandbox';
import type { AnyActivityEvent } from '../types.js';
import type { ReplayDivergence } from '../replayTypes.js';

export interface UseSessionReplayOptions {
  /** Captured events from sandbox or activity stream. */
  events: readonly SandboxEvent[] | readonly AnyActivityEvent[];
  /** Firestore security rules to replay against. */
  rules: string;
  /**
   * When true (default), re-issues captured request times so `serverTimestamp`
   * sentinels resolve to original capture times and time-gated rules evaluate
   * identically.
   */
  pinRequestTime?: boolean;
  /** Optional initial snapshot of document state to diff against. */
  originalState?: Record<string, Record<string, unknown>>;
  /** Automatically run replay when events or rules change. Default false. */
  autoReplay?: boolean;
}

export interface UseSessionReplayResult {
  /** Execute session replay with current or custom options. */
  replay: (customRules?: string, customOptions?: ReplayOptions) => ReplayResult | null;
  /** Whether replay is currently running. */
  isReplaying: boolean;
  /** Error thrown during replay execution, if any. */
  error: Error | null;
  /** Replay result containing sandbox, divergences, pathAliases. */
  result: ReplayResult | null;
  /** Classified divergences between original and replayed state. */
  divergences: ReplayDivergence[];
  /** Fresh auto-ID path mappings. */
  pathAliases: Map<string, string>;
  /** The replayed sandbox instance. */
  replayedSandbox: LocalSandbox | null;
  /** Current pinRequestTime setting. */
  pinRequestTime: boolean;
  /** Update pinRequestTime setting. */
  setPinRequestTime: (pin: boolean) => void;
  /** Current rules text. */
  rules: string;
  /** Update rules text. */
  setRules: (rules: string) => void;
}

const EMPTY_DIVERGENCES: ReplayDivergence[] = [];
const EMPTY_ALIASES = new Map<string, string>();

/**
 * Headless hook driving the `pyric/sandbox` replay engine. Re-issues captured
 * session writes against a fresh sandbox with the provided rules, classifying
 * any state drift (`sentinel-drift`, `time-drift`, `autoid-alias`,
 * `real-divergence`, or `now-denied`).
 */
export function useSessionReplay({
  events,
  rules: initialRules,
  pinRequestTime: initialPin = true,
  originalState,
  autoReplay = false,
}: UseSessionReplayOptions): UseSessionReplayResult {
  const [rules, setRules] = useState(initialRules);
  const [pinRequestTime, setPinRequestTime] = useState(initialPin);
  const [isReplaying, setIsReplaying] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);

  const prevRulesRef = useRef(initialRules);
  useEffect(() => {
    if (prevRulesRef.current !== initialRules) {
      prevRulesRef.current = initialRules;
      setRules(initialRules);
    }
  }, [initialRules]);

  const prevPinRef = useRef(initialPin);
  useEffect(() => {
    if (prevPinRef.current !== initialPin) {
      prevPinRef.current = initialPin;
      setPinRequestTime(initialPin);
    }
  }, [initialPin]);

  const replay = useCallback(
    (customRules?: string, customOptions?: ReplayOptions): ReplayResult | null => {
      setIsReplaying(true);
      setError(null);
      try {
        const activeRules = customRules !== undefined ? customRules : rules;
        const pin =
          customOptions?.pinRequestTime !== undefined
            ? customOptions.pinRequestTime
            : pinRequestTime;

        const replayRes = runSandboxReplay(
          events as readonly SandboxEvent[],
          activeRules,
          { pinRequestTime: pin },
          originalState,
        );
        setResult(replayRes);
        setIsReplaying(false);
        return replayRes;
      } catch (err) {
        const replayErr = err instanceof Error ? err : new Error(String(err));
        setError(replayErr);
        setIsReplaying(false);
        return null;
      }
    },
    [events, rules, pinRequestTime, originalState],
  );

  const autoReplayedRef = useRef(false);
  useEffect(() => {
    if (autoReplay && !autoReplayedRef.current) {
      autoReplayedRef.current = true;
      replay();
    }
  }, [autoReplay, replay]);

  return {
    replay,
    isReplaying,
    error,
    result,
    divergences: (result?.divergences as ReplayDivergence[]) ?? EMPTY_DIVERGENCES,
    pathAliases: result?.pathAliases ?? EMPTY_ALIASES,
    replayedSandbox: result?.sandbox ?? null,
    pinRequestTime,
    setPinRequestTime,
    rules,
    setRules,
  };
}
