/**
 * Step construction, cleanup classification, sibling-scope discovery, and
 * creator selection for assurance probes.
 */
import { isWriteOp } from '../code/operation-specs.js';
import type { AccessSite } from '../code/types.js';
import {
  coversPattern,
  parseResourcePattern,
  resourceShapeKey,
  type PatternSegment,
} from '../../sandbox/internal/resource-pattern.js';
import type { OwnerCondition } from '../rules/types.js';
import type { ValueHint } from '../rules/value-hints.js';
import { concretePath, concretePayload, uidFields } from './fixtures.js';
import type { FindingOp, ProbeActor, ProbeStep } from './types.js';
import type { WorldState } from './world.js';

interface StepOptions {
  keyActor?: ProbeActor;
  variant?: string;
  overrides?: Record<string, unknown>;
  pathSite?: AccessSite;
}

export type MakeStep = (site: AccessSite, actor: 'owner' | 'peer', options?: StepOptions) => ProbeStep;

/** The record a step writes: its path, or the single key of a root multi-path update. */
export function recordPath(step: ProbeStep): string {
  if (step.path) return step.path;
  const keys = Object.keys((step.data as object) ?? {});
  return keys[0] ?? '';
}

/** Field overrides from rule hints, for fields whose client value isn't a literal or auth-sourced. */
export function hintOverrides(site: AccessSite, hints: ValueHint[]): Record<string, unknown> {
  const sitePattern = parseResourcePattern(site.service, site.path);
  const at = hints.filter(
    (h) => h.service === site.service && coversPattern(parseResourcePattern(h.service, h.path), sitePattern),
  );
  if (at.length === 0) return {};
  const out: Record<string, unknown> = {};
  const free = (f: { literal?: unknown; auth?: unknown[]; kind: string }): boolean =>
    f.literal === undefined && !(f.auth?.length) && (f.kind === 'string' || f.kind === 'unknown');
  const shape = site.payload;
  if (shape && shape.kind !== 'object' && free({ literal: shape.literal, auth: shape.auth, kind: shape.kind })) {
    const h = at.find((x) => x.field === '.');
    if (h) out['.'] = h.value;
  }
  for (const f of shape?.fields ?? []) {
    if (!free(f)) continue;
    const name = site.service === 'rtdb' ? f.name : f.name.replace(/\./g, '/');
    const h = at.find((x) => x.field === name || x.field === f.name);
    if (h) out[f.name] = h.value;
  }
  return out;
}

/** Probes need a resolved client write with a concrete-able path. */
export function probeable(s: AccessSite): boolean {
  if (s.service === 'storage' || !isWriteOp(s.op) || s.resolution === 'unresolved' || !s.path || s.path.includes('=**') || s.op === 'transaction') {
    return false;
  }
  // A path with no literal segment (a bare parameter) can't be addressed.
  return parseResourcePattern(s.service, s.path).segments.some((x) => x.kind === 'lit');
}

/**
 * Share what the sites of one record know about its uid-keyed segments: a
 * cleanup at `userinfo/$uid/...` keys by the same uid its create does, even
 * when its own trace lost that.
 */
export function shareUidVariables(sites: AccessSite[]): AccessSite[] {
  const known = new Map<string, Map<number, NonNullable<AccessSite['pathVariables']>[number]>>();
  for (const s of sites) {
    if (!s.path) continue;
    const key = resourceShapeKey(parseResourcePattern(s.service, s.path));
    const m = known.get(key) ?? new Map();
    (s.pathVariables ?? []).forEach((v, i) => {
      if (v.auth?.some((a) => a.source === 'auth.uid') && !m.has(i)) m.set(i, v);
    });
    known.set(key, m);
  }
  return sites.map((s) => {
    if (!s.path || !s.pathVariables) return s;
    const m = known.get(resourceShapeKey(parseResourcePattern(s.service, s.path)));
    if (!m || m.size === 0) return s;
    const vars = s.pathVariables.map((v, i) => {
      if (v.auth?.some((a) => a.source === 'auth.uid') || !m.has(i)) return v;
      const shared = m.get(i)!;
      const next: NonNullable<AccessSite['pathVariables']>[number] = { ...v, auth: shared.auth };
      if (shared.pattern) next.pattern = shared.pattern;
      return next;
    });
    return { ...s, pathVariables: vars };
  });
}

