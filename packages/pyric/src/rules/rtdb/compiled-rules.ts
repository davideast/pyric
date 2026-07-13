import { parseExpression } from './grammar/RtdbExprParser.js';
import { lintExpression } from './grammar/linter.js';
import { validateExpression } from './grammar/validator.js';
import { SimulateHandler } from './simulation/handler.js';
import type { SimulationInput, SimulateResult } from './simulation/spec.js';
import type { RtdbNode, RtdbRuleExpression } from './types.js';

const SYSTEM_KEYS = new Set(['.read', '.write', '.validate', '.indexOn']);

/** The environment-independent tree produced from an RTDB rules document. */
export type CompiledRtdbRules = RtdbNode;

export function buildRuleExpression(
  raw: string,
  context: 'read' | 'write' | 'validate',
  pathVariables: string[] = [],
): RtdbRuleExpression {
  const parsed = parseExpression(raw);
  const errors = parsed.valid ? validateExpression(raw, context, pathVariables) : parsed.errors;
  const warnings = parsed.valid ? lintExpression(raw, context) : [];

  return {
    raw,
    parsed: {
      ...parsed,
      errors,
      warnings,
    },
  };
}

function compileNode(
  rulesObj: Record<string, unknown>,
  path: string,
  pathVariables: string[],
): RtdbNode {
  const node: RtdbNode = {
    path,
    pathVariables: [...pathVariables],
    children: [],
  };

  for (const [key, context] of [
    ['.read', 'read'],
    ['.write', 'write'],
    ['.validate', 'validate'],
  ] as const) {
    const value = rulesObj[key];
    if (value !== undefined) {
      node[context] = buildRuleExpression(String(value), context, pathVariables);
    }
  }

  const indexOn = rulesObj['.indexOn'];
  if (indexOn !== undefined) {
    node.indexOn = Array.isArray(indexOn) ? indexOn.map(String) : [String(indexOn)];
  }

  for (const [key, child] of Object.entries(rulesObj)) {
    if (SYSTEM_KEYS.has(key) || typeof child !== 'object' || child === null) continue;
    const childPath = path === '/' ? `/${key}` : `${path}/${key}`;
    const childPathVariables = key.startsWith('$')
      ? [...pathVariables, key]
      : [...pathVariables];
    node.children.push(
      compileNode(child as Record<string, unknown>, childPath, childPathVariables),
    );
  }

  return node;
}

export function compileRtdbRules(rulesJson: unknown): CompiledRtdbRules {
  if (!rulesJson || typeof rulesJson !== 'object') {
    throw new Error('Invalid rules JSON: expected an object');
  }
  const document = rulesJson as Record<string, unknown>;
  if (!('rules' in document)) {
    throw new Error('Invalid rules JSON: missing top-level "rules" key');
  }
  if (typeof document.rules !== 'object' || document.rules === null) {
    throw new Error('Invalid rules JSON: "rules" must be an object');
  }
  return compileNode(document.rules as Record<string, unknown>, '/', []);
}

function rawToRuleValue(raw: string): string | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function serializeNode(node: RtdbNode): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (node.read) result['.read'] = rawToRuleValue(node.read.raw);
  if (node.write) result['.write'] = rawToRuleValue(node.write.raw);
  if (node.validate) result['.validate'] = rawToRuleValue(node.validate.raw);
  if (node.indexOn) result['.indexOn'] = node.indexOn;

  for (const child of node.children) {
    const segments = child.path.split('/').filter(Boolean);
    result[segments[segments.length - 1]] = serializeNode(child);
  }
  return result;
}

export function serializeRtdbRules(
  compiled: CompiledRtdbRules,
): { rules: Record<string, unknown> } {
  if (!compiled || typeof compiled !== 'object' || !('path' in compiled)) {
    throw new Error("Invalid compiled rules: expected a rules node with a 'path' property");
  }
  return { rules: serializeNode(compiled) };
}

export function simulateRtdbRules(
  compiled: CompiledRtdbRules,
  input: SimulationInput,
): SimulateResult {
  return new SimulateHandler().execute(compiled, input);
}
