/**
 * Probe planning: turn an app's real client writes and its owner bindings
 * into probes, each a sequence of legitimate setup steps and one step
 * under test.
 */
import type { AccessSite } from '../code/types.js';
import { coversPattern, parseResourcePattern } from '../../sandbox/internal/index.js';
import type { OwnerBinding, OwnerCondition } from '../rules/types.js';
import type { ValueHint } from '../rules/value-hints.js';
import { planFieldOwned } from './field-owned-probes.js';
import { attributionFields, concretePath, isConcretePayload, isSentinel, uidFields } from './fixtures.js';
import { lookupSeeds } from './prerequisites.js';
import { attributionValuesAt, fieldOf, recordsAt } from './state.js';
import { creator, dedupeSites, findCreateCondition, hintOverrides, isCleanup, opOf, probeable, recordPath, same, sep, shareUidVariables, siblingsOf, stepFor, type MakeStep } from './step-builder.js';
import type { Probe, ProbeActor, ProbeStep } from './types.js';
import type { WorldState } from './world.js';

export interface PlanInput {
  sites: AccessSite[];
  bindings: OwnerBinding[];
  conditions: OwnerCondition[];
  owner: ProbeActor;
  peer: ProbeActor;
  /** Literal values the rules expect for fields, used where the client's value isn't known. */
  hints?: ValueHint[];
  /** Existing data every probe starts from; attacks target real records in it when they can. */
  state?: WorldState;
}

function bindingsAt(site: AccessSite, bindings: OwnerBinding[]): OwnerBinding[] {
  const sitePattern = parseResourcePattern(site.service, site.path);
  return bindings.filter((b) => {
    if (b.service !== site.service) return false;
    const bindingPattern = parseResourcePattern(b.service, b.path);
    return (
      coversPattern(bindingPattern, sitePattern, { cascade: true })
      || coversPattern(sitePattern, bindingPattern, { cascade: true })
    );
  });
}

function isRuleConfirmed(bs: OwnerBinding[]): boolean {
  return bs.some((b) => b.strength === 'strong' || b.evidence !== 'code-only');
}

function isExactUidOnly(auth: { source: string; certainty: 'exact' | 'partial' }[] | undefined): boolean {
  if (!auth || auth.length === 0) return false;
  return auth.every((a) => a.source === 'auth.uid' && a.certainty === 'exact');
}

function buildCreatorSetupStep(site: AccessSite, make: AccessSite, ownerUid: string, conditions: OwnerCondition[], step: MakeStep): { step: ProbeStep; injectedConditionField: boolean } {
  const condField = findCreateCondition(site, conditions);
  const overrides: Record<string, unknown> = {};
  let injectedConditionField = false;
  if (condField && !(make.payload?.fields ?? []).some((f) => f.name === condField)) {
    overrides[condField] = ownerUid;
    injectedConditionField = true;
  }
  let setupStep = step(make, 'owner', { pathSite: site, overrides });
  if (make.op === 'updateDoc') setupStep = { ...setupStep, method: 'set' };
  return { step: setupStep, injectedConditionField };
}

