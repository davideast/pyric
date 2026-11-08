/**
 * Prerequisite records a probe needs so it tests ownership rather than
 * tripping an unrelated gate: membership and participant records the rules
 * look up under `auth.uid`, seeded for both actors.
 */
import type { AccessSite } from '../code/types.js';
import type { OwnerCondition } from '../rules/types.js';
import { coversPattern, parseResourcePattern, unifyPatterns } from '../../sandbox/internal/index.js';
import { concretePayload, fillTemplate } from './fixtures.js';
import type { ProbeActor, ProbeStep } from './types.js';

/** Values of a rule template's variables, unified against a concrete path. */
function bindRuleVars(
  service: 'firestore' | 'rtdb',
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
      if (seg.kind === 'lit') out[name] = seg.text;
    }
    return out;
  }
  rulePattern.segments.forEach((seg, i) => {
    const target = concreteSegs[i];
    if (seg.kind === 'var' && target !== undefined) out[seg.name] = target.text;
  });
  return out;
}

/** A client write site whose template is the lookup's record, for the record's shape. */
function recordSite(
  service: 'firestore' | 'rtdb',
  lookup: string,
  sites: AccessSite[],
): AccessSite | undefined {
  const target = parseResourcePattern(service, lookup.replace('{auth.uid}', '{uid}'));
  return sites.find((s) => {
    if (!s.payload || !s.path || s.service !== service) return false;
    const sitePattern = parseResourcePattern(s.service, s.path);
    return coversPattern(target, sitePattern) && coversPattern(sitePattern, target);
  });
}

function separatorFor(service: 'firestore' | 'rtdb'): string {
  if (service === 'firestore') return '.';
  return '/';
}

function fallbackLookupValue(service: 'firestore' | 'rtdb'): unknown {
  if (service === 'firestore') return { member: true };
  return true;
}

/**
 * Seed steps for every lookup condition that guards `template` (RTDB
 * conditions cascade to deeper paths), filled for each actor.
 */
export function lookupSeeds(
  service: 'firestore' | 'rtdb',
  template: string,
  concrete: string,
  conditions: OwnerCondition[],
  sites: AccessSite[],
  actors: ProbeActor[],
): ProbeStep[] {
  const out: ProbeStep[] = [];
  const seen = new Set<string>();
  const site = parseResourcePattern(service, template);
  for (const c of conditions) {
    if (c.service !== service || c.kind !== 'lookup') continue;
    const rule = parseResourcePattern(service, c.path);
    if (!coversPattern(rule, site, { cascade: service === 'rtdb' })) continue;
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
      const path = fillTemplate(lookupPath, { ...vars, 'auth.uid': actor.uid }, (n) => `v-${n}`, service);
      if (seen.has(path)) continue;
      seen.add(path);
      let data: unknown;
      if (service === 'firestore' && field) {
        if (c.relation === 'contains') {
          data = { [field]: actors.map((a) => a.uid) };
        } else {
          data = { [field]: actor.uid };
        }
      } else {
        const shapeSite = recordSite(service, lookupPath, sites);
        if (shapeSite) {
          data = concretePayload(shapeSite.payload, actor, separatorFor(service));
        }
        if (data === null || data === undefined) {
          data = fallbackLookupValue(service);
        }
      }
      out.push({ actor: 'admin', service, method: 'set', path, data });
    }
  }
  return out;
}
