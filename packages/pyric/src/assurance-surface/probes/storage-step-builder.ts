/**
 * Step construction, MIME/constraint synthesis, and path binding helpers for
 * Cloud Storage assurance probes.
 */
import { re2FullMatch } from '../../rules/simulator/rules-type.js';
import type { AccessSite } from '../code/types.js';
import {
  coversPattern,
  parseResourcePattern,
  resourceShapeKey,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type {
  CrossServiceLookup,
  RuleSurface,
  RuleSurfaceEntry,
  StorageMetadataConstraint,
} from '../rules/rule-surface.js';
import type { OwnerBinding } from '../rules/types.js';
import type { ValueHint } from '../rules/value-hints.js';
import { concretePath, concretePayload, fillTemplate } from './fixtures.js';
import { bindVarsFromCrossServiceState } from './prerequisites.js';
import type { FindingOp, ProbeActor, ProbeStep } from './types.js';
import type { WorldState } from './world.js';

const CANDIDATE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'video/mp4',
  'audio/mpeg',
  'application/zip',
  'application/octet-stream',
];

export const STORAGE_UPLOAD_OPS = new Set(['uploadBytes', 'uploadBytesResumable', 'uploadString', 'save']);
export const STORAGE_UPDATE_OPS = new Set(['updateMetadata', 'setMetadata']);
export const STORAGE_DELETE_OPS = new Set(['deleteObject', 'deleteFiles']);
export const STORAGE_LIST_OPS = new Set(['list', 'listAll', 'getFiles']);
export const STORAGE_READ_OPS = new Set([
  'getBytes',
  'getBlob',
  'getStream',
  'getDownloadURL',
  'getMetadata',
  'download',
  'list',
  'listAll',
  'getFiles',
]);

export function setStorageOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const SAMPLE_CHARS = [
  'a',
  '1',
  'A',
  'x',
  '0',
  '-',
  '_',
  '.',
  '+',
  '/',
  ' ',
];

function safeMatchesContentType(pattern: string, subject: string): boolean | null {
  try {
    return re2FullMatch(pattern, subject);
  } catch {
    try {
      return new RegExp(`^(?:${pattern})$`).test(subject);
    } catch {
      return null;
    }
  }
}

function sampleCharClass(charClass: string): string {
  if (safeMatchesContentType(charClass, '') === null) return 'x';
  for (const ch of SAMPLE_CHARS) {
    if (safeMatchesContentType(charClass, ch) === true) return ch;
  }
  for (let code = 32; code <= 126; code += 1) {
    const ch = String.fromCharCode(code);
    if (safeMatchesContentType(charClass, ch) === true) return ch;
  }
  return 'x';
}

function clampRepeatCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.min(parsed, 64);
}

/** True when `contentType` matches the Storage `.matches(...)` pattern (or when no pattern is set). */
export function contentTypeMatchesPattern(
  contentType: string,
  pattern: string | undefined,
): boolean {
  if (pattern === undefined || pattern.length === 0) return true;
  return safeMatchesContentType(pattern, contentType) === true;
}

