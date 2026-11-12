/**
 * `pyric/rules/internal` — the low-level rules engine seam.
 *
 * NOT part of the public `pyric/rules` contract. The public front door
 * (`firestoreRules`, `rtdbRules`, `lint`, the assertion adapters, the
 * value helpers, and the RTDB constraints DSL) lives in `../index.ts`
 * and is a thin layer over the primitives re-exported here.
 *
 * This seam exists so the package's own deep consumers (the sandbox
 * simulator, the test suites) and the sibling tooling packages
 * (`@pyric/cli`) can reach the engine primitives — parser, linter,
 * simulator handler, resolver, wrappers, RTDB machinery — without those
 * primitives leaking onto the curated public surface. Mirrors the
 * established `pyric/sandbox/internal` / `pyric/storage/internal` pattern.
 *
 * Browser-safe: no `node:` builtins, no TypeScript compiler. Node-only
 * additions (the fs module resolver, agent-tool factories) live on
 * `./node`; the composite-index extractor (TS compiler) is isolated on
 * `./extract`.
 *
 * Surface:
 *   - Parser + AST (parser/AST/validator/assembler)
 *   - Linter (`lintFirestoreRules` + warning/metrics types)
 *   - 2+modules resolver (`resolveModules`) + stdlib
 *   - Rules simulator (`SimulateFirestoreRulesHandler` + value
 *     wrappers — `Timestamp`, `Path`, etc.)
 *   - Rules Test API client (`TestFirestoreRulesHandler`, takes
 *     `ProjectScope` per F3)
 *   - Sentinel expression engine (used by sandbox for $expr
 *     resolution in declarative transactions)
 */

// ─── Parser + AST ────────────────────────────────────────────────────
export {
  parseToAST,
  parseToASTOrError,
  parseFunctions,
} from '../grammar/FirestoreParser.js';
export type { ParseError, ParseResult } from '../grammar/FirestoreParser.js';
export { assembleRules, assembleExpression, assembleExpression as printExpression } from '../grammar/FirestoreAssembler.js';
export { validateFirestoreRules } from '../grammar/FirestoreValidator.js';
export { isStorageServiceName, topLevelMatches } from '../grammar/service-blocks.js';
export { compileLimitViolations, describeCompileLimitViolations } from '../grammar/compile-limits.js';
export {
  checkRulesSource,
  rulesGrammarRejection,
  rulesSourceRejection,
  sourceCompileLimitViolations,
} from '../grammar/source-compile-limits.js';
export type { RulesSourceRejection } from '../grammar/source-compile-limits.js';
export type { CompileLimitViolation } from '../grammar/compile-limits.js';
export type { ValidationFinding } from '../grammar/FirestoreValidator.js';
export type {
  FirestoreRules,
  MatchBlock,
  AllowRule,
  Operation,
  FunctionDef,
  LetBinding,
  Expression,
  PathSegment,
  SourceLoc,
} from '../grammar/FirestoreAST.js';

// ─── Linter ──────────────────────────────────────────────────────────
export { lintFirestoreRules } from '../linter/linter.js';
export type {
  LintResult,
  LintWarning,
  LintOptions,
  RulesMetrics,
} from '../linter/linter.js';

// ─── Modules resolver — Node-only ────────────────────────────────────
// The resolver reads stdlib files off disk and so can't ship to the
// browser. Its value exports live on `pyric/rules/internal/node`;
// only the (erasable) types stay on the universal root entry.
export type { ResolveResult, ResolveOptions } from '../modules/resolver.js';

