/**
 * Rule-based owner inference: reads an app's rules, collects conditions tied
 * to `auth.uid`, and cross-checks them against extracted client access sites.
 */
import type { EmbeddedRules } from '../code/embedded-rules.js';
import type { AccessSite } from '../code/types.js';
import { inferOwnerBindings } from './cross-check.js';
import { firestoreOwnerConditions } from './firestore-owners.js';
import { rtdbOwnerConditions } from './rtdb-owners.js';
import { loadRuleSources, type RuleSources } from './rule-sources.js';
import type { OwnerBinding, OwnerCondition } from './types.js';

export interface OwnerAnalysis {
  ownerBindings: OwnerBinding[];
  conditions: OwnerCondition[];
  /** Rule sources read, `file` or `file:line` for rules found in code. */
  ruleSources: { service: 'firestore' | 'rtdb'; source: string }[];
  /** The rules themselves, for probes. */
  sources: RuleSources;
  problems: string[];
}

/** Add rules found in code to file-based sources (code rules count only when no file was found for that service). */
export function withEmbeddedRules(sources: RuleSources, embedded: EmbeddedRules[]): RuleSources {
  const out: RuleSources = {
    firestore: [...sources.firestore],
    rtdb: [...sources.rtdb],
    problems: [...sources.problems],
  };
  for (const entry of embedded) {
    if (entry.service === 'firestore' && typeof entry.rules === 'string' && sources.firestore.length === 0) {
      out.firestore.push({ source: entry.source, text: entry.rules });
    }
    if (entry.service === 'rtdb' && typeof entry.rules === 'object' && sources.rtdb.length === 0) {
      out.rtdb.push({ source: entry.source, json: entry.rules });
    }
  }
  return out;
}

/** Owner conditions from every rule source. */
export function ownerConditionsFrom(sources: RuleSources): OwnerCondition[] {
  return [
    ...sources.firestore.flatMap((source) => firestoreOwnerConditions(source.text, source.source)),
    ...sources.rtdb.flatMap((source) => rtdbOwnerConditions(source.json, source.source)),
  ];
}

/** Full owner analysis for an app root and its access sites. */
export function analyzeOwners(
  root: string,
  accessSites: AccessSite[],
  embedded: EmbeddedRules[],
  explicit: { firestore?: string[]; rtdb?: string[] } = {},
): OwnerAnalysis {
  const hasExplicit = (explicit.firestore?.length ?? 0) > 0 || (explicit.rtdb?.length ?? 0) > 0;
  const loaded = loadRuleSources(root, explicit);
  let sources = loaded;
  if (!hasExplicit) {
    sources = withEmbeddedRules(loaded, embedded);
  }
  const conditions = ownerConditionsFrom(sources);
  return {
    ownerBindings: inferOwnerBindings(conditions, accessSites),
    conditions,
    ruleSources: [
      ...sources.firestore.map((source) => ({ service: 'firestore' as const, source: source.source })),
      ...sources.rtdb.map((source) => ({ service: 'rtdb' as const, source: source.source })),
    ],
    sources,
    problems: sources.problems,
  };
}
