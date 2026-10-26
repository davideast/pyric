/**
 * Turns one public {@link RtdbCase} into the requests the RTDB engine
 * evaluates.
 *
 * The engine takes one written path per request, with the full list of paths
 * written together in `updates`, and a `query` for reads. A multi-path
 * `update` case is therefore one engine request per written path, as the
 * sandbox evaluates an `update()`, and its verdict is the first path that does
 * not allow.
 */

import type { RtdbRulesDocumentInternal, RtdbRulesSimulationInput } from '../rtdb/constraints/document.js';
import type { RtdbRuleEvaluation, SimulateResult } from '../rtdb/simulation/spec.js';
import type { RtdbCase } from './case-types.js';
import { rtdbCaseProblem } from './rtdb-case-validation.js';

/** A case the engine cannot evaluate as given, and why. */
export function invalidCase(message: string): SimulateResult {
  return { success: false, error: { code: 'INVALID_INPUT', message, recoverable: true } };
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function absolutePath(segments: string[]): string {
  return `/${segments.join('/')}`;
}

/** What the engine evaluates for every case kind except `update`. */
function baseInput(c: RtdbCase): RtdbRulesSimulationInput {
  // Assembled with explicit branches rather than conditional spreads: `data`,
  // `newData`, and `now` each mean something different when absent, and an
  // absent `now` in particular is the difference between "evaluate at this
  // instant" and "evaluate at whatever the simulator decides".
  const input: RtdbRulesSimulationInput = {
    operation: c.operation === 'update' ? 'write' : c.operation,
    path: c.path,
    auth: c.auth ?? null,
  };
  if (c.data !== undefined) input.data = c.data;
  if (c.newData !== undefined) input.newData = c.newData;
  if (c.now !== undefined) input.now = c.now;
  return input;
}

/** A multi-path `update` case, whose patch `rtdbCaseProblem` has checked. */
function simulateUpdate(doc: RtdbRulesDocumentInternal, c: RtdbCase): SimulateResult {
  const base = segmentsOf(c.path);
  const updates = Object.entries(c.newData as Record<string, unknown>).map(([key, value]) => ({
    path: absolutePath([...base, ...segmentsOf(key)]),
    value,
  }));

  let allowed: Extract<SimulateResult, { success: true }> | undefined;
  let validateFailure: { result: Extract<SimulateResult, { success: true }>; validates: RtdbRuleEvaluation[] } | undefined;
  const writeTrace: RtdbRuleEvaluation[] = [];
  let validateTrace: RtdbRuleEvaluation[] = [];
  for (const update of updates) {
    const input = baseInput(c);
    input.path = update.path;
    input.newData = update.value;
    input.updates = updates;
    const result = doc.simulate(input);
    if (!result.success) return result;
    const writes = result.data.trace.filter((t) => t.kind === 'write');
    const validates = result.data.trace.filter((t) => t.kind === 'validate');
    writeTrace.push(...writes);
    if (!result.data.allowed || result.data.unsupported === true) {
      if (validates.length === 0) {
        return { success: true, data: { ...result.data, trace: writeTrace } };
      }
      validateFailure ??= { result, validates };
      continue;
    }
    validateTrace = validates;
    allowed ??= result;
  }
  if (validateFailure) {
    return {
      success: true,
      data: { ...validateFailure.result.data, trace: [...writeTrace, ...validateFailure.validates] },
    };
  }
  const firstAllowed = allowed as Extract<SimulateResult, { success: true }>;
  return {
    success: true,
    data: { ...firstAllowed.data, trace: [...writeTrace, ...validateTrace] },
  };
}

/** Evaluate one case against a ruleset document. */
export function simulateRtdbCase(doc: RtdbRulesDocumentInternal, c: RtdbCase): SimulateResult {
  const problem = rtdbCaseProblem(c);
  if (problem !== null) return invalidCase(problem);
  if (c.operation === 'update') return simulateUpdate(doc, c);
  const input = baseInput(c);
  if (c.query !== undefined) input.query = { ...c.query };
  if (c.updates !== undefined) input.updates = c.updates;
  return doc.simulate(input);
}
