/**
 * Prerequisite records a probe needs so it tests ownership rather than
 * tripping an unrelated gate: membership and participant records the rules
 * look up under `auth.uid`, plus cross-service Firestore documents referenced
 * by Cloud Storage `firestore.get()` / `firestore.exists()` rules.
 */
import type { AccessService, AccessSite } from '../code/types.js';
import type { CrossServiceLookup } from '../rules/rule-surface.js';
import type { OwnerCondition } from '../rules/types.js';
import {
  coversPattern,
  parseResourcePattern,
  renderResourcePattern,
  unifyPatterns,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import { concretePayload, fillTemplate } from './fixtures.js';
import { effectiveFirestoreDocs, fieldOf } from './state.js';
import type { ProbeActor, ProbeStep } from './types.js';
import type { WorldState } from './world.js';

const MEMBERSHIP_LIST_FIELD_RE = /(?:^|\.)(?:members|memberIds|uids|userIds|users|participants|editors|admins|owners|allowedUids)$/i;

function setOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Values of a rule template's variables, unified against a concrete path. */
function bindRuleVars(
  service: AccessService,
  ruleTemplate: string,
  concrete: string,
): Record<string, string> {
  const concreteSegs = concrete
    .split('/')
    .filter((s) => s.length > 0)
    .map((text) => ({ kind: 'lit' as const, text }));
  const rulePattern = parseResourcePattern(service, ruleTemplate);
  const unified = unifyPatterns(
    rulePattern,
    { service, resourceId: rulePattern.resourceId, segments: concreteSegs },
    { cascade: true },
  );
  const out: Record<string, string> = {};
  if (unified !== null) {
    for (const [name, seg] of unified) {
      if (seg.kind === 'lit') setOwnProperty(out, name, seg.text);
    }
    return out;
  }
  rulePattern.segments.forEach((seg, i) => {
    const target = concreteSegs[i];
    if (seg.kind === 'var' && target !== undefined) setOwnProperty(out, seg.name, target.text);
  });
  return out;
}

/** A client write site whose template is the lookup's record, for the record's shape. */
function recordSite(
  service: AccessService,
  lookup: string,
  sites: readonly AccessSite[],
): AccessSite | undefined {
  const target = parseResourcePattern(service, lookup.replace('{auth.uid}', '{uid}'));
  return sites.find((s) => {
    if (!s.payload || !s.path || s.service !== service) return false;
    const sitePattern = parseResourcePattern(s.service, s.path);
    return coversPattern(target, sitePattern) && coversPattern(sitePattern, target);
  });
}

function separatorFor(service: AccessService): string {
  if (service === 'firestore') return '.';
  return '/';
}

function fallbackLookupValue(service: AccessService): unknown {
  if (service === 'firestore') return { member: true };
  return true;
}

/**
 * Seed steps for every lookup condition that guards `template` (RTDB
 * conditions cascade to deeper paths), filled for each actor.
 */
export function lookupSeeds(
  service: AccessService,
  template: string,
  concrete: string,
  conditions: OwnerCondition[],
  sites: AccessSite[],
  actors: ProbeActor[],
): ProbeStep[] {
  if (service === 'storage') return [];
  const out: ProbeStep[] = [];
  const seen = new Set<string>();
  const site = parseResourcePattern(service, template);
  const matchingLookups = conditions.filter((c) => {
    if (c.service !== service || c.kind !== 'lookup') return false;
    const rule = parseResourcePattern(service, c.path);
    return coversPattern(rule, site, { cascade: service === 'rtdb' });
  });

  const hintedByLookupPath = new Map<string, { exact?: string | number | boolean; lower?: number; upper?: number }>();
  for (const c of matchingLookups) {
    if (c.seedValue === undefined) continue;
    const [lp] = c.field.split('#');
    const cur = hintedByLookupPath.get(lp) ?? {};
    if (c.comparisonOp !== undefined && typeof c.seedValue === 'number') {
      if (c.comparisonOp === '>' || c.comparisonOp === '>=') {
        cur.lower = cur.lower === undefined ? c.seedValue : Math.max(cur.lower, c.seedValue);
      } else {
        cur.upper = cur.upper === undefined ? c.seedValue : Math.min(cur.upper, c.seedValue);
      }
    } else if (cur.exact === undefined) {
      cur.exact = c.seedValue;
    }
    hintedByLookupPath.set(lp, cur);
  }

  for (const c of matchingLookups) {
    const [lookupPath, field] = c.field.split('#');
    const lookup = parseResourcePattern(service, lookupPath).segments;
    const authIndex = lookup.findIndex((s) => s.kind === 'var' && s.name === 'auth.uid');
    // A lookup of a child under the user's record (`members/{auth.uid}/removed`) needs no seed of its own.
    if (authIndex >= 0 && authIndex !== lookup.length - 1) continue;
    const vars = bindRuleVars(service, c.path, concrete);
    if (service === 'rtdb' && !lookup.some((s) => s.kind === 'var' && s.name === 'auth.uid') && c.relation === 'equals') {
      const path = fillTemplate(lookupPath, vars, (n) => `v-${n}`, service);
      if (!seen.has(path)) {
        seen.add(path);
        const matchActor = actors.find((a) => path.includes(a.uid)) ?? actors[0];
        const seedValue = matchActor?.uid ?? true;
        out.push({ actor: 'admin', service, method: 'set', path, data: seedValue });
      }
      continue;
    }
    for (const actor of actors) {
      const filledVars: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) setOwnProperty(filledVars, k, v);
      setOwnProperty(filledVars, 'auth.uid', actor.uid);
      const path = fillTemplate(lookupPath, filledVars, (n) => `v-${n}`, service);
      if (seen.has(path)) continue;
      seen.add(path);
      let data: unknown;
      if (service === 'firestore' && field) {
        const docData: Record<string, unknown> = {};
        if (c.relation === 'contains') {
          setOwnProperty(docData, field, actors.map((a) => a.uid));
        } else {
          setOwnProperty(docData, field, actor.uid);
        }
        data = docData;
      } else {
        const shapeSite = recordSite(service, lookupPath, sites);
        if (shapeSite) {
          data = concretePayload(shapeSite.payload, actor, separatorFor(service));
        }
        if (data === null || data === undefined) {
          const hinted = hintedByLookupPath.get(lookupPath);
          if (hinted?.exact !== undefined) {
            data = hinted.exact;
          } else if (hinted?.lower !== undefined) {
            data = hinted.lower;
          } else if (hinted?.upper !== undefined) {
            data = hinted.upper;
          } else {
            data = fallbackLookupValue(service);
          }
        }
      }
      out.push({ actor: 'admin', service, method: 'set', path, data });
    }
  }
  return out;
}

