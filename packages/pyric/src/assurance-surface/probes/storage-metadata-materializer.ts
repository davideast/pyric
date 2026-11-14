/**
 * Path binding, customMetadata materialization, and compliant upload/update
 * `ProbeStep` construction for Cloud Storage assurance probes.
 */
import type { AccessSite, StorageHttpHeaderKey } from '../code/types.js';
import {
  coversPattern,
  parseResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type {
  CrossServiceLookup,
  RuleSurface,
  StorageMetadataConstraint,
} from '../rules/rule-surface.js';
import { STORAGE_HTTP_HEADER_KEYS } from '../rules/storage-constraint-summary.js';
import type { OwnerBinding } from '../rules/types.js';
import type { ValueHint } from '../rules/value-hints.js';
import { concretePath, concretePayload, fillTemplate } from './fixtures.js';
import { bindVarsFromCrossServiceState } from './prerequisites.js';
import {
  httpHeaderMatchesConjuncts,
  synthesizeMatchingHttpHeader,
} from './storage-constraint-arms.js';
import {
  compliantByteSize,
  contentTypeMatchesPattern,
  STORAGE_UPDATE_OPS,
  STORAGE_UPLOAD_OPS,
  synthesizeMatchingContentType,
} from './storage-step-builder.js';
import type { ProbeActor, ProbeStep } from './types.js';
import type { WorldState } from './world.js';

export function setStorageOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function surfaceHasExplicitBucket(surface: RuleSurface | undefined, bucket: string): boolean {
  if (!surface || bucket === '(default)') return false;
  return surface.entries.some(
    (e) =>
      e.pattern.service === 'storage'
      && !e.wildcardBucket
      && e.pattern.resourceId === bucket,
  );
}

export function storageBindingsAt(
  site: AccessSite,
  bindings: readonly OwnerBinding[],
  surface?: RuleSurface,
  defaultBucket?: string,
): OwnerBinding[] {
  const sitePattern = parseResourcePattern('storage', site.path, site.resourceId);
  const hasExplicitBucket =
    sitePattern.resourceId !== '(default)'
    && (surfaceHasExplicitBucket(surface, sitePattern.resourceId)
      || bindings.some(
        (b) =>
          b.service === 'storage'
          && !b.wildcardBucket
          && b.evidence !== 'code-only'
          && parseResourcePattern('storage', b.path).resourceId === sitePattern.resourceId,
      ));
  return bindings.filter((b) => {
    if (b.service !== 'storage') return false;
    let bp = parseResourcePattern('storage', b.path);
    if (
      sitePattern.resourceId === '(default)'
      && defaultBucket !== undefined
      && bp.resourceId === defaultBucket
    ) {
      bp = { ...bp, resourceId: '(default)' };
    } else if (!hasExplicitBucket && b.wildcardBucket && sitePattern.resourceId !== '(default)') {
      bp = { ...bp, resourceId: sitePattern.resourceId };
    }
    return (
      coversPattern(bp, sitePattern, { cascade: true })
      || coversPattern(sitePattern, bp, { cascade: true })
    );
  });
}

export function isExactUidAuth(
  auth: { source: string; certainty: 'exact' | 'partial' }[] | undefined,
): boolean {
  if (!auth || auth.length === 0) return false;
  return auth.every((a) => a.source === 'auth.uid' && a.certainty === 'exact');
}

function storageHintMap(
  sitePattern: ResourcePattern,
  hints: readonly ValueHint[],
  surface?: RuleSurface,
): Record<string, string> {
  const out: Record<string, string> = {};
  const hasExplicitBucket =
    sitePattern.resourceId !== '(default)'
    && (surfaceHasExplicitBucket(surface, sitePattern.resourceId)
      || hints.some(
        (h) =>
          h.service === 'storage'
          && !h.wildcardBucket
          && parseResourcePattern('storage', h.path).resourceId === sitePattern.resourceId,
      ));
  for (const h of hints) {
    if (h.service !== 'storage') continue;
    let hp = parseResourcePattern('storage', h.path);
    if (!hasExplicitBucket && h.wildcardBucket && sitePattern.resourceId !== '(default)') {
      hp = { ...hp, resourceId: sitePattern.resourceId };
    }
    if (!coversPattern(hp, sitePattern)) continue;
    const cleanKey = h.field.replace(/^metadata\./, '');
    if (!Object.hasOwn(out, cleanKey)) setStorageOwn(out, cleanKey, String(h.value));
  }
  return out;
}

function stringifyMetadataRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    setStorageOwn(out, k, String(v));
  }
  return out;
}