function expandContentTypePatternVariant(
  pattern: string,
  options: { dropOptionalGroups: boolean; spaceStarAsSpace: boolean },
): string {
  let candidate = pattern
    .replace(/^(?:\\A|\^)+/, '')
    .replace(/(?:\\z|\$)+$/, '')
    .replace(/^\(\?[a-z-]+\)/i, '')
    .replace(/^(?:\\A|\^)+/, '')
    .replace(/(?:\\z|\$)+$/, '');
  if (options.dropOptionalGroups) {
    for (let i = 0; i < 6; i += 1) {
      const next = candidate.replace(/\((?:\?:)?[^()]*\)\?/g, '');
      if (next === candidate) break;
      candidate = next;
    }
  }
  for (let i = 0; i < 6; i += 1) {
    const next = candidate.replace(/\((?:\?:)?([^()|]+)(?:\|[^()]*)+\)/g, '($1)');
    if (next === candidate) break;
    candidate = next;
  }
  const spaceOptional = options.spaceStarAsSpace ? ' ' : '';
  return candidate
    .replace(
      /(\[\^\[:[^\]]+:\]\]|\[\[:[^\]]+:\]\]|\[\^[^\]]+\]|\[[^\]]+\])\{(\d+)(?:,\d*)?\}/g,
      (_m, cls: string, min: string) => sampleCharClass(cls).repeat(clampRepeatCount(min)),
    )
    .replace(/\\s\{(\d+)(?:,\d*)?\}/g, (_m, min: string) => ' '.repeat(clampRepeatCount(min)))
    .replace(/\\d\{(\d+)(?:,\d*)?\}/g, (_m, min: string) => '1'.repeat(clampRepeatCount(min)))
    .replace(/\\w\{(\d+)(?:,\d*)?\}/g, (_m, min: string) => 'a'.repeat(clampRepeatCount(min)))
    .replace(/\\(.)\{(\d+)(?:,\d*)?\}/g, (_m, ch: string, min: string) =>
      ch.repeat(clampRepeatCount(min)),
    )
    .replace(/\((?:\?:)?([^()]+)\)\{(\d+)(?:,\d*)?\}/g, (_m, grp: string, min: string) =>
      grp.repeat(clampRepeatCount(min)),
    )
    .replace(/\.{(\d+)(?:,\d*)?\}/g, (_m, min: string) => 'a'.repeat(clampRepeatCount(min)))
    .replace(/([^\\[\]()+*?{}])\{(\d+)(?:,\d*)?\}/g, (_m, ch: string, min: string) =>
      ch.repeat(clampRepeatCount(min)),
    )
    .replace(/\\s\+/g, ' ')
    .replace(/\\s\*/g, spaceOptional)
    .replace(/\\s\?/g, spaceOptional)
    .replace(/\\s/g, ' ')
    .replace(/\\d[+*]?/g, '1')
    .replace(/\\w[+*]?/g, 'a')
    .replace(
      /(\[\^\[:[^\]]+:\]\]|\[\[:[^\]]+:\]\]|\[\^[^\]]+\]|\[[^\]]+\])[+*]?/g,
      (_m, cls: string) => sampleCharClass(cls),
    )
    .replace(/(?<!\\)\.\+/g, 'a')
    .replace(/(?<!\\)\.\*/g, 'a')
    .replace(/(?<!\\)[?+*]/g, '')
    .replace(/(?<!\\)\(\?:/g, '(')
    .replace(/(?<!\\)[()]/g, '')
    .replace(/\\([./\-+?*()])/g, '$1');
}

/** Synthesize a concrete MIME `contentType` string satisfying a Storage `.matches(...)` regex. */
export function synthesizeMatchingContentType(pattern: string | undefined): string {
  if (pattern === undefined || pattern.length === 0) return 'application/octet-stream';
  if (safeMatchesContentType(pattern, '') === null) return 'application/octet-stream';
  for (const candidate of CANDIDATE_MIMES) {
    if (safeMatchesContentType(pattern, candidate) === true) return candidate;
  }
  const variants: Array<{ dropOptionalGroups: boolean; spaceStarAsSpace: boolean }> = [
    { dropOptionalGroups: false, spaceStarAsSpace: true },
    { dropOptionalGroups: true, spaceStarAsSpace: true },
    { dropOptionalGroups: false, spaceStarAsSpace: false },
    { dropOptionalGroups: true, spaceStarAsSpace: false },
  ];
  for (const variant of variants) {
    const candidate = expandContentTypePatternVariant(pattern, variant);
    if (safeMatchesContentType(pattern, candidate) === true) return candidate;
  }
  return 'application/octet-stream';
}

export function compliantByteSize(maxSizeBytes: number | undefined): number {
  if (maxSizeBytes === undefined) return 16;
  if (maxSizeBytes <= 0) return 0;
  return Math.max(1, Math.min(16, Math.floor(maxSizeBytes)));
}

export function mergedStorageConstraint(entries: readonly RuleSurfaceEntry[]): StorageMetadataConstraint {
  let contentTypePattern: string | undefined;
  let maxSizeBytes: number | undefined;
  const requiredKeys = new Set<string>();
  let ownerMetadataKey: string | undefined;

  for (const entry of entries) {
    const meta = entry.storageMetadata;
    if (!meta) continue;
    if (contentTypePattern === undefined && meta.contentTypePattern !== undefined) {
      contentTypePattern = meta.contentTypePattern;
    }
    if (meta.maxSizeBytes !== undefined) {
      if (maxSizeBytes === undefined || meta.maxSizeBytes < maxSizeBytes) {
        maxSizeBytes = meta.maxSizeBytes;
      }
    }
    for (const key of meta.requiredCustomMetadataKeys ?? []) requiredKeys.add(key);
    if (ownerMetadataKey === undefined && meta.ownerMetadataKey !== undefined) {
      ownerMetadataKey = meta.ownerMetadataKey;
    }
  }

  const out: {
    contentTypePattern?: string;
    maxSizeBytes?: number;
    requiredCustomMetadataKeys?: readonly string[];
    ownerMetadataKey?: string;
  } = {};
  if (contentTypePattern !== undefined) out.contentTypePattern = contentTypePattern;
  if (maxSizeBytes !== undefined) out.maxSizeBytes = maxSizeBytes;
  if (requiredKeys.size > 0) out.requiredCustomMetadataKeys = [...requiredKeys];
  if (ownerMetadataKey !== undefined) out.ownerMetadataKey = ownerMetadataKey;
  return out;
}