export interface CrossServiceSeedOptions {
  readonly storageTemplate: string;
  readonly rulePattern?: ResourcePattern;
  readonly concreteStoragePath: string;
  readonly lookups: readonly CrossServiceLookup[];
  readonly actors: readonly ProbeActor[];
  readonly sites?: readonly AccessSite[];
  readonly state?: WorldState;
}

function setDottedField(target: Record<string, unknown>, dottedField: string, value: unknown): void {
  const parts = dottedField.split('.').filter((part) => part.length > 0);
  if (parts.length === 0) return;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i]!;
    let next: Record<string, unknown> = {};
    if (
      Object.hasOwn(cursor, seg)
      && cursor[seg] !== null
      && typeof cursor[seg] === 'object'
      && !Array.isArray(cursor[seg])
    ) {
      next = { ...(cursor[seg] as Record<string, unknown>) };
    }
    setOwnProperty(cursor, seg, next);
    cursor = next;
  }
  setOwnProperty(cursor, parts[parts.length - 1]!, value);
}

function isListLikeLookup(lookup: CrossServiceLookup): boolean {
  if (lookup.expectedAuth === 'uid-list') return true;
  if (lookup.field === undefined || lookup.expectedValue !== undefined || lookup.expectedAuth !== undefined) {
    return false;
  }
  const hasUidSegment = lookup.pattern.segments.some((s) => s.kind === 'var' && s.name === 'auth.uid');
  if (hasUidSegment) return false;
  return MEMBERSHIP_LIST_FIELD_RE.test(lookup.field);
}

function isReadonlyScalarList(
  value: CrossServiceLookup['expectedValue'],
): value is readonly (string | number | boolean)[] {
  return Array.isArray(value);
}

function lookupSatisfiedByDoc(
  docData: Record<string, unknown> | undefined,
  lookup: CrossServiceLookup,
  actor: ProbeActor,
): boolean {
  if (!docData) return false;
  if (lookup.kind === 'exists' || lookup.field === undefined) return true;
  const actual = fieldOf(docData, lookup.field, '.');
  if (lookup.expectedValue !== undefined) {
    if (isReadonlyScalarList(lookup.expectedValue)) {
      if (!Array.isArray(actual)) return false;
      if (lookup.expectedValue.length === 0) return actual.length === 0;
      return lookup.expectedValue.every((expected) => actual.includes(expected));
    }
    if (lookup.comparisonOp !== undefined && typeof lookup.expectedValue === 'number') {
      if (typeof actual !== 'number') return false;
      if (lookup.comparisonOp === '>' || lookup.comparisonOp === '>=') {
        return actual >= lookup.expectedValue;
      }
      return actual <= lookup.expectedValue;
    }
    return actual === lookup.expectedValue;
  }
  if (lookup.expectedAuth === 'uid') return actual === actor.uid;
  if (lookup.expectedAuth === 'uid-not-in-list') {
    return Array.isArray(actual) && !actual.includes(actor.uid);
  }
  if (isListLikeLookup(lookup)) {
    return Array.isArray(actual) && actual.includes(actor.uid);
  }
  return Boolean(actual);
}