export function buildCompliantCustomMetadata(
  site: AccessSite,
  sitePattern: ResourcePattern,
  constraint: StorageMetadataConstraint,
  hints: readonly ValueHint[],
  actor: ProbeActor,
  overrides: Readonly<Record<string, string>> = {},
  surface?: RuleSurface,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const hinted = storageHintMap(sitePattern, hints, surface);
  if (site.payload && site.payload.kind === 'object') {
    const fieldOverrides: Record<string, unknown> = {};
    for (const field of site.payload.fields) {
      if (
        field.literal === undefined
        && !(field.auth?.length)
        && Object.hasOwn(hinted, field.name)
      ) {
        setStorageOwn(fieldOverrides, field.name, hinted[field.name]!);
      }
    }
    const raw = concretePayload(site.payload, actor, '.', fieldOverrides);
    Object.assign(out, stringifyMetadataRecord(raw));
  }
  for (const [k, v] of Object.entries(hinted)) {
    if (!Object.hasOwn(out, k)) setStorageOwn(out, k, v);
  }
  for (const reqKey of constraint.requiredCustomMetadataKeys ?? []) {
    if (!Object.hasOwn(out, reqKey)) {
      if (reqKey === constraint.ownerMetadataKey) setStorageOwn(out, reqKey, actor.uid);
      else setStorageOwn(out, reqKey, `v-${reqKey}`);
    }
  }
  if (constraint.ownerMetadataKey !== undefined && !Object.hasOwn(out, constraint.ownerMetadataKey)) {
    setStorageOwn(out, constraint.ownerMetadataKey, actor.uid);
  }
  for (const [k, v] of Object.entries(overrides)) setStorageOwn(out, k, v);
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

export function buildClientCustomMetadata(
  site: AccessSite,
  sitePattern: ResourcePattern,
  constraint: StorageMetadataConstraint,
  hints: readonly ValueHint[],
  actor: ProbeActor,
  surface?: RuleSurface,
): { metadata?: Record<string, string>; openMap: boolean } {
  if (STORAGE_UPLOAD_OPS.has(site.op) && site.storageUpload?.customMetadata === undefined) {
    return { openMap: false };
  }
  if (!site.payload || site.payload.kind !== 'object') return { openMap: false };
  if (site.payload.open) {
    return {
      metadata: buildCompliantCustomMetadata(site, sitePattern, constraint, hints, actor, {}, surface),
      openMap: true,
    };
  }
  const hinted = storageHintMap(sitePattern, hints, surface);
  const overrides: Record<string, unknown> = {};
  for (const field of site.payload.fields) {
    if (
      field.literal === undefined
      && !(field.auth?.length)
      && Object.hasOwn(hinted, field.name)
    ) {
      setStorageOwn(overrides, field.name, hinted[field.name]!);
    }
  }
  const raw = concretePayload(site.payload, actor, '.', overrides);
  return { metadata: stringifyMetadataRecord(raw), openMap: false };
}

export function applyClientHttpMetadataToStep(step: ProbeStep, site: AccessSite): void {
  const up = site.storageUpload;
  if (!up) return;
  if (up.cacheControl !== undefined) step.cacheControl = up.cacheControl;
  if (up.contentDisposition !== undefined) step.contentDisposition = up.contentDisposition;
  if (up.contentEncoding !== undefined) step.contentEncoding = up.contentEncoding;
  if (up.contentLanguage !== undefined) step.contentLanguage = up.contentLanguage;
}

function applyCompliantHttpMetadataToStep(
  step: ProbeStep,
  constraint: StorageMetadataConstraint,
  clientUpload: AccessSite['storageUpload'] | undefined,
  fallbackHeaders: Readonly<Partial<Record<StorageHttpHeaderKey, string>>> | undefined,
): void {
  const nullSet = new Set<StorageHttpHeaderKey>(constraint.nullHttpHeaders ?? []);
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    if (nullSet.has(key)) continue;
    const conjuncts = constraint.httpHeaders?.[key];
    let chosen: string | undefined;
    const clientVal = clientUpload?.[key];
    const fallbackVal = fallbackHeaders?.[key];
    if (clientVal !== undefined && httpHeaderMatchesConjuncts(clientVal, conjuncts)) {
      chosen = clientVal;
    } else if (fallbackVal !== undefined && httpHeaderMatchesConjuncts(fallbackVal, conjuncts)) {
      chosen = fallbackVal;
    } else if (conjuncts && conjuncts.length > 0) {
      chosen = synthesizeMatchingHttpHeader(key, conjuncts);
    }
    if (chosen !== undefined) step[key] = chosen;
  }
}

