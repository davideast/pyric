/**
 * `rtdbRules(...)` — the deep handle on a Realtime Database ruleset.
 *
 * Accepts any of four inputs and normalizes them to one handle:
 *   - the text of a `database.rules.json` file, comments included
 *   - an {@link RtdbRulesDefinition} (the `{ paths }` object)
 *   - the value {@link defineRtdbRules} returns (an {@link RtdbRulesDocument})
 *   - compiled `{ rules }` JSON
 *
 * Every input supports the full surface. Compiled `{ rules }` JSON is mapped
 * directly into the RTDB engine, so callers do not need a prior fetch/generate
 * step before simulation. `toJSON` always returns compiled `rules.json`.
 */

import {
  checkRtdbRules,
  defineRtdbRules,
  normalizeSimulationInput,
} from '../rtdb/constraints/document.js';
import type {
  RtdbRulesCheckResult,
  RtdbRulesDefinition,
  RtdbRulesDocument,
  RtdbRulesDocumentInternal,
  RtdbRulesJson,
  RtdbRulesSimulationInput,
} from '../rtdb/constraints/document.js';
import {
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
} from '../rtdb/compiled-rules.js';
import type { SimulateResult } from '../rtdb/simulation/spec.js';
import { simulateRtdbCase } from './rtdb-case-input.js';
import {
  RtdbCoverageRecorder,
  type RtdbCoverageOptions,
  type RtdbCoverageSummary,
} from '../rtdb/coverage.js';
import { toStrictRulesJson } from '../rtdb/rules-text.js';
import { RulesCompileError } from './errors.js';
import type { RuleIssue } from './issue.js';
import { rtdbFindingToIssue, rtdbSecurityFindingToIssue } from './issue.js';
import { lintRtdbRuleset } from '../rtdb/grammar/ruleset-lint.js';
import type {
  RtdbCase,
  RtdbCaseResult,
  RtdbExplanation,
  RtdbSimulationSummary,
} from './case-types.js';

export interface RtdbRuleset {
  /** Structural findings on the compiled ruleset (from `check()`). */
  lint(): RuleIssue[];
  /** Run every case. Never throws on a rule outcome. */
  simulate(cases: RtdbCase[]): RtdbSimulationSummary;
  /**
   * Which `.read`, `.write`, `.validate` and `.indexOn` nodes the given case
   * results evaluated, and which they never reached. `simulate` returns this
   * for its own cases; call it to merge several runs or to attach a file name
   * and line numbers.
   */
  coverage(results: readonly RtdbCaseResult[], options?: RtdbCoverageOptions): RtdbCoverageSummary;
  /** The structured account of why one case resolved as it did. */
  explain(oneCase: RtdbCase): RtdbExplanation;
  /** The compiled `rules.json`. */
  toJSON(): RtdbRulesJson;
}

type RtdbRulesInput =
  | RtdbRulesDefinition
  | RtdbRulesDocument
  | RtdbRulesJson;

function isDocument(x: RtdbRulesInput): x is RtdbRulesDocumentInternal {
  const o = x as Record<string, unknown>;
  return (
    typeof o.toJSON === 'function' &&
    typeof o.simulate === 'function' &&
    typeof o.check === 'function'
  );
}

function isCompiledJson(x: RtdbRulesInput): x is RtdbRulesJson {
  const o = x as Record<string, unknown>;
  return (
    typeof o === 'object' &&
    o !== null &&
    'rules' in o &&
    !('paths' in o) &&
    typeof o.toJSON !== 'function'
  );
}

/** A document-backed handle — the full-featured path. */
class DocumentRtdbRuleset implements RtdbRuleset {
  constructor(private readonly doc: RtdbRulesDocumentInternal) {}

  lint(): RuleIssue[] {
    const check = this.doc.check();
    const issues = [
      ...check.errors.map((f) => rtdbFindingToIssue(f, 'error')),
      ...check.warnings.map((f) => rtdbFindingToIssue(f, 'warning')),
    ];
    // A ruleset that does not compile has no tree to read.
    if (check.errors.some((f) => f.code === 'COMPILE_ERROR')) return issues;
    return [...issues, ...lintRtdbRuleset(this.doc.compile()).map(rtdbSecurityFindingToIssue)];
  }