/**
 * Bind non-auth path variables (for example `orgId`) from existing Firestore
 * documents in `WorldState` that match `lookups` for `actor`, so Storage probes
 * reuse real seeded scope IDs before synthesizing fresh ones.
 */
export function bindVarsFromCrossServiceState(
  storageTemplate: string,
  rulePattern: ResourcePattern | undefined,
  lookups: readonly CrossServiceLookup[],
  actor: ProbeActor,
  state: WorldState | undefined,
): Record<string, string> {
  const bound: Record<string, string> = {};
  const liveDocs = effectiveFirestoreDocs(state);
  const liveEntries = Object.entries(liveDocs);
  if (liveEntries.length === 0 || lookups.length === 0) return bound;

  const sitePattern = parseResourcePattern('storage', storageTemplate);
  for (const lookup of lookups) {
    for (const [docPath, docData] of liveEntries) {
      const concreteSegs = docPath
        .split('/')
        .filter((s) => s.length > 0)
        .map((text) => ({ kind: 'lit' as const, text }));
      const unified = unifyPatterns(lookup.pattern, {
        service: 'firestore',
        resourceId: lookup.pattern.resourceId,
        segments: concreteSegs,
      });
      if (unified === null) continue;
      const uidBinding = unified.get('auth.uid');
      if (uidBinding && uidBinding.kind === 'lit' && uidBinding.text !== actor.uid) {
        continue;
      }
      if (!lookupSatisfiedByDoc(docData, lookup, actor)) continue;
      for (const [varName, seg] of unified) {
        if (varName === 'auth.uid' || varName.startsWith('auth.token.')) continue;
        if (seg.kind !== 'lit') continue;
        if (!Object.hasOwn(bound, varName)) setOwnProperty(bound, varName, seg.text);
        if (rulePattern) {
          rulePattern.segments.forEach((rSeg, idx) => {
            const sSeg = sitePattern.segments[idx];
            if (rSeg.kind === 'var' && rSeg.name === varName && sSeg?.kind === 'var') {
              if (!Object.hasOwn(bound, sSeg.name)) setOwnProperty(bound, sSeg.name, seg.text);
            }
          });
        }
      }
    }
  }
  return bound;
}

/**
 * Synthesize `admin` Firestore prerequisite documents for `CrossServiceLookup`
 * entries guarding a Cloud Storage rule. Preserves existing satisfying live
 * documents in `WorldState` / `SandboxSnapshot` without overwriting them.
 */