export function attachResourceId(step: ProbeStep, resourceId: string | undefined): ProbeStep {
  if (resourceId === undefined || resourceId === '(default)') return step;
  return { ...step, resourceId };
}

export function resolveStorageConcretePath(
  site: AccessSite,
  actor: ProbeActor,
  keyActor: ProbeActor,
  otherUid: string,
  rulePattern: ResourcePattern | undefined,
  lookups: readonly CrossServiceLookup[],
  state: WorldState | undefined,
  variant?: string,
  forceIsolatedScope = false,
): string {
  const uidVarNames = new Set(
    (site.pathVariables ?? [])
      .filter((v) => v.auth?.some((a) => a.source === 'auth.uid'))
      .map((v) => v.name),
  );
  const vars: Record<string, string> = {};
  if (!forceIsolatedScope) {
    Object.assign(vars, bindVarsFromCrossServiceState(site.path, rulePattern, lookups, actor, state));
  }
  for (const uidVar of uidVarNames) setStorageOwn(vars, uidVar, keyActor.uid);
  if (Object.keys(vars).length > 0 || forceIsolatedScope) {
    let suffix = '';
    if (variant) suffix = variant;
    let scopeSuffix = '';
    if (forceIsolatedScope) scopeSuffix = '-nonmember';
    let firstNonUidAssigned = false;
    return fillTemplate(
      site.path,
      vars,
      (name) => {
        if (!firstNonUidAssigned && scopeSuffix.length > 0) {
          firstNonUidAssigned = true;
          return `v-${name}${scopeSuffix}`;
        }
        return `v-${name}${suffix}`;
      },
      'storage',
    );
  }
  return concretePath(site, actor, { keyActor, variant, state, otherUid });
}

export interface CompliantUploadStepOptions {
  readonly useClientSiteMetadata?: boolean;
  readonly fallbackHttpHeaders?: Readonly<Partial<Record<StorageHttpHeaderKey, string>>>;
}

export function buildCompliantUploadStep(
  site: AccessSite,
  sitePattern: ResourcePattern,
  actorRole: 'owner' | 'peer' | 'admin',
  actorObj: ProbeActor,
  path: string,
  constraint: StorageMetadataConstraint,
  hints: readonly ValueHint[],
  metadataOverrides: Readonly<Record<string, string>> = {},
  surface?: RuleSurface,
  options?: CompliantUploadStepOptions,
): ProbeStep {
  const useClient = options?.useClientSiteMetadata ?? STORAGE_UPLOAD_OPS.has(site.op);
  let contentType = synthesizeMatchingContentType(
    constraint.contentTypePattern,
    constraint.contentTypeConjuncts,
  );
  const clientMime = useClient ? site.storageUpload?.contentType : undefined;
  if (
    clientMime !== undefined
    && contentTypeMatchesPattern(
      clientMime,
      constraint.contentTypePattern,
      constraint.contentTypeConjuncts,
    )
  ) {
    contentType = clientMime;
  }
  const step: ProbeStep = {
    actor: actorRole,
    service: 'storage',
    method: 'create',
    path,
    data: 'probe-bytes',
    sizeBytes: compliantByteSize(constraint.maxSizeBytes, constraint.minSizeBytes),
    contentType,
  };
  if (actorRole === 'admin') step.method = 'set';
  let clientUpload: typeof site.storageUpload;
  if (useClient) {
    clientUpload = site.storageUpload;
  }
  applyCompliantHttpMetadataToStep(
    step,
    constraint,
    clientUpload,
    options?.fallbackHttpHeaders,
  );
  const customMetadata = buildCompliantCustomMetadata(
    site,
    sitePattern,
    constraint,
    hints,
    actorObj,
    metadataOverrides,
    surface,
  );
  if (customMetadata !== undefined) step.customMetadata = customMetadata;
  return attachResourceId(step, site.resourceId);
}

