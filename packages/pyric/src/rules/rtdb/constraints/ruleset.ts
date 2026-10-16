import { buildRuleExpression } from '../compiled-rules.js';
import type { CompiledRtdbRules } from '../compiled-rules.js';
import { all, expr } from './compose.js';
import { schemaRules, type SchemaFieldRule } from './schema.js';
import type { Expr, PathDef, RulesetContext } from './types.js';
import type { RtdbNode, RtdbRuleExpression } from '../types.js';

/** Compile a declarative rules definition into an environment-independent tree. */
export function ruleset(
  input: Record<string, PathDef> | ((ctx: RulesetContext) => void),
): CompiledRtdbRules {
  let pathDefs: Array<[string, PathDef]>;

  if (typeof input === 'function') {
    const collected: Array<[string, PathDef]> = [];
    input({ path: (p, def) => collected.push([p, def]) });
    pathDefs = collected;
  } else {
    pathDefs = Object.entries(input);
  }

  // Flatten nested children into top-level path defs
  const flattened = flattenChildren(pathDefs);
  assertUniquePaths(flattened);

  // Sort by depth (root first)
  flattened.sort((a, b) => {
    const depthA = pathDepth(a[0]);
    const depthB = pathDepth(b[0]);
    return depthA - depthB || a[0].localeCompare(b[0]);
  });

  // Pass 1: Build the path tree (nodes only, no rules)
  const root: RtdbNode = { path: '/', pathVariables: [], children: [] };
  for (const [pathStr] of flattened) {
    if (pathStr === '/') continue;
    ensurePath(root, pathStr);
  }

  // Pass 2: Apply rules, schemas, and indexOn to each node
  for (const [pathStr, def] of flattened) {
    const node = findNode(root, pathStr);
    if (!node) continue;
    applyRules(root, node, def, pathStr);
  }

  return root;
}

// ---- Pass 1: Tree construction ----

function ensurePath(root: RtdbNode, pathStr: string): void {
  const segments = pathStr.split('/').filter(Boolean);
  let current = root;

  for (let i = 0; i < segments.length; i++) {
    const partialPath = '/' + segments.slice(0, i + 1).join('/');
    const varsUpToHere = segments.slice(0, i + 1).filter(s => s.startsWith('$'));

    let child = current.children.find(c => c.path === partialPath);
    if (!child) {
      child = { path: partialPath, pathVariables: varsUpToHere, children: [] };
      current.children.push(child);
    }
    current = child;
  }
}

// ---- Pass 2: Rule application ----

function mergeValidate(node: RtdbNode, nextExpr: Expr, pathVars: string[]): void {
  const combined = node.validate ? all(expr(node.validate.raw), nextExpr) : nextExpr;
  node.validate = buildExpr(combined, 'validate', pathVars);
}

function applySchemaChildren(
  parentNode: RtdbNode,
  children: Record<string, SchemaFieldRule>,
  basePathVars: string[],
): void {
  for (const [fieldName, fieldDef] of Object.entries(children)) {
    const fieldPath = normalizeRulePath(`${parentNode.path}/${fieldName}`);
    const childVars = fieldName.startsWith('$') ? [...basePathVars, fieldName] : basePathVars;
    let fieldNode = parentNode.children.find(c => c.path === fieldPath);
    if (!fieldNode) {
      fieldNode = { path: fieldPath, pathVariables: childVars, children: [] };
      parentNode.children.push(fieldNode);
    }
    mergeValidate(fieldNode, fieldDef.validate, childVars);
    if (fieldDef.children) {
      applySchemaChildren(fieldNode, fieldDef.children, childVars);
    }
  }
}

function applyRules(root: RtdbNode, node: RtdbNode, def: PathDef, pathStr: string): void {
  const segments = pathStr.split('/').filter(Boolean);
  const pathVars = segments.filter(s => s.startsWith('$'));

  if (def.fieldConstraints && !def.schema) {
    throw new Error(`fieldConstraints on "${pathStr}" requires a schema.`);
  }

  // Read/write/validate expressions
  if (def.read) node.read = buildExpr(def.read, 'read', pathVars);
  if (def.write) node.write = buildExpr(def.write, 'write', pathVars);
  if (def.validate) mergeValidate(node, def.validate, pathVars);

  // Schema generates parent validate + child validate rules
  if (def.schema) {
    const sr = schemaRules(def.schema, def.fieldConstraints);
    mergeValidate(node, sr.validate, pathVars);
    applySchemaChildren(node, sr.children, pathVars);
  }

  // indexOn goes on the container node directly, or lifts to the parent of a $wildcard path
  if (def.indexOn) {
    const target = resolveIndexOnTarget(root, node, segments);
    if (target) {
      if (!target.indexOn) {
        target.indexOn = [...def.indexOn];
      } else if (!hasSameIndexOnFields(target.indexOn, def.indexOn)) {
        throw new Error(
          `Conflicting indexOn declarations for "${target.path}": ${JSON.stringify(target.indexOn)} vs ${JSON.stringify(def.indexOn)}`,
        );
      }
    }
  }
}

// ---- Helpers ----

function resolveIndexOnTarget(root: RtdbNode, node: RtdbNode, segments: string[]): RtdbNode | null {
  const lastSegment = segments[segments.length - 1];
  if (lastSegment?.startsWith('$')) {
    const parentPath = '/' + segments.slice(0, -1).join('/');
    return findNode(root, parentPath);
  }
  return node;
}

function hasSameIndexOnFields(existing: string[], declared: string[]): boolean {
  return existing.length === declared.length && existing.every((field, i) => field === declared[i]);
}

function normalizeRulePath(pathStr: string): string {
  return '/' + pathStr.split('/').filter(Boolean).join('/');
}

function pathDepth(pathStr: string): number {
  return pathStr.split('/').filter(Boolean).length;
}

function assertUniquePaths(defs: Array<[string, PathDef]>): void {
  const seen = new Set<string>();
  for (const [normalizedPath] of defs) {
    if (seen.has(normalizedPath)) {
      throw new Error(`Duplicate ruleset path declaration for "${normalizedPath}"`);
    }
    seen.add(normalizedPath);
  }
}

/** Flatten nested children into absolute path entries. */
function flattenChildren(defs: Array<[string, PathDef]>): Array<[string, PathDef]> {
  const result: Array<[string, PathDef]> = [];
  for (const [pathStr, def] of defs) {
    const normalizedPath = normalizeRulePath(pathStr);
    // Add this path without the children property
    const { children, ...rest } = def;
    result.push([normalizedPath, rest as PathDef]);

    // Recursively flatten children
    if (children) {
      const childEntries = Object.entries(children).map(
        ([childPath, childDef]) => [`${normalizedPath}/${childPath}`, childDef] as [string, PathDef],
      );
      result.push(...flattenChildren(childEntries));
    }
  }
  return result;
}

function buildExpr(raw: Expr, context: 'read' | 'write' | 'validate', pathVariables: string[]): RtdbRuleExpression {
  return buildRuleExpression(String(raw), context, pathVariables);
}

function findNode(root: RtdbNode, path: string): RtdbNode | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}