export function isProbeableStorageSite(site: AccessSite): boolean {
  if (site.admin || site.service !== 'storage' || site.resolution === 'unresolved') return false;
  if (site.path.includes('=**')) return false;
  if (STORAGE_LIST_OPS.has(site.op) && site.path === '') return true;
  if (!site.path) return false;
  return parseResourcePattern('storage', site.path, site.resourceId).segments.some(
    (seg) => seg.kind === 'lit',
  );
}

export function dedupeStorageSites(sites: readonly AccessSite[]): AccessSite[] {
  const byKey = new Map<string, AccessSite>();
  for (const site of sites) {
    const pattern = parseResourcePattern('storage', site.path, site.resourceId);
    const uploadSig = `${site.storageUpload?.contentType ?? ''}:${String(site.storageUpload?.sizeBytes ?? '')}`;
    const fieldsSig = (site.payload?.fields ?? []).map((f) => f.name).sort().join(',');
    const key = `${resourceShapeKey(pattern)}|${site.op}|${uploadSig}|${fieldsSig}`;
    if (!byKey.has(key)) byKey.set(key, site);
  }
  return [...byKey.values()];
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
    if (!hasExplicitBucket && b.wildcardBucket && sitePattern.resourceId !== '(default)') {
      bp = { ...bp, resourceId: sitePattern.resourceId };
    }
    return coversPattern(bp, sitePattern, { cascade: true }) || coversPattern(sitePattern, bp, { cascade: true });
  });
}

export function isExactUidAuth(auth: { source: string; certainty: 'exact' | 'partial' }[] | undefined): boolean {
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
      if (field.literal === undefined && !(field.auth?.length) && Object.hasOwn(hinted, field.name)) {
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
    if (field.literal === undefined && !(field.auth?.length) && Object.hasOwn(hinted, field.name)) {
      setStorageOwn(overrides, field.name, hinted[field.name]!);
    }
  }
  const raw = concretePayload(site.payload, actor, '.', overrides);
  return { metadata: stringifyMetadataRecord(raw), openMap: false };
}

export function attachResourceId(step: ProbeStep, resourceId: string | undefined): ProbeStep {
  if (resourceId === undefined || resourceId === '(default)') return step;
  return { ...step, resourceId };
}

export function storageOpCategory(site: AccessSite): FindingOp {
  if (STORAGE_DELETE_OPS.has(site.op)) return 'delete';
  if (STORAGE_UPDATE_OPS.has(site.op)) return 'update';
  if (STORAGE_READ_OPS.has(site.op)) return 'read';
  return 'create';
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
): ProbeStep {
  let contentType = synthesizeMatchingContentType(constraint.contentTypePattern);
  const clientMime = site.storageUpload?.contentType;
  if (
    clientMime !== undefined
    && contentTypeMatchesPattern(clientMime, constraint.contentTypePattern)
  ) {
    contentType = clientMime;
  }
  const step: ProbeStep = {
    actor: actorRole,
    service: 'storage',
    method: 'create',
    path,
    data: 'probe-bytes',
    sizeBytes: compliantByteSize(constraint.maxSizeBytes),
    contentType,
  };
  if (actorRole === 'admin') step.method = 'set';
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

export function buildCompliantUpdateStep(
  site: AccessSite,
  sitePattern: ResourcePattern,
  actorRole: 'owner' | 'peer',
  actorObj: ProbeActor,
  path: string,
  constraint: StorageMetadataConstraint,
  hints: readonly ValueHint[],
  surface?: RuleSurface,
): ProbeStep {
  const step: ProbeStep = {
    actor: actorRole,
    service: 'storage',
    method: 'update',
    path,
  };
  if (constraint.contentTypePattern !== undefined || site.storageUpload?.contentType !== undefined) {
    let contentType = synthesizeMatchingContentType(constraint.contentTypePattern);
    const clientMime = site.storageUpload?.contentType;
    if (
      clientMime !== undefined
      && contentTypeMatchesPattern(clientMime, constraint.contentTypePattern)
    ) {
      contentType = clientMime;
    }
    step.contentType = contentType;
  }
  const customMetadata = buildCompliantCustomMetadata(site, sitePattern, constraint, hints, actorObj, {}, surface);
  if (customMetadata !== undefined) step.customMetadata = customMetadata;
  return attachResourceId(step, site.resourceId);
}
