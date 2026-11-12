/**
 * Locating the `.indexOn` declarations that serve a query. The sandbox's
 * unindexed-query check and RTDB rule coverage share this lookup, so both name
 * the same nodes for the same query.
 */
import type { RtdbNode } from './types.js';

/**
 * Every rule node that applies at `segments`: at each segment, the literal
 * child that names it, else the `$wildcard` children when no literal sibling
 * matches.
 */
export function findMatchingNodesAtPath(root: RtdbNode, segments: string[]): RtdbNode[] {
  let currentNodes: RtdbNode[] = [root];
  for (const seg of segments) {
    const nextNodes: RtdbNode[] = [];
    for (const node of currentNodes) {
      const literalChildren: RtdbNode[] = [];
      const wildcardChildren: RtdbNode[] = [];
      for (const child of node.children) {
        const childSegs = child.path.split('/').filter(Boolean);
        const lastSeg = childSegs[childSegs.length - 1];
        if (!lastSeg) continue;
        if (lastSeg === seg) {
          literalChildren.push(child);
        } else if (lastSeg.startsWith('$')) {
          wildcardChildren.push(child);
        }
      }
      nextNodes.push(...(literalChildren.length > 0 ? literalChildren : wildcardChildren));
    }
    currentNodes = nextNodes;
    if (currentNodes.length === 0) break;
  }
  return currentNodes;
}

/** The nodes at `segments` whose `.indexOn` declares `requiredIndex`. */
export function nodesDeclaringIndex(
  root: RtdbNode,
  segments: string[],
  requiredIndex: string,
): RtdbNode[] {
  return findMatchingNodesAtPath(root, segments).filter((node) =>
    node.indexOn?.some(
      (idx) => idx === requiredIndex || idx.split('/').filter(Boolean).join('/') === requiredIndex,
    ),
  );
}
