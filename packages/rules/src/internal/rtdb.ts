/**
 * Internal RTDB rules-engine seam.
 *
 * `pyric/database` is reserved for the Firebase-shaped sandbox mirror. This
 * unstable internal subpath exposes the pure rules parser, simulator,
 * and constraints DSL used by pyric's tooling packages.
 */
export {
  collectAncestors as collectRtdbRuleAncestors,
  simulatedAuthOf as rtdbAuthVariable,
  wildcardChildOf as rtdbWildcardChild,
} from '../rtdb/simulation/handler.js';
export type { AncestorMatch as RtdbRuleAncestor } from '../rtdb/simulation/handler.js';
export {
  buildRuleExpression,
  compileRtdbRules,
  serializeRtdbRules,
  simulateRtdbRules,
} from '../rtdb/compiled-rules.js';
export type { CompiledRtdbRules, SimulateRtdbOptions } from '../rtdb/compiled-rules.js';

export { locateRtdbRule, locateRtdbTrace } from '../rtdb/source-locations.js';
export type {
  LocatedRtdbRuleEvaluation,
  RtdbRuleKind,
  RtdbSourceLocation,
} from '../rtdb/source-locations.js';

export { parseExpression } from '../rtdb/grammar/RtdbExprParser.js';
export {
  parseRtdbExpressionTree,
  printRtdbExpressionTree,
} from '../rtdb/grammar/expression-tree.js';
export type {
  RtdbBinaryOperator,
  RtdbExpressionTree,
  RtdbExpressionTreeResult,
} from '../rtdb/grammar/expression-tree.js';
export {
  canonicalRtdbExpression,
  canonicalTree as canonicalRtdbExpressionTree,
  RtdbExpressionSyntaxError,
} from '../rtdb/grammar/canonical.js';
export { DIFFED_RULE_KINDS, diffRtdbRules } from '../rtdb/rules-diff.js';
export type { DiffRtdbRulesOptions, RtdbRuleChange } from '../rtdb/rules-diff.js';
export { validateExpression } from '../rtdb/grammar/validator.js';
export { lintExpression } from '../rtdb/grammar/linter.js';
export { lintRtdbRuleset } from '../rtdb/grammar/ruleset-lint.js';
export type { RtdbSecurityCode, RtdbSecurityFinding } from '../rtdb/grammar/ruleset-lint.js';

export {
  SimulationInputSchema,
  SimulateErrorCode,
  SimulationResultSchema,
  RtdbRuleEvaluationSchema,
} from '../rtdb/simulation/spec.js';
export type {
  RtdbRuleEvaluation,
  SimulationInput,
  SimulationResult,
  SimulateResult,
} from '../rtdb/simulation/spec.js';
export type {
  ParsedExpression,
  ParsedExpression as RtdbExpressionParseResult,
  RtdbNode,
  RtdbRuleExpression,
  RuleError,
  RuleLint,
} from '../rtdb/types.js';

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
  ref,
  AUTH_UID,
  turnGuard,
  flip,
  winCheckHelper,
  schemaRules,
  ruleset,
  defineRtdbRules,
} from '../rtdb/constraints/index.js';
export { checkRtdbRules, normalizeSimulationInput } from '../rtdb/constraints/document.js';
export { withPriorities, type InlinePriority } from '../rtdb/data/normalize.js';
export { rtdbRulesSourceRejection } from '../rtdb/source-rejection.js';
export { toStrictRulesJson } from '../rtdb/rules-text.js';
export type { RtdbRulesSourceRejection } from '../rtdb/source-rejection.js';
export type {
  Expr,
  PathDef,
  RtdbRulesCheckResult,
  RtdbRulesDefinition,
  RtdbRulesDocumentInternal as RtdbRulesDocument,
  RtdbRulesFinding,
  RtdbRulesFindingRule,
  RtdbRulesJson,
  RtdbRulesSimulationAuth,
  RtdbRulesSimulationInput,
  RulesetContext,
  SchemaRulesResult,
  Segment,
} from '../rtdb/constraints/index.js';

// Names pyric's own modules import from the engine, re-exported here when
// the engine moved into this package (#1521). Unstable, like the rest of
// this entry.
export { DEFAULT_DATABASE_RULES_FILE, databaseRulesConfig } from '../rtdb/data/database-rules-config.js';
export type { DatabaseRulesConfig, DatabaseRulesConfigOptions, DatabaseRulesFileTarget, UnresolvedDatabaseRulesTarget } from '../rtdb/data/database-rules-config.js';
export { LOCKED_DATABASE_RULES, UNNAMED_DEFAULT_DATABASE_INSTANCE, createDatabaseInstanceRegistry, databaseInstanceKey, databaseInstanceNamed, defaultDatabaseInstance, defaultDatabaseInstanceName, isCustomDatabaseHost, isDefaultDatabaseInstance, parseDatabaseLocationUrl, parseDatabaseUrl, resolveDatabaseInstance, undeployedInstanceNotice } from '../rtdb/data/instances.js';
export type { DatabaseInstance, DatabaseInstanceRegistry, DatabaseLocationUrl } from '../rtdb/data/instances.js';
export { jsonEqual } from '../rtdb/data/json-equal.js';
export type { JsonValue } from '../rtdb/data/json-value.js';
export { inlinePriorities, normalizeNode, normalizeRuleWrite, writePriority } from '../rtdb/data/normalize.js';
export { pathSegments } from '../rtdb/data/paths.js';
export type { Bound, LimitKind, OrderBy, QuerySpec } from '../rtdb/data/query-spec.js';
export { normalizeOptionalEndpointValue, validateCursorKey, validateLimit, validateOrderByChildPath, validateQuerySpec } from '../rtdb/data/query-validation.js';
export { SDK_VERSION } from '../rtdb/data/sdk-version.js';
export { isIncrementSentinel, isServerTimestampSentinel, resolveSentinels } from '../rtdb/data/sentinels.js';
export type { IncrementSentinel, ServerTimestampSentinel } from '../rtdb/data/sentinels.js';
export { invalidInfoWrite, isInfoPath, validateReferencePath, validateUpdatePaths, validateWritablePath } from '../rtdb/data/writable-path.js';
export { errorPrefix, isInvalidJSONNumber, validateData, validateWrite } from '../rtdb/data/write-validation.js';
export { MAX_REGEX_STATES, STATES_MESSAGE, sizeProblem, stateCount } from '../rtdb/grammar/regex-limits.js';
export { DataSnapshot, RtdbRuleRuntimeError, evaluateRtdbExpression } from '../rtdb/grammar/simulator.js';
export type { EvalContext } from '../rtdb/grammar/simulator.js';
export { findMatchingNodesAtPath, nodesDeclaringIndex } from '../rtdb/index-lookup.js';
export { stripJsonComments } from '../rtdb/rules-text.js';
export { SimulateHandler } from '../rtdb/simulation/handler.js';
export { RTDB_STDLIB_IMPORT, RTDB_STDLIB_MODULES, findRtdbStdlibModule, rtdbImportLineFor } from '../rtdb/stdlib/catalog.js';
export { EvalError } from '../simulator/eval-error.js';