// ─── Rules simulator ─────────────────────────────────────────────────
export { SimulateFirestoreRulesHandler, SERVER_TIMESTAMP } from '../simulator/handler.js';
export { DOCUMENT_PATH_FORM, documentRelativePath } from '../simulator/request-path.js';
export { parseErrorWording } from '../grammar/parse-error-wording.js';
export type { ParseFailurePosition } from '../grammar/parse-error-wording.js';
export {
  collectMatches,
  indexRulesetScopes,
  renderMatchBlockPath,
} from '../simulator/match-resolution.js';
export type { MatchResult } from '../simulator/match-resolution.js';
export {
  collectRootMatches,
  resolveRootMatch,
  rootBlockGovernsEveryDocument,
  rootGovernsEveryDocument,
} from '../simulator/root-match.js';
export type { RootMatch } from '../simulator/root-match.js';
export { evaluateQueryProof } from '../simulator/query-proof.js';
export type {
  QueryConstraints,
  QueryProofResidual,
  QueryWhereConstraint,
  QueryWhereValue,
} from '../simulator/query-proof.js';
export {
  formatQueryScalarForRemediation,
  isQueryProofScalar,
  queryProofScalarsEqual,
  replaceTokenInQueryScalar,
} from '../simulator/query-proof-residual.js';
export type {
  FormatQueryScalarOptions,
  RulesScalar,
  RulesWrapperScalar,
  Scalar as QueryProofScalar,
} from '../simulator/query-proof-residual.js';
export {
  buildQueryRepro,
  listQueryFromConstraints,
  listQueryToConstraints,
  proveListQuery,
  renderQueryRemediation,
  renderQueryRepro,
} from '../simulator/list-query-proof.js';
export type {
  ListProofVerdict,
  ListQueryProofReport,
  QueryProofDiagnostic,
  QueryProofFailure,
  QueryRepro,
} from '../simulator/list-query-proof.js';
export {
  analyzeListRulePathInvariance,
  buildListRuleFunctionScope,
} from '../simulator/list-rule-path-proof.js';
export type {
  ListRuleFunctionScope,
  ListRulePathAnalysis,
} from '../simulator/list-rule-path-proof.js';
export { evaluate, UnsupportedError, TraceRecorder } from '../simulator/evaluator.js';
export type { SimulationContext, ExprTraceEntry } from '../simulator/evaluator.js';
export type { DocumentLookupMeta } from '../simulator/evaluation-context.js';
export { EXISTS_ONLY_DOC, normalizeDocumentPath } from '../simulator/document-lookups.js';
export { projectAfterState } from '../simulator/project-after-state.js';
export { MapDiff, FirestoreSet } from '../simulator/mapdiff.js';

// ─── Expression DSL primitives (used by sdk's transaction probe + tests)
export { tokenize } from '../simulator/expression/lexer.js';
export { parse } from '../simulator/expression/parser.js';

// ─── Value wrappers ──────────────────────────────────────────────────
export { Timestamp } from '../simulator/wrappers/timestamp.js';
export { Path } from '../simulator/wrappers/path.js';
export { Reference, referenceToResourceName } from '../simulator/wrappers/reference.js';
export { Vector } from '../simulator/wrappers/vector.js';
export { Bytes } from '../simulator/wrappers/bytes.js';
export { Duration } from '../simulator/wrappers/duration.js';
export { LatLng } from '../simulator/wrappers/latlng.js';
export { RulesValue, NO_OP } from '../simulator/wrappers/base.js';

// ─── Host numbers ────────────────────────────────────────────────────
export { isHostIntNumber } from '../simulator/rules-int.js';
export type {
  FirestoreMethod,
  TestCase,
  TestIdentity,
  TestResult,
  TestFirestoreRulesResult,
  FunctionMock,
  ExpressionReportLevel,
  ListQuery,
  ListQueryWhereConstraint,
  RulesTestApiResultDetails,
  RulesTestIssue,
  RuleEvaluation,
  PathResolutionEntry,
  PathResolutionTrace,
} from '../test/spec.js';
export {
  FIRESTORE_METHODS,
  ListQuerySchema,
  ListQueryWhereConstraintSchema,
  TestCaseSchema,
  TestIdentitySchema,
  buildApiTestCase,
  renderLegacyDebugMessages,
  projectEvaluatedRule,
} from '../test/spec.js';
export type { EvaluatedRuleInfo } from '../test/spec.js';
export { caseShapeRefusal } from '../test/case-shape.js';

