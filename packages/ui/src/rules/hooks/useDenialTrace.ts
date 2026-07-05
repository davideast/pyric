import { useMemo } from 'react';
import {
  SimulateFirestoreRulesHandler,
  type TestCase,
  type RuleEvaluation,
  type PathResolutionTrace,
} from 'pyric/rules';
import type { FirestoreMethod } from '../types.js';

/**
 * The captured request a host re-runs through the simulator to produce a
 * `Denial`. A subset of the simulator's `TestCase` — no expectation /
 * description (those are test-runner concerns); the host already knows
 * the request was denied.
 */
export interface DenialRequest {
  method: FirestoreMethod;
  /** Resource path, e.g. `notes/3agHoZHZ`. */
  path: string;
  /** `request.auth` — `null`/omitted for unauthenticated. */
  auth?: { uid: string; token?: Record<string, unknown> } | null;
  /** `request.resource.data` — for writes. */
  requestData?: Record<string, unknown>;
  /** `resource.data` — the existing document. */
  resourceData?: Record<string, unknown> | null;
  /** Override `request.time` (ISO-8601). Defaults to wallclock. */
  requestTime?: string;
}

export interface DenialTrace {
  /** Per allow-rule evaluation, in source order. Empty for no-match denials. */
  evaluation: RuleEvaluation[];
  /** Which `match` blocks the resolver tried — present for no-match denials. */
  pathResolution?: PathResolutionTrace;
  /** True when the simulator could parse + evaluate. False on a parse error. */
  ok: boolean;
  /** Populated when `ok` is false (e.g. the rules source failed to parse). */
  error?: string;
}

function toTestCase(req: DenialRequest): TestCase {
  return {
    description: `denial-inspector: ${req.method} ${req.path}`,
    // The request was denied — we re-run it expecting DENY so the
    // simulator's PASSED/FAILED bookkeeping stays self-consistent. The
    // trace (which we actually consume) is independent of expectation.
    expectation: 'DENY',
    method: req.method,
    path: req.path,
    auth: req.auth ?? null,
    ...(req.requestData !== undefined ? { data: req.requestData } : {}),
    ...(req.resourceData != null ? { resource: req.resourceData } : {}),
    ...(req.requestTime !== undefined ? { requestTime: req.requestTime } : {}),
  };
}

/**
 * Re-run a captured (denied) Firestore request through the local rules
 * simulator — tracing is always on there — and return the structured
 * trace a `DenialInspector` renders.
 *
 * Memoized on `(request, rulesSource)`; the simulator is pure and
 * in-process, so this is cheap to call on every render. A host produces
 * a `Denial` by spreading the request fields alongside the result:
 *
 * ```ts
 * const { evaluation, pathResolution } = useDenialTrace(req, rules);
 * const denial: Denial = { ...req, decision: 'DENY', rulesSource: rules,
 *                          at, evaluation, pathResolution };
 * ```
 */
export function useDenialTrace(
  request: DenialRequest,
  rulesSource: string,
): DenialTrace {
  // Stable identity key — `request` is often a fresh object literal each
  // render, so memoize on its content, not its reference.
  const key = useMemo(() => JSON.stringify(request), [request]);

  return useMemo<DenialTrace>(() => {
    const handler = new SimulateFirestoreRulesHandler();
    const result = handler.simulate(rulesSource, [toTestCase(request)]);
    if (!result.success) {
      return { evaluation: [], ok: false, error: result.error.message };
    }
    const first = result.data.results[0];
    if (!first) {
      return { evaluation: [], ok: false, error: 'simulator returned no result' };
    }
    return {
      evaluation: first.trace,
      ...(first.pathResolution ? { pathResolution: first.pathResolution } : {}),
      ok: true,
    };
    // `key` captures the content of `request`; `request` itself is read
    // inside but intentionally excluded so a new-but-equal object literal
    // doesn't re-run the simulator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rulesSource]);
}
