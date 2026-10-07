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
import {
  simulationQueryProblem,
  type SimulateResult,
  type SimulationQuery,
} from '../rtdb/simulation/spec.js';
import type { RtdbCase } from './case-types.js';

function invalid(message: string): SimulateResult {
  return { success: false, error: { code: 'INVALID_INPUT', message, recoverable: true } };
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function absolutePath(segments: string[]): string {
  return `/${segments.join('/')}`;
}

/**
 * The query as rules read it. An `equalTo` bound is also the lower and upper
 * bound, as the sandbox reports a query it evaluates, so a rule that reads
 * `query.startAt` or `query.endAt` sees the same values in both.
 */
function ruleQuery(query: NonNullable<RtdbCase['query']>): SimulationQuery {
  const out: SimulationQuery = { ...query };
  if (query.equalTo !== undefined) {
    out.startAt = query.equalTo;
    out.endAt = query.equalTo;
  }
  return out;
}

function isPatch(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function simulateUpdate(doc: RtdbRulesDocumentInternal, c: RtdbCase): SimulateResult {
  if (!isPatch(c.newData)) {
    return invalid("an 'update' case needs newData to be an object keyed by the paths it writes.");
  }
  const base = segmentsOf(c.path);
  const updates = Object.entries(c.newData).map(([key, value]) => ({
    path: absolutePath([...base, ...segmentsOf(key)]),
    value,
  }));
  if (updates.length === 0) return invalid("an 'update' case needs newData to name at least one path.");

  let allowed: SimulateResult | undefined;
  for (const update of updates) {
    const input = baseInput(c);
    input.path = update.path;
    input.newData = update.value;
    input.updates = updates;
    const result = doc.simulate(input);
    if (!result.success) return result;
    if (!result.data.allowed || result.data.unsupported === true) return result;
    allowed ??= result;
  }
  return allowed as SimulateResult;
}

/** Evaluate one case against a ruleset document. */
export function simulateRtdbCase(doc: RtdbRulesDocumentInternal, c: RtdbCase): SimulateResult {
  if (c.query !== undefined) {
    if (c.operation !== 'read') {
      return invalid(`a query applies to a 'read' case, and this case is '${c.operation}'.`);
    }
    const problem = simulationQueryProblem(c.query);
    if (problem !== null) return invalid(problem);
  }
  if (c.operation === 'update') return simulateUpdate(doc, c);
  const input = baseInput(c);
  if (c.query !== undefined) input.query = ruleQuery(c.query);
  return doc.simulate(input);
}
