/**
 * RTDB rules tooling facade.
 *
 * Firestore rules live under `pyric/rules`; this subpath gives
 * Realtime Database rules the same first-class packaging without
 * moving the existing implementation out of `pyric/database`.
 */
export type { RtdbHost } from '../database/host.js';
export { fetchDatabase } from '../database/host.js';
export {
  createRtdbRulesTools,
  type RtdbRulesToolDeps,
} from '../database/tools.js';
export { getRtdbTools } from '../database/resolver.js';
export {
  buildRuleExpression,
  RtdbMapper,
} from '../database/mapper.js';

export { parseExpression } from '../database/grammar/RtdbExprParser.js';
export { validateExpression } from '../database/grammar/validator.js';
export { lintExpression } from '../database/grammar/linter.js';

export {
  GenerateIRInputSchema,
  RtdbIRErrorCode,
} from '../database/ir/spec.js';
export type {
  GenerateIRInput,
  GenerateIRResult,
  GenerateIRSpec,
} from '../database/ir/spec.js';
export { GenerateIRHandler } from '../database/ir/handler.js';

export {
  SimulationInputSchema,
  SimulateErrorCode,
  SimulationResultSchema,
} from '../database/simulation/spec.js';
export type {
  SimulationInput,
  SimulationResult,
  SimulateResult,
} from '../database/simulation/spec.js';
export { SimulateHandler } from '../database/simulation/handler.js';

export { WriteRulesErrorCode } from '../database/write/spec.js';
export type {
  WriteRulesResult,
  WriteRulesSpec,
} from '../database/write/spec.js';
export { WriteRulesHandler } from '../database/write/handler.js';

export type {
  ParsedExpression,
  ParsedExpression as RtdbExpressionParseResult,
  RtdbIR,
  RtdbNode,
  RtdbRuleExpression,
  RtdbTools,
  RuleError,
  RuleLint,
  UserAuth,
} from '../database/types.js';

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
  RtdbRulesCheckResult,
  RtdbRulesDefinition,
  RtdbRulesDocument,
  RtdbRulesFinding,
  RtdbRulesFindingRule,
  RtdbRulesJson,
  RtdbRulesSimulationAuth,
  RtdbRulesSimulationInput,
  RulesetContext,
  SchemaRulesResult,
  Segment,
} from '../database/constraints/index.js';
