import { joinPath, pathSegments } from './data-tree.js';

const ROOT_IDENTIFIER_PATTERN = /\broot\b/;
const NOW_IDENTIFIER_PATTERN = /\bnow\b/;
const DATA_IDENTIFIER_PATTERN = /\bdata\b/;
const PARENT_IDENTIFIER_PATTERN = /\bparent\b/;

function pathsTouch(left: string, right: string): boolean {
  if (left === right || left === '/' || right === '/') return true;
  return right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}

function isRuleObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextRuleNode(node: Record<string, unknown>, segment: string): Record<string, unknown> | undefined {
  if (!segment.startsWith('.') && Object.hasOwn(node, segment) && isRuleObject(node[segment])) {
    return node[segment];
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$') && isRuleObject(child)) return child;
  }
  return undefined;
}

function readRuleDependsOnWrite(rawRule: unknown, ancestorPath: string, changedPaths: readonly string[]): boolean {
  if (typeof rawRule !== 'string') return false;
  if (ROOT_IDENTIFIER_PATTERN.test(rawRule) || NOW_IDENTIFIER_PATTERN.test(rawRule)) return true;
  if (!DATA_IDENTIFIER_PATTERN.test(rawRule)) return false;
  if (PARENT_IDENTIFIER_PATTERN.test(rawRule) || rawRule.includes('[')) return true;
  return changedPaths.some((changedPath) => pathsTouch(ancestorPath, changedPath));
}

/** Whether any `.read` rule along `listenerPath` can change its outcome after writes at `changedPaths`. */
export function listenerReadDependsOnPaths(
  rulesRoot: Record<string, unknown>,
  listenerPath: string,
  changedPaths: readonly string[],
): boolean {
  const segments = pathSegments(listenerPath);
  let current: Record<string, unknown> | undefined = rulesRoot;
  for (let depth = 0; depth <= segments.length && current !== undefined; depth++) {
    const ancestorPath = joinPath(segments.slice(0, depth));
    if (readRuleDependsOnWrite(current['.read'], ancestorPath, changedPaths)) return true;
    const segment = segments[depth];
    if (segment !== undefined) {
      current = nextRuleNode(current, segment);
    }
  }
  return false;
}
