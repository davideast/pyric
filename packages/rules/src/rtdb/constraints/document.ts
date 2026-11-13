import {
  serializeRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
} from '../compiled-rules.js';
import type { SimulationInput, SimulateResult } from '../simulation/spec.js';
import { structuralFindings } from '../structure.js';
import type { RtdbNode, RtdbRuleExpression } from '../types.js';
import { assertKnownPathKeys, ruleset } from './ruleset.js';
import type { PathDef, RulesetContext } from './types.js';
import { safeErrorMessage } from '../../test/case-refusals.js';

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
  | { uid: string; tenant?: string; token?: Record<string, unknown> }
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

export function normalizeAuth(auth: RtdbRulesSimulationAuth | undefined): SimulationInput['auth'] {
  if (auth === undefined || auth === null) return null;
  if (typeof auth === 'string') return { uid: auth, token: {} };
  const normalized: NonNullable<SimulationInput['auth']> = {
    uid: auth.uid,
    token: auth.token ?? {},
  };
  if (auth.tenant !== undefined) normalized.tenant = auth.tenant;
  return normalized;
}

function isRulesServerTimestamp(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__type === 'serverTimestamp'
  );
}

function normalizeSimulationValue(value: unknown): unknown {
  if (isRulesServerTimestamp(value)) return { '.sv': 'timestamp' };
  if (Array.isArray(value)) return value.map(normalizeSimulationValue);
  if (typeof value === 'object' && value !== null) {
    const normalized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // Defined, not assigned, so an own `__proto__` key is kept (#1247 CS-1).
      Object.defineProperty(normalized, key, {
        value: normalizeSimulationValue(child), enumerable: true, writable: true, configurable: true,
      });
    }
    return normalized;
  }
  return value;
}

export function normalizeSimulationInput(input: RtdbRulesSimulationInput): SimulationInput {
  const simulation: SimulationInput = {
    operation: input.operation,
    path: input.path,
    auth: normalizeAuth(input.auth),
    mockData: input.mockData ?? input.data ?? {},
  };
  if (input.newData !== undefined) simulation.newData = normalizeSimulationValue(input.newData);
  if (input.now !== undefined) simulation.now = input.now;
  if (input.updates !== undefined) {
    simulation.updates = input.updates.map((u) => ({
      path: u.path,
      value: normalizeSimulationValue(u.value),
    }));
  }
  if (input.query !== undefined) simulation.query = input.query;
  return simulation;
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
    // A shape problem whose deploy rejection was captured is an error; one
    // inferred from a captured rejection's text is a warning.
    ...(node.structure ?? [])
      .filter((finding) => finding.severity === (kind === 'errors' ? 'error' : 'warning'))
      .map((finding): RtdbRulesFinding => ({
        path: finding.path,
        rule: 'ruleset',
        code: finding.code,
        message: finding.message,
      })),
  ];

  for (const child of node.children) {
    findings.push(...collectFindings(child, kind));
  }

  return findings;
}

/**
 * The findings a compiled ruleset carries: every parse, validation, and lint
 * finding on its `.read`, `.write`, and `.validate` expressions. A ruleset
 * that does not compile is one COMPILE_ERROR at the root.
 */
export function checkRtdbRules(compile: () => CompiledRtdbRules): RtdbRulesCheckResult {
  let compiled: CompiledRtdbRules;
  try {
    compiled = compile();
  } catch (e) {
    return {
      ok: false,
      errors: [{
        path: '/',
        rule: 'ruleset',
        code: 'COMPILE_ERROR',
        message: safeErrorMessage(e),
      }],
      warnings: [],
    };
  }
  const errors = collectFindings(compiled, 'errors');
  const warnings = collectFindings(compiled, 'warnings');
  return { ok: errors.length === 0, errors, warnings };
}