export function peerPathInSameScope(
  sitePath: string,
  isolatedPath: string,
  peerSuffix: string,
): string {
  const siteSegs = parseResourcePattern('storage', sitePath).segments;
  const concreteSegs = isolatedPath.split('/').filter((s) => s.length > 0);
  if (siteSegs.length !== concreteSegs.length) return isolatedPath;
  const varIndices: number[] = [];
  siteSegs.forEach((seg, idx) => {
    if (seg.kind === 'var') varIndices.push(idx);
  });
  if (varIndices.length < 2) return isolatedPath;
  const lastIdx = varIndices[varIndices.length - 1]!;
  const leafSeg = siteSegs[lastIdx];
  const currentLeaf = concreteSegs[lastIdx]!;
  if (leafSeg?.kind === 'var' && leafSeg.suffix && currentLeaf.endsWith(leafSeg.suffix)) {
    const stem = currentLeaf.slice(0, currentLeaf.length - leafSeg.suffix.length);
    concreteSegs[lastIdx] = `${stem}${peerSuffix}${leafSeg.suffix}`;
  } else {
    concreteSegs[lastIdx] = `${currentLeaf}${peerSuffix}`;
  }
  return concreteSegs.join('/');
}

interface CompliantUpdateStepOptions {
  readonly useClientSiteMetadata?: boolean;
  readonly metadataOverrides?: Readonly<Record<string, string>>;
}

export function buildCompliantUpdateStep(
  site: AccessSite,
  sitePattern: ResourcePattern,
  actorRole: 'owner' | 'peer',
  actorObj: ProbeActor,
  path: string,
  constraint: StorageMetadataConstraint,
  hints: readonly ValueHint[],
  surface?: RuleSurface,
  options?: CompliantUpdateStepOptions,
): ProbeStep {
  const useClient = options?.useClientSiteMetadata ?? STORAGE_UPDATE_OPS.has(site.op);
  let clientUpload: AccessSite['storageUpload'] | undefined;
  if (useClient) clientUpload = site.storageUpload;
  const step: ProbeStep = {
    actor: actorRole,
    service: 'storage',
    method: 'update',
    path,
  };
  if (
    constraint.contentTypePattern !== undefined
    || constraint.contentTypeConjuncts !== undefined
    || clientUpload?.contentType !== undefined
  ) {
    let contentType = synthesizeMatchingContentType(
      constraint.contentTypePattern,
      constraint.contentTypeConjuncts,
    );
    const clientMime = clientUpload?.contentType;
    if (
      clientMime !== undefined
      && contentTypeMatchesPattern(
        clientMime,
        constraint.contentTypePattern,
        constraint.contentTypeConjuncts,
      )
    ) {
      contentType = clientMime;
    }
    step.contentType = contentType;
  }
  applyCompliantHttpMetadataToStep(step, constraint, clientUpload, undefined);
  const customMetadata = buildCompliantCustomMetadata(
    site,
    sitePattern,
    constraint,
    hints,
    actorObj,
    options?.metadataOverrides ?? {},
    surface,
  );
  if (customMetadata !== undefined) step.customMetadata = customMetadata;
  return attachResourceId(step, site.resourceId);
}
