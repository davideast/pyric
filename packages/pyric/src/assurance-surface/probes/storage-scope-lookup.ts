/**
 * Cross-service Firestore membership discovery and live tenant-scope probing
 * helpers for Cloud Storage assurance probes.
 */
import type { AccessSite } from '../code/types.js';
import {
  parseResourcePattern,
  renderResourcePattern,
  unifyPatterns,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type {
  CrossServiceLookup,
  RuleSurface,
  RuleSurfaceEntry,
} from '../rules/rule-surface.js';
import type { OwnerCondition } from '../rules/types.js';
import { fillTemplate } from './fixtures.js';
import { effectiveFirestoreDocs } from './state.js';
import type { ProbeActor } from './types.js';
import type { WorldState } from './world.js';

const MEMBERSHIP_SUBCOLLECTION_RE = /^(?:members|collaborators|participants|users|admins|editors|owners|acl|roster)$/i;

function setOwnScopeVar(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function lookupUsesCallerIdentity(lookup: CrossServiceLookup): boolean {
  if (lookup.expectedAuth === 'uid' || lookup.expectedAuth === 'uid-list') return true;
  return lookup.pattern.segments.some((s) => s.kind === 'var' && s.name === 'auth.uid');
}

export function dedupeLookups(lookups: readonly CrossServiceLookup[]): CrossServiceLookup[] {
  const seen = new Set<string>();
  const out: CrossServiceLookup[] = [];
  for (const item of lookups) {
    const key = `${item.kind}|${item.pattern.resourceId}:${renderResourcePattern(item.pattern)}|${item.field ?? ''}|${String(item.expectedValue ?? '')}|${item.expectedAuth ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function discoverScopeMembershipLookups(
  site: AccessSite,
  sitePattern: ResourcePattern,
  matchingEntries: readonly RuleSurfaceEntry[],
  allPathEntries: readonly RuleSurfaceEntry[],
  surface: RuleSurface | undefined,
  conditions: readonly OwnerCondition[],
  state: WorldState | undefined,
  owner: ProbeActor,
): {
  directLookups: CrossServiceLookup[];
  membershipLookups: CrossServiceLookup[];
  primaryRulePattern?: ResourcePattern;
} {
  const directLookups = dedupeLookups(matchingEntries.flatMap((e) => e.crossServiceReads));
  const discovered: CrossServiceLookup[] = allPathEntries
    .flatMap((e) => e.crossServiceReads)
    .filter(lookupUsesCallerIdentity);

  const uidVarNames = new Set(
    (site.pathVariables ?? [])
      .filter((v) => v.auth?.some((a) => a.source === 'auth.uid'))
      .map((v) => v.name),
  );
  const seg0 = sitePattern.segments[0];
  const seg1 = sitePattern.segments[1];

  if (seg0?.kind === 'lit' && seg1?.kind === 'var' && !uidVarNames.has(seg1.name) && seg1.name !== 'auth.uid') {
    const scopeCollection = seg0.text;
    const scopeVar = seg1.name;

    for (const entry of surface?.entries ?? []) {
      const eSeg0 = entry.pattern.segments[0];
      const eSeg1 = entry.pattern.segments[1];
      if (eSeg0?.kind !== 'lit' || eSeg0.text !== scopeCollection || eSeg1?.kind !== 'var') continue;
      if (entry.pattern.service === 'storage') {
        for (const read of entry.crossServiceReads) {
          if (lookupUsesCallerIdentity(read)) discovered.push(read);
        }
      } else if (entry.pattern.service === 'firestore' && entry.pattern.segments.length === 4) {
        const subcol = entry.pattern.segments[2];
        const leaf = entry.pattern.segments[3];
        if (subcol?.kind === 'lit' && MEMBERSHIP_SUBCOLLECTION_RE.test(subcol.text) && leaf?.kind === 'var') {
          discovered.push({
            targetService: 'firestore',
            kind: 'exists',
            pattern: parseResourcePattern('firestore', `${scopeCollection}/{${scopeVar}}/${subcol.text}/{auth.uid}`),
          });
        }
      }
    }

    for (const cond of conditions) {
      if (cond.service !== 'firestore' || cond.kind !== 'lookup' || !cond.path.startsWith(`${scopeCollection}/`)) continue;
      const [lookupPath, field] = cond.field.split('#');
      if (!lookupPath || !lookupPath.includes('{auth.uid}')) continue;
      const lookup: {
        targetService: 'firestore';
        kind: 'get' | 'exists';
        pattern: ResourcePattern;
        field?: string;
        expectedAuth?: 'uid' | 'uid-list';
      } = {
        targetService: 'firestore',
        kind: 'exists',
        pattern: parseResourcePattern('firestore', lookupPath),
      };
      if (field) {
        lookup.kind = 'get';
        lookup.field = field;
        if (cond.relation === 'contains') lookup.expectedAuth = 'uid-list';
        else lookup.expectedAuth = 'uid';
      }
      discovered.push(lookup);
    }

    for (const docPath of Object.keys(effectiveFirestoreDocs(state))) {
      const parts = docPath.split('/').filter((p) => p.length > 0);
      if (parts.length === 4 && parts[0] === scopeCollection && MEMBERSHIP_SUBCOLLECTION_RE.test(parts[2]!) && parts[3] === owner.uid) {
        discovered.push({
          targetService: 'firestore',
          kind: 'exists',
          pattern: parseResourcePattern('firestore', `${scopeCollection}/{${scopeVar}}/${parts[2]}/{auth.uid}`),
        });
      }
    }
  }

  let primaryRulePattern = matchingEntries[0]?.pattern;
  if (!primaryRulePattern) primaryRulePattern = allPathEntries[0]?.pattern;

  const result: {
    directLookups: CrossServiceLookup[];
    membershipLookups: CrossServiceLookup[];
    primaryRulePattern?: ResourcePattern;
  } = { directLookups, membershipLookups: dedupeLookups(discovered) };
  if (primaryRulePattern) result.primaryRulePattern = primaryRulePattern;
  return result;
}

export function peerHasLiveMembershipAtPath(
  storageTemplate: string,
  rulePattern: ResourcePattern | undefined,
  concreteStoragePath: string,
  lookups: readonly CrossServiceLookup[],
  peer: ProbeActor,
  state: WorldState | undefined,
): boolean {
  const liveDocs = effectiveFirestoreDocs(state);
  if (Object.keys(liveDocs).length === 0 || lookups.length === 0) return false;

  const concreteSegs = concreteStoragePath
    .split('/')
    .filter((s) => s.length > 0)
    .map((text) => ({ kind: 'lit' as const, text }));
  const vars: Record<string, string> = {};
  for (const pat of [parseResourcePattern('storage', storageTemplate), rulePattern]) {
    if (!pat) continue;
    const u = unifyPatterns(pat, { service: 'storage', resourceId: pat.resourceId, segments: concreteSegs }, { cascade: true });
    if (!u) continue;
    for (const [k, seg] of u) {
      if (seg.kind === 'lit') setOwnScopeVar(vars, k, seg.text);
    }
  }
  setOwnScopeVar(vars, 'auth.uid', peer.uid);

  for (const lookup of lookups) {
    const rendered = renderResourcePattern(lookup.pattern);
    const peerDocPath = fillTemplate(rendered, vars, (n) => `v-${n}`, 'firestore').replace(/^\/+|\/+$/g, '');
    if (Object.hasOwn(liveDocs, peerDocPath)) return true;
  }
  return false;
}
