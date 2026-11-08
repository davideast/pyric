/**
 * Prerequisite records a probe needs so it tests ownership rather than
 * tripping an unrelated gate: membership and participant records the rules
 * look up under `auth.uid`, seeded for both actors.
 */
import type { AccessSite } from '../code/types.js';
import type { OwnerCondition } from '../rules/types.js';
import { covers, parseTemplate } from '../rules/templates.js';
import { concretePayload, fillTemplate } from './fixtures.js';
import type { ProbeActor, ProbeStep } from './types.js';

/** Values of a rule template's variables, read off a concrete path at the same positions. */
function bindRuleVars(ruleTemplate: string, concrete: string): Record<string, string> {
  const segs = concrete.split('/');
  const out: Record<string, string> = {};
  parseTemplate(ruleTemplate).forEach((seg, i) => {
    if (seg.kind === 'var' && segs[i] !== undefined) out[seg.name] = segs[i];
  });
  return out;
}

/** A client write site whose template is the lookup's record, for the record's shape. */
function recordSite(lookup: string, sites: AccessSite[]): AccessSite | undefined {
  const target = parseTemplate(lookup.replace('{auth.uid}', '{uid}'));
  return sites.find((s) => {
    if (!s.payload || !s.path) return false;
    const sitePath = parseTemplate(s.path);
    return covers(target, sitePath, false) && covers(sitePath, target, false);
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
  const site = parseTemplate(template);
  for (const c of conditions) {
    if (c.service !== service || c.kind !== 'lookup') continue;
    const rule = parseTemplate(c.path);
    if (!covers(rule, site, service === 'rtdb')) continue;
    const [lookupPath, field] = c.field.split('#');
    const lookup = parseTemplate(lookupPath);
    const authIndex = lookup.findIndex((s) => s.kind === 'var' && s.name === 'auth.uid');
    // A lookup of a child under the user's record (`members/{auth.uid}/removed`) needs no seed of its own.
    if (authIndex >= 0 && authIndex !== lookup.length - 1) continue;
    const vars = bindRuleVars(c.path, concrete);
    if (service === 'rtdb' && !lookup.some((s) => s.kind === 'var' && s.name === 'auth.uid') && c.relation === 'equals') {
      const path = fillTemplate(lookupPath, vars, (n) => `v-${n}`);
      if (!seen.has(path)) {
        seen.add(path);
        const matchActor = actors.find((a) => path.includes(a.uid)) ?? actors[0];
        const seedValue = matchActor?.uid ?? true;
        out.push({ actor: 'admin', service, method: 'set', path, data: seedValue });
      }
      continue;
    }
    for (const actor of actors) {
      const path = fillTemplate(lookupPath, { ...vars, 'auth.uid': actor.uid }, (n) => `v-${n}`);
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
        const shapeSite = recordSite(lookupPath, sites);
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
