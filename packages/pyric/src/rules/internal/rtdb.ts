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
} from '../../database/mapper.js';

export { parseExpression } from '../../database/grammar/RtdbExprParser.js';
export { validateExpression } from '../../database/grammar/validator.js';
export { lintExpression } from '../../database/grammar/linter.js';

export {
  SimulationInputSchema,
  SimulateErrorCode,
  SimulationResultSchema,
} from '../../database/simulation/spec.js';
export type {
  SimulationInput,
  SimulationResult,
  SimulateResult,
} from '../../database/simulation/spec.js';
export { SimulateHandler } from '../../database/simulation/handler.js';

export type {
  ParsedExpression,
  ParsedExpression as RtdbExpressionParseResult,
  RtdbIR,
  RtdbNode,
  RtdbRuleExpression,
  RuleError,
  RuleLint,
} from '../../database/types.js';

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
} from '../../database/constraints/index.js';
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
} from '../../database/constraints/index.js';