// ─── Sentinel expression engine ──────────────────────────────────────
export { resolveExpressionsInData, ExpressionWalkError } from '../simulator/expression/walk-data.js';
export { EvalError } from '../simulator/expression/eval-errors.js';
export {
  ExpressionLexError,
  ExpressionParseError,
} from '../simulator/expression/types.js';

// ─── Stdlib reference (browser-safe — pure data) ─────────────────────
// Module-organized reference an agent can call before writing rules.
// Exposed through service-neutral tools plus retained Firestore aliases in
// `createFirestoreRulesStdlibTools()`; also importable directly.
export {
  STDLIB_MODULES,
  findModuleByKey,
  allModuleKeys,
  modulesForService,
  suggestKey,
} from '../stdlib-modules.js';
export type {
  StdlibModule,
  StdlibEntry,
  ModuleKind,
  RulesService,
} from '../stdlib-modules.js';

// Browser-safe `2+modules` resolver — pre-supplies the inlined stdlib
// content so it works without `node:fs`. Node consumers should keep
// importing `resolveModules` from `pyric/rules/internal/node`,
// which falls back to disk reads for stdlib modules and picks up
// `.rules` edits between builds without re-running the inliner.
export { resolveModulesBrowser, resolveModulesWithFiles, STDLIB_INLINE, resolveAuthoredSourceLoc, resolveAuthoredLoc, readAuthoredSourceMap, type AuthoredSourceLoc, type AuthoredSourceMap } from '../modules/resolver-browser.js';
export type { WriteFirestoreRulesResult } from '../write/spec.js';
export type { InspectFirestoreRulesResult, RulesSummary } from '../inspect/spec.js';

// ─── Game-rules generators — declarative rules assembly ───────────────
// Used by playground game scaffolding to emit Firestore rules for grid
// games (TTT, C4, Gomoku) without hand-writing the boilerplate.
export {
  assembleGameRules,
  type GameConfig,
} from '../generators/assembler.js';
export {
  generateWinLines,
  defaultCellName,
  indexToColRow,
  emptyBoard,
  type GridConfig,
} from '../generators/grid.js';
export * from '../generators/expressions.js';

// ─── RTDB rules engine ───────────────────────────────────────────────
// The Realtime Database rules compiler and simulator live on the sibling
// `./rtdb` entry, NOT here. This browser-safe seam excludes the engine. The public
// front door re-exports the (browser-safe) RTDB constraints DSL directly
// from `../rtdb/constraints`; node consumers that need the engine
// import from `pyric/rules/internal/rtdb`.
//
// The expression parser is the exception because the browser assurance runtime
// needs to classify individual expressions without importing the full engine.
export { parseExpression as parseRtdbExpression } from '../rtdb/grammar/RtdbExprParser.js';
export type { ParsedExpression as ParsedRtdbExpression } from '../rtdb/types.js';

