/**
 * `pyric/rules` — Pyric-native Firestore rules tooling.
 *
 * Sibling to `pyric/firestore` (the modular Web-SDK swap-in). Rules
 * tooling lives here so non-standard surface (linter, parser, etc.)
 * doesn't pollute the swap-in namespace.
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
} from './grammar/FirestoreParser.js';
export type { ParseError, ParseResult } from './grammar/FirestoreParser.js';
export { assembleRules, assembleExpression as printExpression } from './grammar/FirestoreAssembler.js';
export { validateFirestoreRules } from './grammar/FirestoreValidator.js';
export type { ValidationFinding } from './grammar/FirestoreValidator.js';
export type {
  FirestoreRules,
  MatchBlock,
  AllowRule,
  FunctionDef,
  Expression,
  PathSegment,
  SourceLoc,
} from './grammar/FirestoreAST.js';

// ─── Linter ──────────────────────────────────────────────────────────
export { lintFirestoreRules } from './linter/linter.js';
export type {
  LintResult,
  LintWarning,
  LintOptions,
  RulesMetrics,
} from './linter/linter.js';

// ─── Modules resolver — Node-only ────────────────────────────────────
// The resolver reads stdlib files off disk and so can't ship to the
// browser. Its value exports live on `pyric/rules/node`;
// only the (erasable) types stay on the universal root entry.
export type { ResolveResult, ResolveOptions } from './modules/resolver.js';

// ─── Rules simulator ─────────────────────────────────────────────────
export { SimulateFirestoreRulesHandler, SERVER_TIMESTAMP } from './simulator/handler.js';
export { evaluate, UnsupportedError, TraceRecorder } from './simulator/evaluator.js';
export type { SimulationContext, ExprTraceEntry } from './simulator/evaluator.js';
export { projectAfterState } from './simulator/project-after-state.js';
export { MapDiff, FirestoreSet } from './simulator/mapdiff.js';

// ─── Expression DSL primitives (used by sdk's transaction probe + tests)
export { tokenize } from './simulator/expression/lexer.js';
export { parse } from './simulator/expression/parser.js';

// ─── Value wrappers ──────────────────────────────────────────────────
export { Timestamp } from './simulator/wrappers/timestamp.js';
export { Path } from './simulator/wrappers/path.js';
export { Reference, referenceToResourceName } from './simulator/wrappers/reference.js';
export { Vector } from './simulator/wrappers/vector.js';
export { Bytes } from './simulator/wrappers/bytes.js';
export { Duration } from './simulator/wrappers/duration.js';
export { LatLng } from './simulator/wrappers/latlng.js';
export { RulesValue, NO_OP } from './simulator/wrappers/base.js';

// ─── Rules Test API client ───────────────────────────────────────────
export { TestFirestoreRulesHandler } from './test/handler.js';
export type {
  FirestoreMethod,
  TestCase,
  TestIdentity,
  TestResult,
  TestFirestoreRulesResult,
  FunctionMock,
  ExpressionReportLevel,
  ListQuery,
  RulesTestApiResultDetails,
  RulesTestIssue,
  RuleEvaluation,
  PathResolutionEntry,
  PathResolutionTrace,
} from './test/spec.js';
export {
  FIRESTORE_METHODS,
  TestCaseSchema,
  TestIdentitySchema,
  renderLegacyDebugMessages,
} from './test/spec.js';

// ─── Sentinel expression engine ──────────────────────────────────────
export { resolveExpressionsInData, ExpressionWalkError } from './simulator/expression/walk-data.js';
export { EvalError } from './simulator/expression/eval-errors.js';
export {
  ExpressionLexError,
  ExpressionParseError,
} from './simulator/expression/types.js';

// ─── Tool factories (Slice 8) — Node-only ────────────────────────────
// `createFirestoreRulesTools` wraps the resolver (Node-only) into
// agent tools, so the factory itself is Node-only. Values live on
// `pyric/rules/node`; types stay here so consumers in
// either environment can describe tool deps without dragging Node
// imports along.
export type {
  FirestoreRulesToolDeps,
  FirestoreSimulatorToolDeps,
} from './tools.js';

// ─── Stdlib reference (browser-safe — pure data) ─────────────────────
// Module-organized reference an agent can call before writing rules.
// Exposed via the `firestore_rules_stdlib_list` + `_get` tools in
// `createFirestoreRulesStdlibTools()`; also importable directly for
// non-agent consumers (docs generators, lint integrations).
export {
  STDLIB_MODULES,
  findModuleByKey,
  allModuleKeys,
  suggestKey,
} from './stdlib-modules.js';
export type {
  StdlibModule,
  StdlibEntry,
  ModuleKind,
} from './stdlib-modules.js';
export { createFirestoreRulesStdlibTools } from './stdlib-tools.js';

// Browser-safe `2+modules` resolver — pre-supplies the inlined stdlib
// content so it works without `node:fs`. Node consumers should keep
// importing `resolveModules` from `pyric/rules/node`,
// which falls back to disk reads for stdlib modules and picks up
// `.rules` edits between builds without re-running the inliner.
export { resolveModulesBrowser, STDLIB_INLINE } from './modules/resolver-browser.js';

// Composite-index extractor: static analysis of JS/TS source for the modular
// Firestore client's `query(collection(...), where(...), orderBy(...))` pattern.
// The VALUE exports (extractIndexes, the handler, the tool) live on the
// `pyric/rules/extract` subpath, NOT here: the extractor statically imports the
// TS compiler (~10MB), and a root re-export drags it into EVERY browser app that
// reaches `pyric/rules` via `pyric/firestore` but never extracts (Vite's dep
// optimizer bundles bare-specifier deps wholesale and follows dynamic imports,
// so neither tree-shaking nor lazy-loading keeps it out). See `./extract.ts`.
// The erasable TYPES stay here (type-only exports compile away, never bundled).
export type { ExtractIndexesOptions } from './indexes/extractHandler.js';
export type {
  ExtractResult,
  ExtractionWarning,
  ExtractionSignal,
  ExtractOptions,
  QueryShape,
  Filter as IndexFilter,
  Order as IndexOrder,
  Fragment as IndexFragment,
  QueryBaseDecl,
  AnnotationApplied,
} from './indexes/extract/types.js';
export type {
  ApiScope,
  ArrayConfig,
  Density,
  Index,
  IndexField,
  IndexFieldOrder,
  IndexOperation,
  IndexState,
  IndexesConfig,
  IndexesConfigEntry,
  QueryScope,
  VectorConfig,
} from './indexes/types.js';

// ─── Rules deploy (write) — Firebase Rules API client ─────────────────
// Takes ProjectScope (per F3). Pairs with `firestore_test_rules`
// (also takes ProjectScope) and `lintFirestoreRules` / `validateFirestoreRules`
// in the same package — full rules lifecycle on one surface.
export { WriteFirestoreRulesHandler } from './write/handler.js';
export type { WriteFirestoreRulesResult } from './write/spec.js';

// ─── Rules inspect (read) — Firebase Rules API client ─────────────────
// Fetches + parses the deployed Firestore ruleset (list + get latest),
// returns AST + summary + validator findings. Takes ProjectScope (per
// F3). Browser-safe — REST + Bearer token only, no firebase-admin.
// Pairs with WriteFirestoreRulesHandler on the write side.
export { InspectFirestoreRulesHandler } from './inspect/handler.js';
export type { InspectFirestoreRulesResult, RulesSummary } from './inspect/spec.js';
export { createFirestoreInspectTool } from './inspect/tools.js';
export type { FirestoreInspectToolDeps } from './inspect/tools.js';

// ─── Game-rules generators — declarative rules assembly ───────────────
// Used by playground game scaffolding to emit Firestore rules for grid
// games (TTT, C4, Gomoku) without hand-writing the boilerplate.
export {
  assembleGameRules,
  type GameConfig,
} from './generators/assembler.js';
export {
  generateWinLines,
  defaultCellName,
  indexToColRow,
  emptyBoard,
  type GridConfig,
} from './generators/grid.js';
export * from './generators/expressions.js';
