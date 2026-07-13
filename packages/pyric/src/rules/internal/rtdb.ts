/**
 * Internal RTDB rules-engine seam.
 *
 * `pyric/database` is reserved for the Firebase-shaped sandbox mirror. This
 * unstable internal subpath exposes the pure rules parser, mapper, simulator,
 * replay engine, and constraints DSL used by pyric's tooling packages.
 */
export { replay } from '../../database/replay.js';
export type {
  RtdbReplayDivergence,
  RtdbReplayOptions,
  RtdbReplayResult,
} from '../../database/replay.js';
export {
  buildRuleExpression,
  RtdbMapper,
} from '../rtdb/mapper.js';
export {
  compileRtdbRules,
  serializeRtdbRules,
  simulateRtdbRules,
} from '../rtdb/compiled-rules.js';
export type { CompiledRtdbRules } from '../rtdb/compiled-rules.js';

export { parseExpression } from '../rtdb/grammar/RtdbExprParser.js';
export { validateExpression } from '../rtdb/grammar/validator.js';
export { lintExpression } from '../rtdb/grammar/linter.js';

export {
  SimulationInputSchema,
  SimulateErrorCode,
  SimulationResultSchema,
} from '../rtdb/simulation/spec.js';
export type {
  SimulationInput,
  SimulationResult,
  SimulateResult,
} from '../rtdb/simulation/spec.js';
export { SimulateHandler } from '../rtdb/simulation/handler.js';

export type {
  ParsedExpression,
  ParsedExpression as RtdbExpressionParseResult,
  RtdbIR,
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
  AUTH_UID,
  turnGuard,
  flip,
  winCheckHelper,
  schemaRules,
  ruleset,
  defineRtdbRules,
} from '../rtdb/constraints/index.js';
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