function attachStructuralFindings(node: RtdbNode): CompiledRtdbRules {
  const rulesObj: Record<string, unknown> = {};
  if (node.read) rulesObj['.read'] = node.read.raw;
  if (node.write) rulesObj['.write'] = node.write.raw;
  if (node.validate) rulesObj['.validate'] = node.validate.raw;
  if (node.indexOn) rulesObj['.indexOn'] = node.indexOn;
  for (const child of node.children) {
    const segment = child.path.slice(child.path.lastIndexOf('/') + 1);
    rulesObj[segment] = {};
    attachStructuralFindings(child);
  }
  const structure = structuralFindings(node.path, rulesObj);
  if (structure.length > 0) node.structure = structure;
  return node;
}

function clonePathDef(def: PathDef): PathDef {
  if (typeof def !== 'object' || def === null || Array.isArray(def)) return def;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(def as Record<string, unknown>)) {
    let cloned: unknown = value;
    if (key === 'indexOn' && Array.isArray(value)) {
      cloned = [...value];
    } else if (key === 'fieldConstraints' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const constraintsCopy: Record<string, unknown> = {};
      for (const [fieldKey, exprs] of Object.entries(value as Record<string, unknown>)) {
        Object.defineProperty(constraintsCopy, fieldKey, {
          value: Array.isArray(exprs) ? [...exprs] : exprs,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      cloned = constraintsCopy;
    } else if (key === 'children' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      cloned = clonePathsMap(value as Record<string, PathDef>);
    }
    Object.defineProperty(copy, key, {
      value: cloned,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy as PathDef;
}

function clonePathsMap(paths: Record<string, PathDef>): Record<string, PathDef> {
  const copy: Record<string, PathDef> = {};
  for (const [pathKey, def] of Object.entries(paths)) {
    Object.defineProperty(copy, pathKey, {
      value: clonePathDef(def),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function cloneDefinition(definition: RtdbRulesDefinition): RtdbRulesDefinition {
  if (typeof definition !== 'object' || definition === null) {
    return definition;
  }
  if (typeof definition.paths === 'function') {
    const snapshot: Array<[string, PathDef]> = [];
    try {
      definition.paths({
        path(p, def) {
          snapshot.push([p, clonePathDef(def)]);
        },
      });
    } catch (err) {
      return {
        ...definition,
        paths() {
          throw err;
        },
      };
    }
    return {
      ...definition,
      paths(ctx) {
        for (const [p, def] of snapshot) {
          ctx.path(p, clonePathDef(def));
        }
      },
    };
  }
  if (
    typeof definition.paths !== 'object' ||
    definition.paths === null ||
    Array.isArray(definition.paths)
  ) {
    return definition;
  }
  return { ...definition, paths: clonePathsMap(definition.paths) };
}

class DefinedRtdbRulesDocument implements RtdbRulesDocumentInternal {
  private readonly definition: RtdbRulesDefinition;
  private compiled: CompiledRtdbRules | undefined;

  constructor(definition: RtdbRulesDefinition) {
    this.definition = cloneDefinition(definition);
  }

  /** Compiles the definition on first use; lint, simulate, and toJSON share the tree. */
  compile(): CompiledRtdbRules {
    this.compiled ??= attachStructuralFindings(ruleset(this.definition.paths));
    return this.compiled;
  }

  toJSON(): RtdbRulesJson {
    return serializeRtdbRules(this.compile());
  }

  check(): RtdbRulesCheckResult {
    return checkRtdbRules(() => this.compile());
  }

  simulate(input: RtdbRulesSimulationInput): SimulateResult {
    return simulateRtdbRules(this.compile(), normalizeSimulationInput(input));
  }
}

export function defineRtdbRules(definition: RtdbRulesDefinition): RtdbRulesDocument {
  if (typeof definition.paths === 'object' && definition.paths !== null) assertKnownPathKeys(definition.paths);
  // The runtime object carries the full method surface; the declared return
  // type is the inert public artifact. Route the assignment through the
  // internal interface (a declared subtype) so the brand-only weak type
  // accepts it.
  const doc: RtdbRulesDocumentInternal = new DefinedRtdbRulesDocument(definition);
  return doc;
}
