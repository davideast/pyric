import { RtdbMapper } from '../mapper.js';
import { SimulateHandler } from '../simulation/handler.js';
import type { SimulationInput, SimulateResult } from '../simulation/spec.js';
import type { RtdbIR, RtdbNode, RtdbRuleExpression } from '../types.js';
import { ruleset } from './ruleset.js';
import type { PathDef, RulesetContext } from './types.js';

const LOCAL_DATABASE_URL = 'https://local-rtdb.firebaseio.com';

export interface RtdbRulesDefinition {
  databaseUrl?: string;
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
  ir?: RtdbIR;
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

export interface RtdbRulesDocument {
  toJSON(): RtdbRulesJson;
  toIR(databaseUrl?: string): RtdbIR;
  check(databaseUrl?: string): RtdbRulesCheckResult;
  simulate(
    input: RtdbRulesSimulationInput,
    opts?: { databaseUrl?: string },
  ): SimulateResult;
}

function resolveDatabaseUrl(definition: RtdbRulesDefinition, databaseUrl?: string): string {
  return databaseUrl ?? definition.databaseUrl ?? LOCAL_DATABASE_URL;
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

class DefinedRtdbRulesDocument implements RtdbRulesDocument {
  constructor(private readonly definition: RtdbRulesDefinition) {}

  toIR(databaseUrl?: string): RtdbIR {
    return ruleset(resolveDatabaseUrl(this.definition, databaseUrl), this.definition.paths);
  }

  toJSON(): RtdbRulesJson {
    return RtdbMapper.mapToRulesJSON(this.toIR());
  }

  check(databaseUrl?: string): RtdbRulesCheckResult {
    try {
      const ir = this.toIR(databaseUrl);
      const errors = collectFindings(ir.rules as RtdbNode, 'errors');
      const warnings = collectFindings(ir.rules as RtdbNode, 'warnings');
      return {
        ok: errors.length === 0,
        errors,
        warnings,
        ir,
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

  simulate(
    input: RtdbRulesSimulationInput,
    opts: { databaseUrl?: string } = {},
  ): SimulateResult {
    return new SimulateHandler().execute(
      this.toIR(opts.databaseUrl),
      normalizeSimulationInput(input),
    );
  }
}

export function defineRtdbRules(definition: RtdbRulesDefinition): RtdbRulesDocument {
  return new DefinedRtdbRulesDocument(definition);
}