export function planProbes(input: PlanInput): Probe[] {
  const { owner, peer, conditions } = input;
  input = { ...input, sites: shareUidVariables(input.sites) };
  const actors = { owner, peer };
  const hints = input.hints ?? [];
  const step: MakeStep = (site, actor, options = {}) => {
    const otherUid = actor === 'owner' ? peer.uid : owner.uid;
    const overrides = { ...hintOverrides(options.pathSite ?? site, hints), ...hintOverrides(site, hints) };
    if (options.overrides) Object.assign(overrides, options.overrides);
    return stepFor(site, actor, actors, { state: input.state, otherUid, ...options, overrides });
  };
  const sites = dedupeSites(input.sites.filter(probeable));
  const probes: Probe[] = [];
  const seeds = (site: AccessSite, concrete: string): ProbeStep[] =>
    lookupSeeds(site.service, site.path, concrete, conditions, input.sites, [owner, peer]);
  let n = 0;
  const add = (p: Omit<Probe, 'id'>): void => {
    probes.push({ ...p, id: `${p.kind}-${++n}` });
  };

  for (const site of sites) {
    const ownerStep = step(site, 'owner');
    const seedOwner = seeds(site, concretePath(site, owner, { state: input.state, otherUid: peer.uid }));
    const bs = bindingsAt(site, input.bindings);

    if (!site.source.startsWith('seed:')) {
      if (isCleanup(site)) {
        const make = creator(site, input.sites);
        if (make) {
          const setupStep = buildCreatorSetupStep(site, make, owner.uid, conditions, step).step;
          add({
            kind: 'must-allow-denied', op: 'delete', service: site.service, template: site.path, status: 'proven',
            seed: seedOwner, setup: [setupStep], attack: ownerStep, expect: 'allow',
            evidence: `the owner can write ${site.path} (${make.source}) but its cleanup ${site.op} (${site.source}) is denied`,
            sources: [make.source, site.source],
          });
          const siblings = siblingsOf(site, input.sites);
          if (siblings.length > 0) {
            const before: ProbeStep[] = [];
            const after: ProbeStep[] = [];
            for (const sib of siblings) {
              const sibMake = creator(sib, input.sites);
              if (sibMake) before.push(buildCreatorSetupStep(sib, sibMake, owner.uid, conditions, step).step);
              after.push(step(sib, 'owner'));
            }
            add({
              kind: 'must-allow-denied', op: 'delete', service: site.service, template: site.path, status: 'proven',
              seed: [...seedOwner, ...siblings.flatMap((s) => seeds(s, concretePath(s, owner, { state: input.state, otherUid: peer.uid })))],
              setup: [...before, setupStep, ...after], attack: ownerStep, expect: 'allow',
              evidence: `after the owner's ${siblings.map((s) => s.path).join(', ')} are cleaned up, the owner's cleanup ${site.op} on ${site.path} (${site.source}) is denied`,
              sources: [site.source, ...siblings.map((s) => s.source)],
            });
          }
        }
      } else if (site.op === 'updateDoc' || site.op === 'update' || site.op === 'onDisconnect.update') {
        const setup: ProbeStep[] = [];
        const make = creator(site, input.sites);
        let requiresInconclusive = false;
        if (make) {
          const built = buildCreatorSetupStep(site, make, owner.uid, conditions, step);
          requiresInconclusive = built.injectedConditionField;
          setup.push({ ...built.step, actor: 'owner' });
        } else {
          setup.push({ ...ownerStep, actor: 'admin', method: 'set' });
        }
        let inconc: string | undefined;
        if (requiresInconclusive) inconc = 'client update may be missing initializer fields required by rules';
        else if (!isConcretePayload(site.payload)) inconc = 'the synthesized payload may not satisfy validation';
        const updateProbe: Omit<Probe, 'id'> = {
          kind: 'must-allow-denied', op: opOf(site), service: site.service, template: site.path, status: 'proven',
          seed: [...seedOwner, ...setup.filter((s) => s.actor === 'admin')],
          setup: setup.filter((s) => s.actor !== 'admin'), attack: ownerStep, expect: 'allow',
          evidence: `the owner's own ${site.op} at ${site.source} is denied`, sources: [site.source],
        };
        if (inconc) updateProbe.inconclusiveOnDeny = inconc;
        add(updateProbe);
      } else {
        const createProbe: Omit<Probe, 'id'> = {
          kind: 'must-allow-denied', op: opOf(site), service: site.service, template: site.path, status: 'proven',
          seed: seedOwner, setup: [], attack: ownerStep, expect: 'allow',
          evidence: `the owner's own ${site.op} at ${site.source} is denied`, sources: [site.source],
        };
        if (!isConcretePayload(site.payload)) createProbe.inconclusiveOnDeny = 'the synthesized payload may not satisfy validation';
        add(createProbe);
      }
    }
    if (isCleanup(site)) continue;

    const uidVars = (site.pathVariables ?? []).filter((v) => v.auth?.some((a) => a.source === 'auth.uid'));
    if (uidVars.length > 0) {
      const slotBindings = bs.filter((b) => b.kind === 'pathVar');
      const existing = recordsAt(site.service, site.path, input.state).find((r) => r.path.includes(owner.uid));
      const uidOverrides = Object.fromEntries(uidFields(site.payload).map((f) => [f, owner.uid]));
      let attack = step(site, 'peer', { keyActor: owner, overrides: uidOverrides });
      if (existing) attack = { ...attack, path: existing.path };
      const hasExactSlot = !site.source.startsWith('seed:') && site.resolution === 'resolved' && uidVars.some((v) => isExactUidOnly(v.auth));
      const slotStatus: 'proven' | 'flagged' = isRuleConfirmed(slotBindings) || hasExactSlot ? 'proven' : 'flagged';
      const slotSeeds = [...seedOwner, ...seeds(site, concretePath(site, peer, { state: input.state, otherUid: owner.uid }))];
      add({
        kind: 'foreign-slot-write', op: 'write', service: site.service, template: site.path, status: slotStatus,
        seed: slotSeeds, setup: [ownerStep], attack, expect: 'deny',
        evidence: `${peer.uid} wrote into ${owner.uid}'s slot at ${recordPath(attack)} (client write ${site.source})`, sources: [site.source],
      });
      if (parseResourcePattern(site.service, site.path).segments.filter((x) => x.kind === 'var').length > uidVars.length) {
        const fresh = step(site, 'peer', { keyActor: owner, variant: '-fresh', overrides: uidOverrides });
        add({
          kind: 'foreign-slot-write', op: 'write', service: site.service, template: site.path, status: slotStatus,
          seed: slotSeeds, setup: [ownerStep], attack: fresh, expect: 'deny',
          evidence: `${peer.uid} added an entry inside ${owner.uid}'s slot at ${recordPath(fresh)} (client write ${site.source})`, sources: [site.source],
        });
      }
    }

    const ownerFields = new Set([...uidFields(site.payload), ...bs.filter((b) => b.kind === 'storedField' || b.kind === 'incomingField').map((b) => b.field.replace(/^\.\.\//, ''))]);
    const fieldBindings = bs.filter((b) => b.kind === 'storedField' || b.kind === 'incomingField');
    const ruleFieldBindings = fieldBindings.filter((b) => b.evidence !== 'code-only');
    const owned = [...ownerFields].filter((f) => site.payload?.fields.some((x) => x.name === f && (!x.optional || ruleFieldBindings.some((b) => b.field.replace(/^\.\.\//, '') === f))));
    const hasExactField = !site.source.startsWith('seed:') && site.resolution === 'resolved' && owned.some((name) => site.payload?.fields.some((f) => f.name === name && !f.optional && isExactUidOnly(f.auth)));
    const fieldStatus: 'proven' | 'flagged' = isRuleConfirmed(ruleFieldBindings) || hasExactField ? 'proven' : 'flagged';
    const hasCleanupAtPath = input.sites.some((s) => probeable(s) && same(s, site) && isCleanup(s));
    const allWritesCarryUid = input.sites.filter((s) => probeable(s) && same(s, site) && !isCleanup(s)).every((s) => uidFields(s.payload).length > 0);
    const ownsWholeRecordViaUpdate = (hasCleanupAtPath || allWritesCarryUid) && owned.some((name) => !name.includes('/') && site.payload?.fields.some((x) => x.name === name && !x.optional && x.kind === 'string' && x.auth?.some((a) => a.source === 'auth.uid')));
    const writesRecord = opOf(site) === 'create' || (site.service === 'rtdb' && opOf(site) === 'update' && (ownsWholeRecordViaUpdate || ruleFieldBindings.length > 0 || uidVars.length > 0));
    const signedOnly = owned.length === 0 && uidVars.length === 0 ? attributionFields(site.payload).filter((n) => !/[/.]/.test(n)) : [];
    if (signedOnly.length > 0 && writesRecord) planFieldOwned(site, signedOnly, 'flagged', input, actors, step, seeds, add, true);
    if (owned.length > 0 && writesRecord) planFieldOwned(site, owned, fieldStatus, input, actors, step, seeds, add);

    const attribution = attributionFields(site.payload).filter((n) => !/[/.]/.test(n) || owned.length === 0);
    if (attribution.length > 0 && opOf(site) === 'create') {
      const spoof: Record<string, unknown> = {};
      for (const name of attribution) {
        const f = site.payload!.fields.find((x) => x.name === name)!;
        spoof[name] = spoofValue(site, f, owner, peer, input.state);
      }
      const seedPeer = seeds(site, concretePath(site, peer, { state: input.state, otherUid: owner.uid }));
      add({
        kind: 'attribution-spoof', op: 'create', service: site.service, template: site.path, status: 'flagged',
        seed: seedPeer, setup: [step(site, 'peer', { variant: '-own' })], attack: step(site, 'peer', { variant: '-spoof', overrides: spoof }), expect: 'deny',
        evidence: `${peer.uid} wrote ${attribution.join(', ')} as ${Object.values(spoof).join(', ')} (client write ${site.source})`, sources: [site.source],
      });
    }
  }

  for (const site of sites) {
    const counters = (site.payload?.fields ?? []).filter((f) => f.kind === 'increment').map((f) => f.name);
    if (counters.length === 0) continue;
    const make = creator(site, input.sites);
    const existing = recordsAt(site.service, site.path, input.state).find((r) => counters.every((c) => typeof fieldOf(r.data, c, sep(site)) === 'number'));
    const path = existing?.path ?? concretePath(site, owner, { state: input.state, otherUid: peer.uid });
    const seedRecord: ProbeStep[] = [];
    if (!existing) {
      let baseSeed: ProbeStep = { actor: 'admin', service: site.service, method: 'set', path, data: {} };
      if (make) baseSeed = { ...step(make, 'owner', { pathSite: site }), actor: 'admin' };
      seedRecord.push(ensureCounters(baseSeed, counters, sep(site)));
    }
    const plusOne = Object.fromEntries(counters.map((c) => [c, { __sentinel: 'increment', by: 1 }]));
    const plusMany = Object.fromEntries(counters.map((c) => [c, (existing ? (fieldOf(existing.data, c, sep(site)) as number) : 0) + 100]));
    add({
      kind: 'counter-integrity', op: 'update', service: site.service, template: site.path, status: 'flagged',
      seed: [...seeds(site, path), ...seedRecord],
      setup: [{ actor: 'peer', service: site.service, method: 'update', path, data: plusOne }],
      attack: { actor: 'peer', service: site.service, method: 'update', path, data: plusMany }, expect: 'deny',
      evidence: `${peer.uid} moved ${counters.join(', ')} by 100 where the client increments by 1 (${site.source})`, sources: [site.source],
    });
  }
  return dedupeProbes(probes);
}

/** A seeded record carries numeric counters (an increment sentinel would be seeded as its delta). */
export function ensureCounters(step: ProbeStep, counters: string[], separator: string): ProbeStep {
  if (step.path === '') return step;
  const raw = step.data;
  let data: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) data = { ...(raw as Record<string, unknown>) };
  for (const counter of counters) {
    const parts = counter.split(separator);
    let cur = data;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const existing = cur[key];
      let next: Record<string, unknown> = {};
      if (existing && typeof existing === 'object' && !Array.isArray(existing) && !isSentinel(existing)) {
        next = { ...(existing as Record<string, unknown>) };
      }
      cur[key] = next;
      cur = next;
    }
    cur[parts[parts.length - 1]] = 0;
  }
  return { ...step, method: 'set', data };
}

function spoofValue(site: AccessSite, f: { name?: string; auth?: { source: string }[] }, owner: ProbeActor, peer: ProbeActor, state: WorldState | undefined): string {
  const sources = new Set((f.auth ?? []).map((a) => a.source));
  if (sources.has('auth.displayName') && owner.displayName !== owner.uid) return owner.displayName;
  const shown = attributionValuesAt(site, f.name ?? '', state).filter((v) => v !== peer.displayName && v !== peer.email);
  if (shown.length > 0) {
    const counts = new Map<string, number>();
    for (const v of shown) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  if (sources.has('auth.email')) return owner.email;
  return owner.displayName;
}

function dedupeProbes(probes: Probe[]): Probe[] {
  const seen = new Set<string>();
  return probes.filter((p) => {
    const key = `${p.kind}|${p.template}|${JSON.stringify(p.attack)}|${JSON.stringify(p.setup)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
