/**
 * `pyric/rules` — author, lint, simulate, and assert Firebase security
 * rules, in process, without a deployment.
 *
 * The surface is small on purpose. Two named constructors return deep,
 * safe-by-default handles:
 *
 *   firestoreRules(source) → lint() · simulate(cases) · explain(case) · toJSON()
 *   rtdbRules(defOrDocOrJson) → lint() · simulate(cases) · explain(case) · toJSON()
 *
 * Compiling unparseable source throws {@link RulesCompileError}; past that,
 * the handles never throw on a rule outcome — a denied or abstained case is
 * returned as data. `lint(source)` is the tolerant front door for AI
 * authoring: it accepts anything, never throws, and returns every issue as a
 * unified {@link RuleIssue}. The assertion adapter (`assertCase`, with
 * `explainCase` as its trace renderer) is the seam to a throwing test
 * runner: `for (const c of cases) test(c.description, () => assertCase(ruleset, c))`.
 *
 * The Realtime Database constraints DSL (`defineRtdbRules` + combinators) and
 * the value helpers (`serverTimestamp`, `timestamp`, …) are re-exported here
 * as siblings.
 *
 * Storage rules are not covered here (yet). The lower-level engine —
 * simulator handlers, parser/AST, resolver, wrappers — is engine-internal;
 * package-internal consumers reach it through `pyric/rules/internal`.
 */

// ─── Constructors ────────────────────────────────────────────────────
export { firestoreRules } from './api/firestore.js';
export type { FirestoreRuleset } from './api/firestore.js';
export { rtdbRules } from './api/rtdb.js';
export type { RtdbRuleset } from './api/rtdb.js';

// ─── Tolerant lint (the AI-authoring front door) ─────────────────────
export { lint } from './api/lint.js';

// ─── Assertion adapter (the only throwing verb beyond constructors) ──
export { assertCase, explainCase } from './api/assert.js';

// ─── Errors ──────────────────────────────────────────────────────────
export {
  RulesCompileError,
  RulesAssertionError,
  RulesUnsupportedError,
} from './api/errors.js';

// ─── Unified issue ───────────────────────────────────────────────────
export type {
  RuleIssue,
  RuleIssueSeverity,
  RuleIssueOrigin,
} from './api/issue.js';

// ─── Case + result vocabulary (Firestore and RTDB kept distinct) ─────
export type {
  FirestoreCase,
  CaseResult,
  Explanation,
  SimulationSummary,
  RtdbCase,
  RtdbCaseResult,
  RtdbExplanation,
  RtdbSimulationSummary,
} from './api/case-types.js';

// ─── Structured trace types (plain data) ─────────────────────────────
export type {
  RuleEvaluation,
  PathResolutionEntry,
  PathResolutionTrace,
  EvaluatedRuleInfo,
  FirestoreMethod,
} from './test/spec.js';
export type { ExprTraceEntry } from './simulator/evaluator.js';

// ─── Value helpers ───────────────────────────────────────────────────
export {
  serverTimestamp,
  timestamp,
  bytes,
  latlng,
  duration,
  reference,
  vector,
} from './api/values.js';

// ─── RTDB constraints DSL (re-exported unchanged as siblings) ────────
export {
  expr,
  all,
  any,
  not,
  deny,
  always,
  allow,
  authenticated,
  ownPath,
  ownField,
  isNew,
  hasChildren,
  hasChild,
  fieldIsString,
  fieldIsNumber,
  fieldIsBoolean,
  fieldEnum,
  immutable,
  immutableSelf,
  rootExists,
  rootEquals,
  pathOwnerOnly,
  fieldOwnerOnly,
  ownerOrNew,
  hasRole,
  isMember,
  required,
  transition,
  dataVal,
  newDataVal,
  dataExists,
  newDataExists,
  newDataIs,
  dataParentVal,
  newDataParentVal,
  newDataParentExists,
  eq,
  neq,
  gt,
  lte,
  AUTH_UID,
  turnGuard,
  flip,
  winCheckHelper,
  schemaRules,
  ruleset,
  defineRtdbRules,
} from '../database/constraints/index.js';
export type {
  Expr,
  PathDef,
  Segment,
  RulesetContext,
  SchemaRulesResult,
  RtdbRulesDefinition,
  RtdbRulesDocument,
  RtdbRulesJson,
  RtdbRulesCheckResult,
  RtdbRulesFinding,
  RtdbRulesFindingRule,
  RtdbRulesSimulationAuth,
  RtdbRulesSimulationInput,
} from '../database/constraints/index.js';
