import type { Denial, ExprTraceEntry } from '../types.js';
import { decidingEvaluation, type ScopeVar } from './format.js';

/**
 * Leaf keys the rule read off each scope root, discovered from the
 * deciding rule's expression trace. We scan every trace node's `source`
 * for accessors rooted at one of the three scope roots and record the
 * first segment after the root (e.g. `request.auth.uid` → root
 * `request.auth`, hit `uid`). These drive the `data-pyric-scope-hit`
 * underline so the user sees exactly which fields the rule compared.
 */
const SCOPE_ROOTS: { root: string; key: keyof Denial | 'auth' }[] = [
  { root: 'request.resource.data', key: 'requestData' },
  { root: 'resource.data', key: 'resourceData' },
  { root: 'request.auth', key: 'auth' },
];

function collectHits(entries: ExprTraceEntry[]): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  for (const entry of entries) {
    const src = entry.source;
    // Longest root first so `request.resource.data` wins over a bare
    // `request` prefix.
    for (const { root } of SCOPE_ROOTS) {
      if (src === root || src.startsWith(root + '.')) {
        const rest = src.slice(root.length).replace(/^\./, '');
        const leaf = rest.split(/[.[]/)[0];
        if (leaf) {
          if (!hits.has(root)) hits.set(root, new Set());
          hits.get(root)!.add(leaf);
        }
        break;
      }
    }
  }
  return hits;
}

/**
 * Build the "data in scope" rows for a denial: `request.auth`,
 * `request.resource.data`, and `resource.data` — each present only when
 * the denial carries that payload. `hits` marks the leaf keys the
 * deciding rule actually read.
 */
export function scopeVars(denial: Denial): ScopeVar[] {
  const deciding = decidingEvaluation(denial.evaluation);
  const hits = deciding?.expressionTrace ? collectHits(deciding.expressionTrace) : new Map();

  const rows: ScopeVar[] = [];
  if (denial.auth !== null) {
    rows.push({
      name: 'request.auth',
      tag: 'who made the request',
      value: denial.auth,
      hits: [...(hits.get('request.auth') ?? [])],
    });
  }
  if (denial.requestData !== undefined) {
    rows.push({
      name: 'request.resource.data',
      tag: 'what was written',
      value: denial.requestData,
      hits: [...(hits.get('request.resource.data') ?? [])],
    });
  }
  if (denial.resourceData != null) {
    rows.push({
      name: 'resource.data',
      tag: 'the existing document',
      value: denial.resourceData,
      hits: [...(hits.get('resource.data') ?? [])],
    });
  }
  return rows;
}
