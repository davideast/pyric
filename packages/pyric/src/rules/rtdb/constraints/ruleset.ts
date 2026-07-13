import { buildRuleExpression } from '../compiled-rules.js';
import type { CompiledRtdbRules } from '../compiled-rules.js';
import { schemaRules } from './schema.js';
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

  // Sort by depth (root first)
  flattened.sort((a, b) => {
    const depthA = a[0] === '/' ? 0 : a[0].split('/').filter(Boolean).length;
    const depthB = b[0] === '/' ? 0 : b[0].split('/').filter(Boolean).length;
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
    const node = pathStr === '/' ? root : findNode(root, pathStr);
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

function applyRules(root: RtdbNode, node: RtdbNode, def: PathDef, pathStr: string): void {
  const pathVars = pathStr.split('/').filter(s => s.startsWith('$'));

  // Read/write/validate expressions
  if (def.read) node.read = buildExpr(def.read, 'read', pathVars);
  if (def.write) node.write = buildExpr(def.write, 'write', pathVars);
  if (def.validate) node.validate = buildExpr(def.validate, 'validate', pathVars);

  // Schema generates parent validate + child validate rules
  if (def.schema) {
    const sr = schemaRules(def.schema, def.fieldConstraints);
    if (!node.validate) {
      node.validate = buildExpr(sr.validate, 'validate', pathVars);
    }
    for (const [fieldName, fieldDef] of Object.entries(sr.children)) {
      const fieldPath = `${pathStr}/${fieldName}`;
      let fieldNode = node.children.find(c => c.path === fieldPath);
      if (!fieldNode) {
        fieldNode = { path: fieldPath, pathVariables: pathVars, children: [] };
        node.children.push(fieldNode);
      }
      fieldNode.validate = buildExpr(fieldDef.validate, 'validate', pathVars);

      // Nested object schema children
      if ('children' in fieldDef && fieldDef.children) {
        for (const [nestedName, nestedDef] of Object.entries(fieldDef.children as Record<string, { validate: Expr }>)) {
          const nestedPath = `${fieldPath}/${nestedName}`;
          let nestedNode = fieldNode.children.find(c => c.path === nestedPath);
          if (!nestedNode) {
            nestedNode = { path: nestedPath, pathVariables: pathVars, children: [] };
            fieldNode.children.push(nestedNode);
          }
          nestedNode.validate = buildExpr(nestedDef.validate, 'validate', pathVars);
        }
      }
    }
  }

  // indexOn goes on the container (parent of wildcard), not the wildcard itself
  if (def.indexOn) {
    const segments = pathStr.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    if (lastSegment?.startsWith('$')) {
      const parentPath = '/' + segments.slice(0, -1).join('/');
      const parent = findNode(root, parentPath);
      if (parent) parent.indexOn = def.indexOn;
    }
  }
}

// ---- Helpers ----

/** Flatten nested children into absolute path entries. */
function flattenChildren(defs: Array<[string, PathDef]>): Array<[string, PathDef]> {
  const result: Array<[string, PathDef]> = [];
  for (const [pathStr, def] of defs) {
    // Add this path without the children property
    const { children, ...rest } = def;
    result.push([pathStr, rest as PathDef]);

    // Recursively flatten children
    if (children) {
      const childEntries = Object.entries(children).map(
        ([childPath, childDef]) => [pathStr + childPath, childDef] as [string, PathDef],
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