export function crossServiceLookupSeeds(options: CrossServiceSeedOptions): ProbeStep[] {
  if (options.lookups.length === 0 || options.actors.length === 0) return [];

  const baseVars = bindRuleVars('storage', options.storageTemplate, options.concreteStoragePath);
  if (options.rulePattern) {
    const ruleVars = bindRuleVars(
      'storage',
      renderResourcePattern(options.rulePattern),
      options.concreteStoragePath,
    );
    for (const [k, v] of Object.entries(ruleVars)) {
      setOwnProperty(baseVars, k, v);
    }
  }

  interface PendingSeedItem {
    readonly lookup: CrossServiceLookup;
    readonly lookupTemplate: string;
    readonly actor: ProbeActor;
  }

  const byDocPath = new Map<string, PendingSeedItem[]>();
  for (const lookup of options.lookups) {
    if (lookup.targetService !== 'firestore') continue;
    const lookupTemplate = renderResourcePattern(lookup.pattern);
    for (const actor of options.actors) {
      const filledVars: Record<string, string> = {};
      for (const [k, v] of Object.entries(baseVars)) setOwnProperty(filledVars, k, v);
      setOwnProperty(filledVars, 'auth.uid', actor.uid);
      for (const seg of lookup.pattern.segments) {
        if (seg.kind === 'var' && seg.name.startsWith('auth.token.')) {
          const claimKey = seg.name.slice('auth.token.'.length);
          const claimVal = actor.token[claimKey];
          if (typeof claimVal === 'string' || typeof claimVal === 'number') {
            setOwnProperty(filledVars, seg.name, String(claimVal));
          }
        }
      }
      const rawDocPath = fillTemplate(lookupTemplate, filledVars, (n) => `v-${n}`, 'firestore');
      const docPath = rawDocPath.replace(/^\/+|\/+$/g, '');
      if (docPath.length === 0 || docPath.split('/').length % 2 !== 0) continue;
      let list = byDocPath.get(docPath);
      if (!list) {
        list = [];
        byDocPath.set(docPath, list);
      }
      list.push({ lookup, lookupTemplate, actor });
    }
  }

  const liveDocs = effectiveFirestoreDocs(options.state);
  const out: ProbeStep[] = [];
  for (const [docPath, items] of byDocPath) {
    let liveDoc: Record<string, unknown> | undefined;
    if (Object.hasOwn(liveDocs, docPath)) {
      liveDoc = liveDocs[docPath];
    }
    if (liveDoc && items.every((item) => lookupSatisfiedByDoc(liveDoc, item.lookup, item.actor))) {
      continue;
    }

    let docData: Record<string, unknown> = {};
    if (liveDoc) {
      docData = { ...liveDoc };
    } else if (options.sites && options.sites.length > 0) {
      const first = items[0]!;
      const shapeSite = recordSite('firestore', first.lookupTemplate, options.sites);
      if (shapeSite) {
        const synthesized = concretePayload(shapeSite.payload, first.actor, '.');
        if (synthesized && typeof synthesized === 'object' && !Array.isArray(synthesized)) {
          docData = { ...(synthesized as Record<string, unknown>) };
        }
      }
    }

    const numericBounds = new Map<string, { lower?: number; upper?: number }>();
    for (const { lookup } of items) {
      if (
        lookup.field !== undefined
        && lookup.comparisonOp !== undefined
        && typeof lookup.expectedValue === 'number'
      ) {
        const cur = numericBounds.get(lookup.field) ?? {};
        if (lookup.comparisonOp === '>' || lookup.comparisonOp === '>=') {
          cur.lower = cur.lower === undefined ? lookup.expectedValue : Math.max(cur.lower, lookup.expectedValue);
        } else {
          cur.upper = cur.upper === undefined ? lookup.expectedValue : Math.min(cur.upper, lookup.expectedValue);
        }
        numericBounds.set(lookup.field, cur);
      }
    }

    for (const { lookup, actor } of items) {
      if (lookup.field !== undefined) {
        if (lookup.expectedValue !== undefined) {
          if (isReadonlyScalarList(lookup.expectedValue)) {
            if (lookup.expectedValue.length === 0) {
              const existingVal = fieldOf(docData, lookup.field, '.');
              if (!Array.isArray(existingVal)) {
                setDottedField(docData, lookup.field, []);
              }
            } else {
              const existingVal = fieldOf(docData, lookup.field, '.');
              const nextList: unknown[] = [];
              if (Array.isArray(existingVal)) nextList.push(...existingVal);
              for (const item of lookup.expectedValue) {
                if (!nextList.includes(item)) nextList.push(item);
              }
              setDottedField(docData, lookup.field, nextList);
            }
          } else if (lookup.comparisonOp !== undefined && typeof lookup.expectedValue === 'number') {
            const bounds = numericBounds.get(lookup.field);
            let resolvedNum = lookup.expectedValue;
            if (bounds?.lower !== undefined) {
              resolvedNum = bounds.lower;
            } else if (bounds?.upper !== undefined) {
              resolvedNum = bounds.upper;
            }
            setDottedField(docData, lookup.field, resolvedNum);
          } else {
            setDottedField(docData, lookup.field, lookup.expectedValue);
          }
        } else if (lookup.expectedAuth === 'uid') {
          setDottedField(docData, lookup.field, actor.uid);
        } else if (lookup.expectedAuth === 'uid-not-in-list') {
          const existingVal = fieldOf(docData, lookup.field, '.');
          if (Array.isArray(existingVal)) {
            setDottedField(
              docData,
              lookup.field,
              existingVal.filter((entry) => entry !== actor.uid),
            );
          } else {
            setDottedField(docData, lookup.field, []);
          }
        } else if (isListLikeLookup(lookup)) {
          const existingVal = fieldOf(docData, lookup.field, '.');
          const nextList: unknown[] = [];
          if (Array.isArray(existingVal)) nextList.push(...existingVal);
          if (!nextList.includes(actor.uid)) nextList.push(actor.uid);
          setDottedField(docData, lookup.field, nextList);
        } else {
          setDottedField(docData, lookup.field, true);
        }
      } else if (Object.keys(docData).length === 0) {
        setOwnProperty(docData, 'active', true);
      }
    }

    out.push({
      actor: 'admin',
      service: 'firestore',
      method: 'set',
      path: docPath,
      data: docData,
    });
  }

  return out;
}