// Names pyric's own modules import from the engine, re-exported here when
// the engine moved into this package (#1521). Unstable, like the rest of
// this entry.
export { loadFirebaseJsonRules } from '../api/rtdb-firebase-json.js';
export { normalizeAuthState } from '../auth/auth-state.js';
export type { AuthState } from '../auth/auth-state.js';
export { SANDBOX_PROJECT_ID, accountTokenClaims, idTokenAudience, rulesTokenFromIdToken, tokenClaimAccount, withIdTokenClaims } from '../auth/token-claims.js';
export type { TokenClaimAccount, TokenClaimRecord } from '../auth/token-claims.js';
export { closestKey } from '../closest-key.js';
export { MAX_BRACKET_DEPTH } from '../grammar/bracket-scan.js';
export { NESTING_MESSAGE } from '../grammar/compile-limits.js';
export { copyExpressionPosition, expressionPosition } from '../grammar/expression-positions.js';
export type { ExpressionPosition } from '../grammar/expression-positions.js';
export type { ServiceBlock } from '../grammar/FirestoreAST.js';
export { parseExpression, parseRulesFile } from '../grammar/FirestoreParser.js';
export { recursiveWildcardMinimum } from '../grammar/recursive-wildcard-minimum.js';
export { DUPLICATE_SERVICE_REASON, duplicateServiceRejection } from '../grammar/source-compile-limits.js';
export { parseStdlibTestFile } from '../modules/stdlib-cost.js';
export { ConversionFailure, applyConversion, conversionFor } from '../simulator/conversions.js';
export { resolveExists, resolveGet } from '../simulator/document-lookups.js';
export { DIVIDE_BY_ZERO_MESSAGE, functionNotFoundMessage } from '../simulator/eval-error.js';
export { EXPRESSION_LIMIT, EXPRESSION_LIMIT_MESSAGE, ExpressionBudget, describeExpressionLimit } from '../simulator/expression-budget.js';
export { SET_ALGEBRA_NAMES, SetMethodFailure, setMethod } from '../simulator/firestore-set.js';
export { reviveFirestoreNumbers } from '../simulator/firestore-values.js';
export { evaluateHashingMethod, sha256 } from '../simulator/hashing-builtins.js';
export { IndexAccessFailure, indexList, indexMap, indexValue, readMember } from '../simulator/index-access.js';
export { ListMethodFailure, listConcat, listJoin, listMembership, listRemoveAll } from '../simulator/list-methods.js';
export type { ListMembershipMethod } from '../simulator/list-methods.js';
export { attachOrBudgetStep, getListBlockSteps, getOrBudgetSteps, setListBlockSteps } from '../simulator/list-proof-budget.js';
export type { ListBlockStep, OrBudgetStep } from '../simulator/list-proof-budget.js';
export { lookupAccessKey, slashedSegment, slashedSegmentReason } from '../simulator/lookup-path.js';
export { MapMethodFailure, mapKeys, mapList, mapLiteral, mapValues } from '../simulator/map-keys.js';
export type { MapListMethod } from '../simulator/map-keys.js';
export { MathFailure, applyMath } from '../simulator/math-builtins.js';
export { MembershipFailure, membership } from '../simulator/membership.js';
export { substituteIdentifiers } from '../simulator/query-proof-scope.js';
export { re2PatternProblem } from '../simulator/re2-pattern-check.js';
export { resolveRootBlockMatch } from '../simulator/root-match.js';
export { IntFailure, hostNumber, intArithmetic, isRulesInt, negateInt, numericLiteralValue, orderNumbers, rulesFloatValue, rulesInt, rulesNumberAsDouble, typeClaimNumbers } from '../simulator/rules-int.js';
export type { IntOperator, OrderingOperator } from '../simulator/rules-int.js';
export { describeRulesType, isRulesMap, parseRe2Ast, re2FullMatch, re2SizeRefusal, replaceRe2 } from '../simulator/rules-type.js';
export { sliceBoundsError } from '../simulator/slice-bounds.js';
export { lowerRulesString, upperRulesString } from '../simulator/string-case.js';
export { splitRe2 } from '../simulator/string-split.js';
export { trimRulesString } from '../simulator/string-trim.js';
export { listElementsEqual, rulesValuesEqual, setElementsEqual } from '../simulator/value-equality.js';
export { ValueRangeError } from '../simulator/wrappers/base.js';
export { RulesFloat } from '../simulator/wrappers/float.js';
export { buildFunctionMock, buildStorageApiTestCase, normalizeDocPath, normalizeStoragePath } from '../test/spec.js';
export type { ApiTestCase, StorageApiTestCase, StorageTestCase } from '../test/spec.js';