  private runOne(c: RtdbCase): RtdbCaseResult {
    const result = simulateRtdbCase(this.doc, c);
    if (!result.success) {
      // Could not evaluate — report as unsupported rather than throw.
      return {
        case: c,
        ...(c.description !== undefined ? { description: c.description } : {}),
        expectation: c.expectation,
        decision: 'UNSUPPORTED',
        passed: false,
        unsupported: true,
        matchedPath: c.path,
        matchedRule: '',
        reason: result.error.message,
        trace: [],
      };
    }
    const data = result.data;
    const unsupported = data.unsupported === true;
    const decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED' = unsupported
      ? 'UNSUPPORTED'
      : data.allowed
        ? 'ALLOW'
        : 'DENY';
    const passed = !unsupported && decision === c.expectation;
    return {
      case: c,
      ...(c.description !== undefined ? { description: c.description } : {}),
      expectation: c.expectation,
      decision,
      passed,
      unsupported,
      matchedPath: data.matchedPath,
      matchedRule: data.matchedRule,
      reason: data.reason,
      trace: data.trace,
    };
  }

  simulate(cases: RtdbCase[]): RtdbSimulationSummary {
    const caseResults = cases.map((c) => this.runOne(c));
    let passed = 0;
    let failed = 0;
    let unsupported = 0;
    for (const r of caseResults) {
      if (r.unsupported) unsupported++;
      else if (r.passed) passed++;
      else failed++;
    }
    return { passed, failed, unsupported, cases: caseResults, coverage: this.coverage(caseResults) };
  }

  coverage(results: readonly RtdbCaseResult[], options?: RtdbCoverageOptions): RtdbCoverageSummary {
    const recorder = new RtdbCoverageRecorder(this.doc.compile());
    for (const result of results) {
      recorder.record(result.trace);
      if (result.case.operation === 'read') recorder.recordQuery(result.case.path, result.case.query);
    }
    return recorder.summarize(options);
  }

  explain(oneCase: RtdbCase): RtdbExplanation {
    const r = this.runOne(oneCase);
    return {
      decision: r.decision,
      expectation: r.expectation,
      passed: r.passed,
      unsupported: r.unsupported,
      matchedPath: r.matchedPath,
      matchedRule: r.matchedRule,
      reason: r.reason,
      trace: r.trace,
    };
  }

  toJSON(): RtdbRulesJson {
    return this.doc.toJSON();
  }
}

/** Internal document adapter for already-compiled Firebase rules JSON. */
class CompiledRtdbRulesDocument implements RtdbRulesDocumentInternal {
  private compiled: CompiledRtdbRules | undefined;

  constructor(private readonly json: RtdbRulesJson) {}

  toJSON(): RtdbRulesJson {
    return this.json;
  }

  compile(): CompiledRtdbRules {
    this.compiled ??= compileRtdbRules(this.json);
    return this.compiled;
  }

  check(): RtdbRulesCheckResult {
    return checkRtdbRules(() => this.compile());
  }

  simulate(input: RtdbRulesSimulationInput): SimulateResult {
    return simulateRtdbRules(this.compile(), normalizeSimulationInput(input));
  }
}

/**
 * Read the text of a `database.rules.json` file as the sandbox reads it: line
 * and block comments, rule strings broken across lines, and trailing commas
 * are accepted, as production accepts them.
 */
function parseRulesText(text: string): RtdbRulesJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toStrictRulesJson(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rulesTextError(`Realtime Database rules text is not valid JSON: ${detail}`);
  }
  const rules = (parsed as { rules?: unknown } | null)?.rules;
  const hasRulesObject = typeof rules === 'object' && rules !== null && !Array.isArray(rules);
  if (!hasRulesObject) throw rulesTextError('Realtime Database rules text has no top-level "rules" object');
  return parsed as RtdbRulesJson;
}

function rulesTextError(message: string): RulesCompileError {
  return new RulesCompileError(message, [{ code: 'PARSE_ERROR', severity: 'error', message, origin: 'parse' }]);
}

/**
 * Build a deep handle on a Realtime Database ruleset from the text of a
 * `database.rules.json` file, a definition, a compiled document, or compiled
 * `{ rules }` JSON.
 *
 * @throws {RulesCompileError} when rules text is not JSON (after comments
 *   and trailing commas) or has no top-level `rules` object.
 */
export function rtdbRules(input: RtdbRulesInput | string): RtdbRuleset {
  if (typeof input === 'string') input = parseRulesText(input);
  if (isDocument(input)) return new DocumentRtdbRuleset(input);
  if (isCompiledJson(input)) {
    return new DocumentRtdbRuleset(new CompiledRtdbRulesDocument(input));
  }
  return new DocumentRtdbRuleset(
    defineRtdbRules(input as RtdbRulesDefinition) as RtdbRulesDocumentInternal,
  );
}