export function isCleanup(s: AccessSite): boolean {
  if (s.op === 'remove' || s.op === 'deleteDoc' || s.op === 'onDisconnect.remove') return true;
  return (s.op === 'set' || s.op === 'onDisconnect.set' || s.op === 'setDoc') && s.payload?.kind === 'null';
}

export function sep(s: AccessSite): string {
  return s.service === 'firestore' ? '.' : '/';
}

/** The step a client write performs, for an actor. `keyActor` fills uid-keyed path segments. */
export function stepFor(
  site: AccessSite,
  actor: 'owner' | 'peer',
  actors: { owner: ProbeActor; peer: ProbeActor },
  options: {
    keyActor?: ProbeActor;
    variant?: string;
    overrides?: Record<string, unknown>;
    pathSite?: AccessSite;
    state?: WorldState;
    otherUid?: string;
  } = {},
): ProbeStep {
  const who = actors[actor];
  // Another write's payload at this site's record: the path comes from `pathSite`.
  const path = concretePath(options.pathSite ?? site, who, {
    keyActor: options.keyActor ?? who,
    variant: options.variant,
    state: options.state,
    otherUid: options.otherUid,
  });
  const data = concretePayload(site.payload, who, sep(site), options.overrides ?? {});
  const base = { actor, service: site.service, path } as const;
  if (isCleanup(site)) {
    const method = site.service === 'firestore' ? 'delete' : 'remove';
    return { ...base, method };
  }
  if (site.service === 'rtdb') {
    if (site.multiPath) return { ...base, path: '', method: 'update', data: { [path]: data } };
    if ((site.op === 'update' || site.op === 'onDisconnect.update') && data && typeof data === 'object' && !Array.isArray(data)) {
      return { ...base, method: 'update', data };
    }
    return { ...base, method: 'set', data };
  }
  if (site.op === 'updateDoc') return { ...base, method: 'update', data };
  if (site.op === 'addDoc') return { ...base, method: 'create', data };
  const setStep: ProbeStep = { ...base, method: 'set', data };
  if (site.payload?.merge) setStep.merge = true;
  return setStep;
}

export function same(a: AccessSite, b: AccessSite): boolean {
  if (a.service !== b.service) return false;
  return (
    resourceShapeKey(parseResourcePattern(a.service, a.path))
    === resourceShapeKey(parseResourcePattern(b.service, b.path))
  );
}

