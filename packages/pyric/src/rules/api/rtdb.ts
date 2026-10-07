/**
 * `rtdbRules(...)` — the deep handle on a Realtime Database ruleset.
 *
 * Accepts any of three inputs and normalizes them to one handle:
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
    return { passed, failed, unsupported, cases: caseResults };
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
 * Build a deep handle on a Realtime Database ruleset from a definition, a
 * compiled document, or compiled `{ rules }` JSON.
 */
export function rtdbRules(input: RtdbRulesInput): RtdbRuleset {
  if (isDocument(input)) return new DocumentRtdbRuleset(input);
  if (isCompiledJson(input)) {
    return new DocumentRtdbRuleset(new CompiledRtdbRulesDocument(input));
  }
  return new DocumentRtdbRuleset(
    defineRtdbRules(input as RtdbRulesDefinition) as RtdbRulesDocumentInternal,
  );
}
