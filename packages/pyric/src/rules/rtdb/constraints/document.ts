import {
  serializeRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
} from '../compiled-rules.js';
import type { SimulationInput, SimulateResult } from '../simulation/spec.js';
import type { RtdbNode, RtdbRuleExpression } from '../types.js';
import { ruleset } from './ruleset.js';
import type { PathDef, RulesetContext } from './types.js';

export interface RtdbRulesDefinition {
  paths: Record<string, PathDef> | ((ctx: RulesetContext) => void);
}

export type RtdbRulesJson = { rules: Record<string, unknown> };

export type RtdbRulesFindingRule = '.read' | '.write' | '.validate' | 'ruleset';

export interface RtdbRulesFinding {
  path: string;
  rule: RtdbRulesFindingRule;
  code: string;
  message: string;
}

export interface RtdbRulesCheckResult {
  ok: boolean;
  errors: RtdbRulesFinding[];
  warnings: RtdbRulesFinding[];
}

export type RtdbRulesSimulationAuth =
  | string
  | { uid: string; token?: Record<string, unknown> }
  | null;

export type RtdbRulesSimulationInput =
  Omit<SimulationInput, 'auth' | 'mockData'> & {
    auth?: RtdbRulesSimulationAuth;
    data?: Record<string, unknown>;
    mockData?: Record<string, unknown>;
  };

declare const RTDB_RULES_DOCUMENT_BRAND: unique symbol;

/**
 * The authored RTDB rules artifact `defineRtdbRules` returns.
 *
 * Deliberately INERT on the public surface: it exposes no methods. It is a
 * value you author and hand to `rtdbRules()`, which is the one analysis
 * surface (`lint` / `simulate` / `explain` / `toJSON`). The brand is
 * type-level only; nothing exists at runtime.
 */
export interface RtdbRulesDocument {
  readonly [RTDB_RULES_DOCUMENT_BRAND]?: never;
}

/**
 * The method-bearing document interface — INTERNAL. The runtime object
 * behind {@link RtdbRulesDocument} implements this; the engine seams
 * (`pyric/rules/internal/rtdb`) and the `rtdbRules()` implementation call
 * through it. Not part of the public `pyric/rules` contract.
 */
export interface RtdbRulesDocumentInternal extends RtdbRulesDocument {
  toJSON(): RtdbRulesJson;
  compile(): CompiledRtdbRules;
  check(): RtdbRulesCheckResult;
  simulate(input: RtdbRulesSimulationInput): SimulateResult;
}

function normalizeAuth(auth: RtdbRulesSimulationAuth | undefined): SimulationInput['auth'] {
  if (auth === undefined || auth === null) return null;
  if (typeof auth === 'string') return { uid: auth, token: {} };
  return { uid: auth.uid, token: auth.token ?? {} };
}

function normalizeSimulationInput(input: RtdbRulesSimulationInput): SimulationInput {
  return {
    operation: input.operation,
    path: input.path,
    auth: normalizeAuth(input.auth),
    mockData: input.mockData ?? input.data ?? {},
    ...(input.newData !== undefined ? { newData: input.newData } : {}),
  };
}

function collectExpressionFindings(
  path: string,
  rule: Exclude<RtdbRulesFindingRule, 'ruleset'>,
  expr: RtdbRuleExpression | undefined,
  kind: 'errors' | 'warnings',
): RtdbRulesFinding[] {
  return (expr?.parsed[kind] ?? []).map((finding) => ({
    path,
    rule,
    code: finding.code,
    message: finding.message,
  }));
}

function collectFindings(node: RtdbNode, kind: 'errors' | 'warnings'): RtdbRulesFinding[] {
  const findings: RtdbRulesFinding[] = [
    ...collectExpressionFindings(node.path, '.read', node.read, kind),
    ...collectExpressionFindings(node.path, '.write', node.write, kind),
    ...collectExpressionFindings(node.path, '.validate', node.validate, kind),
  ];

  for (const child of node.children) {
    findings.push(...collectFindings(child, kind));
  }

  return findings;
}

class DefinedRtdbRulesDocument implements RtdbRulesDocumentInternal {
  constructor(private readonly definition: RtdbRulesDefinition) {}

  compile(): CompiledRtdbRules {
    return ruleset(this.definition.paths);
  }

  toJSON(): RtdbRulesJson {
    return serializeRtdbRules(this.compile());
  }

  check(): RtdbRulesCheckResult {
    try {
      const compiled = this.compile();
      const errors = collectFindings(compiled, 'errors');
      const warnings = collectFindings(compiled, 'warnings');
      return {
        ok: errors.length === 0,
        errors,
        warnings,
      };
    } catch (e) {
      return {
        ok: false,
        errors: [{
          path: '/',
          rule: 'ruleset',
          code: 'COMPILE_ERROR',
          message: e instanceof Error ? e.message : String(e),
        }],
        warnings: [],
      };
    }
  }

  simulate(input: RtdbRulesSimulationInput): SimulateResult {
    return simulateRtdbRules(this.compile(), normalizeSimulationInput(input));
  }
}

export function defineRtdbRules(definition: RtdbRulesDefinition): RtdbRulesDocument {
  // The runtime object carries the full method surface; the declared return
  // type is the inert public artifact. Route the assignment through the
  // internal interface (a declared subtype) so the brand-only weak type
  // accepts it.
  const doc: RtdbRulesDocumentInternal = new DefinedRtdbRulesDocument(definition);
  return doc;
}