function setOwnOverride(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function normalizeConditionFieldPath(fieldPath: string, separator: string): string {
  if (fieldPath === '.') return '.';
  return fieldPath
    .split(/[/.]/)
    .filter((seg) => seg.length > 0)
    .join(separator);
}

function hasExplicitPayloadField(payload: AccessSite['payload'], normField: string, separator: string): boolean {
  if (!payload) return false;
  if (normField === '.') {
    if (payload.kind !== 'object') {
      return payload.literal !== undefined || (payload.auth?.length ?? 0) > 0;
    }
    return payload.fields.some((f) => !f.optional);
  }
  if (payload.kind !== 'object') return true;
  for (const f of payload.fields) {
    if (f.optional) continue;
    const fNorm = normalizeConditionFieldPath(f.name, separator);
    if (fNorm === normField) return true;
    if (fNorm.startsWith(`${normField}${separator}`)) return true;
    if (normField.startsWith(`${fNorm}${separator}`) && f.kind !== 'object') return true;
  }
  return false;
}

function isPartialCreatorSite(make: AccessSite): boolean {
  if (make.op === 'updateDoc' || make.op === 'update' || make.op === 'onDisconnect.update') return true;
  if (make.op === 'setDoc' && Boolean(make.payload?.merge)) return true;
  return false;
}

function conditionAppliesToCreatorSetup(
  site: AccessSite,
  c: OwnerCondition,
  sitePattern: ReturnType<typeof parseResourcePattern>,
  partialMake: boolean,
): boolean {
  if (c.service !== site.service || !c.ops || c.ops.length === 0) return false;
  const cascade = c.service === 'rtdb' && !c.ops.every((op) => op === 'validate');
  if (!coversPattern(parseResourcePattern(c.service, c.path), sitePattern, { cascade })) return false;

  if (c.service === 'firestore') {
    if (c.kind !== 'incomingField' && c.kind !== 'storedField') return false;
    if (c.ops.includes('create')) return true;
    if (!partialMake) return false;
    if (opOf(site) === 'update' && c.ops.includes('update')) return true;
    if (isCleanup(site) && c.ops.includes('delete')) return true;
    return false;
  }

  if (c.service === 'rtdb') {
    if (!c.ops.includes('write') && !c.ops.includes('validate')) return false;
    if (c.kind === 'incomingField') return true;
    if (c.kind === 'storedField') return partialMake;
    if (c.kind === 'lookup') return partialMake || c.expression.includes('newData');
  }

  return false;
}

function extractSetupOverride(
  site: AccessSite,
  make: AccessSite,
  c: OwnerCondition,
  ownerUid: string,
  separator: string,
): { fieldPath: string; value: unknown } | null {
  const buildKeyedMap = (seedVal: unknown = true): Record<string, unknown> => {
    const mapVal: Record<string, unknown> = {};
    setOwnOverride(mapVal, ownerUid, seedVal);
    return mapVal;
  };

  if (c.kind === 'lookup') {
    if (c.service !== 'rtdb') return null;
    const makePattern = parseResourcePattern('rtdb', make.path);
    const lookupPattern = parseResourcePattern('rtdb', c.field.split('#')[0]!);
    const lastSeg = lookupPattern.segments.at(-1);
    if (
      lookupPattern.segments.length <= makePattern.segments.length
      || !lastSeg
      || lastSeg.kind !== 'var'
      || lastSeg.name !== 'auth.uid'
      || !coversPattern(makePattern, lookupPattern, { cascade: true })
    ) {
      return null;
    }
    const relSegs = lookupPattern.segments.slice(makePattern.segments.length, -1);
    if (relSegs.some((seg) => seg.kind !== 'lit')) return null;
    const fieldPath = relSegs.length === 0 ? '.' : relSegs.map((seg) => (seg as { kind: 'lit'; text: string }).text).join(separator);
    return { fieldPath, value: buildKeyedMap(c.seedValue ?? true) };
  }

  if (c.kind !== 'incomingField' && c.kind !== 'storedField') return null;

  let rawField: string;
  if (c.service === 'rtdb' && c.location) {
    const makePattern = parseResourcePattern('rtdb', make.path);
    const locPattern = parseResourcePattern('rtdb', c.location);
    if (locPattern.segments.length === makePattern.segments.length && coversPattern(makePattern, locPattern)) {
      rawField = '.';
    } else if (
      locPattern.segments.length > makePattern.segments.length
      && coversPattern(makePattern, locPattern, { cascade: true })
    ) {
      const relSegs = locPattern.segments.slice(makePattern.segments.length);
      if (relSegs.some((seg) => seg.kind !== 'lit')) return null;
      rawField = relSegs.map((seg) => (seg as { kind: 'lit'; text: string }).text).join('/');
    } else {
      return null;
    }
  } else {
    if (c.field.startsWith('../') && same(make, site)) return null;
    rawField = c.field.replace(/^(?:\.\.\/)+/, '');
  }

  let forceKeyedMap = false;
  if (rawField.endsWith('/{auth.uid}') || rawField.endsWith('.{auth.uid}')) {
    rawField = rawField.slice(0, -'/{auth.uid}'.length);
    forceKeyedMap = true;
  }

  const fieldPath = normalizeConditionFieldPath(rawField, separator);
  if (!fieldPath) return null;

  let value: unknown;
  if (forceKeyedMap || c.relation === 'exists' || (c.relation === 'contains' && c.expression.includes('.keys()'))) {
    value = buildKeyedMap(c.seedValue ?? true);
  } else if (c.relation === 'contains') {
    value = [ownerUid];
  } else {
    value = ownerUid;
  }

  return { fieldPath, value };
}

/**
 * Synthesize missing owner-condition field overrides needed for `make` to seed
 * a valid owned record for `site`, without overwriting explicit fields already
 * present on `make.payload`.
 */
export function setupConditionOverrides(
  site: AccessSite,
  make: AccessSite,
  conditions: OwnerCondition[],
  ownerUid: string,
): Record<string, unknown> {
  const sitePattern = parseResourcePattern(site.service, site.path);
  const separator = sep(make);
  const partialMake = isPartialCreatorSite(make);
  const overrides: Record<string, unknown> = {};

  for (const c of conditions) {
    if (!conditionAppliesToCreatorSetup(site, c, sitePattern, partialMake)) continue;
    const extracted = extractSetupOverride(site, make, c, ownerUid, separator);
    if (!extracted) continue;
    const { fieldPath, value } = extracted;
    if (Object.hasOwn(overrides, fieldPath)) continue;
    if (hasExplicitPayloadField(make.payload, fieldPath, separator)) continue;
    const conflictsExistingOverride = Object.keys(overrides).some(
      (existing) =>
        existing.startsWith(`${fieldPath}${separator}`)
        || fieldPath.startsWith(`${existing}${separator}`),
    );
    if (conflictsExistingOverride) continue;
    setOwnOverride(overrides, fieldPath, value);
  }

  return overrides;
}

/** The write that best creates a record at a site's template: the non-cleanup write with the most fields. */
export function creator(site: AccessSite, sites: AccessSite[]): AccessSite | undefined {
  let candidates = sites.filter((s) => probeable(s) && same(s, site) && !isCleanup(s) && s.op !== 'updateDoc' && s.op !== 'update' && s.op !== 'onDisconnect.update');
  if (candidates.length === 0) candidates = sites.filter((s) => probeable(s) && same(s, site) && !isCleanup(s));
  if (candidates.length === 0) {
    const sitePattern = parseResourcePattern(site.service, site.path);
    candidates = sites.filter(
      (s) =>
        probeable(s)
        && !isCleanup(s)
        && coversPattern(parseResourcePattern(s.service, s.path), sitePattern, { cascade: true }),
    );
  }
  return candidates.sort((a, b) => {
    const aUid = uidFields(a.payload).length;
    const bUid = uidFields(b.payload).length;
    if (aUid !== bUid) return bUid - aUid;
    const aSet = a.op === 'setDoc' || a.op === 'set' ? 1 : 0;
    const bSet = b.op === 'setDoc' || b.op === 'set' ? 1 : 0;
    if (aSet !== bSet) return bSet - aSet;
    return (b.payload?.fields.length ?? 0) - (a.payload?.fields.length ?? 0);
  })[0];
}

/** Cleanup writes in the same scope (a shared prefix holding a variable), on other records. */
export function siblingsOf(site: AccessSite, sites: AccessSite[]): AccessSite[] {
  const sitePattern = parseResourcePattern(site.service, site.path);
  const t = sitePattern.segments;
  return sites.filter((s) => {
    if (!probeable(s) || !isCleanup(s) || s.service !== site.service || same(s, site)) return false;
    const otherPattern = parseResourcePattern(s.service, s.path);
    if (otherPattern.resourceId !== sitePattern.resourceId) return false;
    const o = otherPattern.segments;
    let common = 0;
    while (common < t.length && common < o.length && segEq(t[common]!, o[common]!)) common++;
    // Same scope: a shared prefix that holds a variable (the scope id) and ends in a literal (the feature), as
    // `rooms/$id/call` for `call/participants/$me` and `call/signals/$me/$peer`.
    return common >= 2 && t.slice(0, common).some((x) => x.kind !== 'lit') && t[common - 1]!.kind === 'lit';
  });
}

function segEq(a: PatternSegment, b: PatternSegment): boolean {
  if (a.kind === 'lit' || b.kind === 'lit') return a.kind === b.kind && a.kind === 'lit' && b.kind === 'lit' && a.text === b.text;
  return true;
}

export function dedupeSites(sites: AccessSite[]): AccessSite[] {
  const byKey = new Map<string, AccessSite>();
  for (const s of sites) {
    let multiTag = '';
    if (s.multiPath) multiTag = 'm';
    const fieldsTag = (s.payload?.fields ?? []).map((f) => f.name).sort().join(',');
    const key = `${resourceShapeKey(parseResourcePattern(s.service, s.path))}|${s.op}|${multiTag}|${fieldsTag}`;
    const prev = byKey.get(key);
    if (!prev || (prev.resolution !== 'resolved' && s.resolution === 'resolved')) byKey.set(key, s);
  }
  return [...byKey.values()];
}

export function opOf(site: AccessSite): FindingOp {
  if (isCleanup(site)) return 'delete';
  if (site.op === 'update' || site.op === 'updateDoc' || site.op === 'onDisconnect.update') return 'update';
  return 'create';
}
