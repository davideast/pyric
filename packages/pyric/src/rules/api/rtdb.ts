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
import { invalidCase, simulateRtdbCase } from './rtdb-case-input.js';
import { resolveInstanceCase, rulesForInstance, type InstanceRules, type RulesPlacement } from './rtdb-instance-case.js';
import { loadFirebaseJsonRules, type RtdbFirebaseJsonOptions } from './rtdb-firebase-json.js';
import {
  RtdbCoverageRecorder,
  mergeRtdbCoverage,
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
  /** Structural findings on the compiled ruleset (from `check()`). On a
   *  ruleset from {@link rtdbRules.fromFirebaseJson}, each rules file's
   *  findings, once per file, with its `file`. */
  lint(): RuleIssue[];
  /** Run every case. Never throws on a rule outcome. */
  simulate(cases: RtdbCase[]): RtdbSimulationSummary;
  /**
   * Which `.read`, `.write`, `.validate` and `.indexOn` nodes the given case
   * results evaluated, and which they never reached. `simulate` returns this
   * for its own cases; call it to merge several runs or to attach a file name
   * and line numbers. A ruleset from {@link rtdbRules.fromFirebaseJson}
   * reports each rules file under the name `firebase.json` gives it, with
   * lines located in its text, and takes no options.
   */
  coverage(results: readonly RtdbCaseResult[], options?: RtdbCoverageOptions): RtdbCoverageSummary;
  /** The structured account of why one case resolved as it did. */
  explain(oneCase: RtdbCase): RtdbExplanation;
  /**
   * The compiled `rules.json`. On a ruleset from
   * {@link rtdbRules.fromFirebaseJson}, the default instance's rules; it
   * throws when `firebase.json` deploys none to the default instance.
   */
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
  constructor(private readonly placement: RulesPlacement) {}

  /** The one ruleset of a handle whose rules apply on every instance. */
  private get doc(): RtdbRulesDocumentInternal {
    if (this.placement.kind !== 'every-instance') throw new Error('per-instance rules hold one ruleset per instance');
    return this.placement.rules.doc;
  }

  lint(): RuleIssue[] {
    if (this.placement.kind === 'every-instance') return lintDocument(this.doc);
    return [...new Set(this.placement.instances.values())].flatMap((rules) =>
      lintDocument(rules.doc).map((issue) => (rules.file === undefined ? issue : { ...issue, file: rules.file })));
  }

  private runOne(c: RtdbCase): RtdbCaseResult {
    const resolved = resolveInstanceCase(this.placement, c);
    const instance = resolved.instance;
    const named = {
      case: c,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(instance !== undefined ? { instance } : {}),
    };
    const result = 'problem' in resolved
      ? invalidCase(resolved.problem)
      : simulateRtdbCase(resolved.rules.doc, resolved.evaluated);
    if (!result.success) {
      // Could not evaluate — report as unsupported rather than throw.
      return {
        ...named,
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
      ...named,
      expectation: c.expectation,
      decision,
      passed,
      unsupported,
      matchedPath: data.matchedPath,
      matchedRule: data.matchedRule,
      reason: data.reason,
      trace: instance === undefined ? data.trace : data.trace.map((entry) => ({ ...entry, instance })),
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
    if (this.placement.kind === 'every-instance') return fileCoverage(this.doc, results, options);
    const { defaultInstance, instances } = this.placement;
    const files = [...new Set(instances.values())];
    const summaries = files.map((rules) => {
      const ran = results.filter((r) => instances.get(r.instance ?? defaultInstance) === rules);
      return fileCoverage(rules.doc, ran, { ...(rules.file === undefined ? {} : { file: rules.file }), ...(rules.source === undefined ? {} : { source: rules.source }) });
    });
    return summaries.length === 1 ? summaries[0]! : mergeRtdbCoverage(summaries);
  }

  explain(oneCase: RtdbCase): RtdbExplanation {
    const r = this.runOne(oneCase);
    return {
      ...(r.instance !== undefined ? { instance: r.instance } : {}),
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
    if (this.placement.kind === 'every-instance') return this.doc.toJSON();
    const rules = rulesForInstance(this.placement, this.placement.defaultInstance, false);
    if ('problem' in rules) throw new Error(rules.problem);
    return rules.doc.toJSON();
  }
}

/** Structural and security findings on one ruleset. */
function lintDocument(doc: RtdbRulesDocumentInternal): RuleIssue[] {
  const check = doc.check();
  const issues = [
    ...check.errors.map((f) => rtdbFindingToIssue(f, 'error')),
    ...check.warnings.map((f) => rtdbFindingToIssue(f, 'warning')),
  ];
  // A ruleset that does not compile has no tree to read.
  if (check.errors.some((f) => f.code === 'COMPILE_ERROR')) return issues;
  return [...issues, ...lintRtdbRuleset(doc.compile()).map(rtdbSecurityFindingToIssue)];
}

/** Coverage of one ruleset by the results that ran on it. */
function fileCoverage(
  doc: RtdbRulesDocumentInternal,
  results: readonly RtdbCaseResult[],
  options?: RtdbCoverageOptions,
): RtdbCoverageSummary {
  const recorder = new RtdbCoverageRecorder(doc.compile());
  for (const result of results) {
    recorder.record(result.trace);
    // A case refused as invalid input, such as one with a query the SDK
    // refuses, reached no node and ran no query (CS-12). One that reached a
    // rule it could not evaluate still names the index its query needs.
    const refusedAsInput = result.unsupported && result.trace.length === 0;
    if (result.case.operation === 'read' && !refusedAsInput) {
      recorder.recordQuery(result.case.path, result.case.query);
    }
  }
  return recorder.summarize(options);
}

/** A handle whose one ruleset applies on whichever instance a case names. */
function everyInstance(doc: RtdbRulesDocumentInternal): RtdbRuleset {
  return new DocumentRtdbRuleset({ kind: 'every-instance', rules: { doc } });
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

function buildRtdbRules(input: RtdbRulesInput | string): RtdbRuleset {
  if (typeof input === 'string') input = parseRulesText(input);
  if (isDocument(input)) return everyInstance(input);
  if (isCompiledJson(input)) {
    return everyInstance(new CompiledRtdbRulesDocument(input));
  }
  return everyInstance(defineRtdbRules(input as RtdbRulesDefinition) as RtdbRulesDocumentInternal);
}

function fromFirebaseJson(
  firebaseJsonPath: string,
  options: RtdbFirebaseJsonOptions = {},
): RtdbRuleset {
  const loaded = loadFirebaseJsonRules(firebaseJsonPath, options);
  const instances = new Map<string, InstanceRules>();
  for (const file of loaded.files) {
    let json: RtdbRulesJson;
    try {
      json = parseRulesText(file.text);
    } catch (error) {
      throw error instanceof RulesCompileError
        ? new RulesCompileError(`${file.path}: ${error.message}`, error.issues)
        : error;
    }
    const rules: InstanceRules = { doc: new CompiledRtdbRulesDocument(json), file: file.file, source: file.text };
    for (const instance of file.instances) instances.set(instance, rules);
  }
  return new DocumentRtdbRuleset({
    kind: 'per-instance',
    defaultInstance: loaded.defaultInstance,
    ...(loaded.projectId === undefined ? {} : { projectId: loaded.projectId }),
    instances,
  });
}

/**
 * `rtdbRules`: call it with one ruleset, or call `rtdbRules.fromFirebaseJson`
 * for the rules a project's `firebase.json` deploys to each database
 * instance.
 */
export interface RtdbRulesConstructor {
  /**
   * Build a deep handle on a Realtime Database ruleset from the text of a
   * `database.rules.json` file, a definition, a compiled document, or compiled
   * `{ rules }` JSON.
   *
   * @throws {RulesCompileError} when rules text is not JSON (after comments
   *   and trailing commas) or has no top-level `rules` object.
   */
  (input: RtdbRulesInput | string): RtdbRuleset;
  /**
   * Build a handle on the Realtime Database rules a project's `firebase.json`
   * deploys, one ruleset per database instance, as `firebase deploy` resolves
   * them: a single `database` object deploys to the default instance, and each
   * entry of a `database` array deploys to its `instance`, or to the instances
   * `.firebaserc` maps its `target` to. Each rules file is read as
   * {@link rtdbRules} reads rules text, comments and trailing commas included.
   *
   * A case runs on the instance it names, or on the default instance
   * `<projectId>-default-rtdb`, which `<projectId>` also names; the project
   * id is `options.projectId`, else `projects.default` in the `.firebaserc`
   * beside `firebase.json`. A case that
   * names an instance `firebase.json` deploys no rules to is UNSUPPORTED, with
   * a reason naming the instances it does.
   *
   * Node-only: it reads files.
   *
   * @throws {RulesCompileError} when a rules file is not rules text.
   * @throws {Error} when a file cannot be read, `firebase.json` deploys no
   *   Realtime Database rules, or a deploy target maps to no instance.
   */
  fromFirebaseJson(firebaseJsonPath: string, options?: RtdbFirebaseJsonOptions): RtdbRuleset;
}

/**
 * Build a deep handle on a Realtime Database ruleset from the text of a
 * `database.rules.json` file, a definition, a compiled document, or compiled
 * `{ rules }` JSON.
 *
 * @throws {RulesCompileError} when rules text is not JSON (after comments
 *   and trailing commas) or has no top-level `rules` object.
 */
export const rtdbRules: RtdbRulesConstructor = Object.assign(buildRtdbRules, { fromFirebaseJson });
