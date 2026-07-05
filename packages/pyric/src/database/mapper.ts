import { parseExpression } from './grammar/RtdbExprParser.js';
import { validateExpression } from './grammar/validator.js';
import { lintExpression } from './grammar/linter.js';
import type { RtdbIR, RtdbNode, RtdbRuleExpression } from './types.js';

const SYSTEM_KEYS = new Set(['.read', '.write', '.validate', '.indexOn']);

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

function traverseNode(
  rulesObj: Record<string, unknown>,
  path: string,
  pathVariables: string[],
  shallowData: Record<string, true | 1> | null,
): RtdbNode {
  const read = rulesObj['.read'];
  const write = rulesObj['.write'];
  const validate = rulesObj['.validate'];
  const indexOn = rulesObj['.indexOn'];

  const topSegment = path.split('/').filter(Boolean)[0] ?? '';
  const exists = topSegment !== '' && shallowData != null
    ? topSegment in shallowData
    : false;

  const node: RtdbNode = {
    path,
    pathVariables: [...pathVariables],
    exists,
    children: [],
  };

  if (read !== undefined) {
    const raw = typeof read === 'boolean' ? String(read) : String(read);
    node.read = buildRuleExpression(raw, 'read', pathVariables);
  }

  if (write !== undefined) {
    const raw = typeof write === 'boolean' ? String(write) : String(write);
    node.write = buildRuleExpression(raw, 'write', pathVariables);
  }

  if (validate !== undefined) {
    const raw = typeof validate === 'boolean' ? String(validate) : String(validate);
    node.validate = buildRuleExpression(raw, 'validate', pathVariables);
  }

  if (indexOn !== undefined) {
    node.indexOn = Array.isArray(indexOn)
      ? indexOn.map(String)
      : [String(indexOn)];
  }

  for (const key of Object.keys(rulesObj)) {
    if (SYSTEM_KEYS.has(key)) continue;
    const child = rulesObj[key];
    if (typeof child !== 'object' || child === null) continue;

    const childPath = path === '/' ? `/${key}` : `${path}/${key}`;
    const childPathVars = key.startsWith('$')
      ? [...pathVariables, key]
      : [...pathVariables];

    node.children.push(
      traverseNode(child as Record<string, unknown>, childPath, childPathVars, shallowData),
    );
  }

  return node;
}

function rawToRuleValue(raw: string): string | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function nodeToJson(node: RtdbNode): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (node.read) result['.read'] = rawToRuleValue(node.read.raw);
  if (node.write) result['.write'] = rawToRuleValue(node.write.raw);
  if (node.validate) result['.validate'] = rawToRuleValue(node.validate.raw);
  if (node.indexOn) result['.indexOn'] = node.indexOn;

  for (const child of node.children) {
    const segments = child.path.split('/').filter(Boolean);
    const segment = segments[segments.length - 1];
    result[segment] = nodeToJson(child);
  }

  return result;
}

export class RtdbMapper {
  static mapToRulesJSON(ir: RtdbIR): { rules: Record<string, unknown> } {
    if (!ir.rules || typeof ir.rules !== 'object' || !('path' in ir.rules)) {
      throw new Error("Invalid rules IR: 'rules' field must be a valid RtdbNode object with a 'path' property");
    }
    return { rules: nodeToJson(ir.rules as RtdbNode) };
  }

  static mapToIR(
    rulesJson: unknown,
    shallowData: Record<string, true | 1> | null,
    databaseUrl: string,
  ): RtdbIR {
    if (!rulesJson || typeof rulesJson !== 'object') {
      throw new Error('Invalid rules JSON: expected an object');
    }

    const obj = rulesJson as Record<string, unknown>;
    if (!('rules' in obj)) {
      throw new Error('Invalid rules JSON: missing top-level "rules" key');
    }

    const rules = obj.rules as Record<string, unknown>;
    if (typeof rules !== 'object' || rules === null) {
      throw new Error('Invalid rules JSON: "rules" must be an object');
    }

    const rootNode = traverseNode(rules, '/', [], shallowData);

    return {
      service: 'realtime-database',
      databaseUrl,
      rules: rootNode,
    };
  }
}
