/**
 * Disjunctive Storage rule constraint arm selection, merging, and HTTP metadata
 * header synthesis for Cloud Storage assurance probes.
 */
import type { AccessSite, StorageHttpHeaderKey } from '../code/types.js';
import type {
  RuleSurfaceEntry,
  StorageMetadataConstraint,
} from '../rules/rule-surface.js';
import { classifyOmittedClientHttpHeader } from '../rules/storage-constraint-ast.js';
import {
  mergeConjunctLists,
  STORAGE_HTTP_HEADER_KEYS,
} from '../rules/storage-constraint-summary.js';
import {
  contentTypeMatchesPattern,
  expandPatternCandidates,
  normalizeContentTypeConjuncts,
  safeMatchesStorageRegex,
  STORAGE_UPDATE_OPS,
  synthesizeMatchingContentType,
} from './storage-step-builder.js';

const CANDIDATE_HTTP_HEADER_VALUES: Readonly<Record<StorageHttpHeaderKey, readonly string[]>> = {
  cacheControl: ['public, max-age=3600', 'no-cache', 'private, no-store', 'max-age=0'],
  contentDisposition: ['inline', 'attachment', 'attachment; filename="item.bin"'],
  contentEncoding: ['identity', 'gzip', 'br', 'deflate'],
  contentLanguage: ['en', 'en-US', 'de', 'fr'],
};

export function httpHeaderMatchesConjuncts(
  value: string,
  conjuncts: readonly (readonly string[])[] | undefined,
): boolean {
  if (!conjuncts || conjuncts.length === 0) return true;
  return conjuncts.every((disjuncts) =>
    disjuncts.some((pat) => safeMatchesStorageRegex(pat, value) === true),
  );
}

export function synthesizeMatchingHttpHeader(
  key: StorageHttpHeaderKey,
  conjuncts: readonly (readonly string[])[] | undefined,
): string | undefined {
  if (!conjuncts || conjuncts.length === 0) return undefined;
  for (const candidate of CANDIDATE_HTTP_HEADER_VALUES[key]) {
    if (httpHeaderMatchesConjuncts(candidate, conjuncts)) return candidate;
  }
  for (const expanded of expandPatternCandidates(conjuncts)) {
    if (httpHeaderMatchesConjuncts(expanded, conjuncts)) return expanded;
  }
  return CANDIDATE_HTTP_HEADER_VALUES[key][0];
}

function formatDisjunctGroup(disjuncts: readonly string[]): string {
  if (disjuncts.length === 1) return disjuncts[0]!;
  return `(?:${disjuncts.join('|')})`;
}

function distributeDisjunctiveConjunctLists(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[],
): (readonly string[])[] | null {
  const out: (readonly string[])[] = [];
  const seen = new Set<string>();
  for (const lDisjuncts of left) {
    for (const rDisjuncts of right) {
      const mergedDisjuncts: string[] = [];
      for (const pat of [...lDisjuncts, ...rDisjuncts]) {
        if (!mergedDisjuncts.includes(pat)) mergedDisjuncts.push(pat);
      }
      const sig = mergedDisjuncts.join('||');
      if (!seen.has(sig)) {
        seen.add(sig);
        out.push(mergedDisjuncts);
        if (out.length > 32) return null;
      }
    }
  }
  return out;
}

function collectStorageConstraintArms(
  entries: readonly RuleSurfaceEntry[],
): StorageMetadataConstraint[] {
  const permissive = entries.filter((entry) => entry.alwaysDeny !== true);
  if (permissive.length === 0) return [];
  const arms: StorageMetadataConstraint[] = [];
  for (const entry of permissive) {
    if (entry.storageMetadataArms && entry.storageMetadataArms.length > 0) {
      for (const arm of entry.storageMetadataArms) {
        arms.push(arm);
        if (arms.length >= 32) return arms;
      }
    } else if (entry.storageMetadata) {
      arms.push(entry.storageMetadata);
      if (arms.length >= 32) return arms;
    } else {
      arms.push({});
      if (arms.length >= 32) return arms;
    }
  }
  return arms;
}

export function mergedStorageConstraint(
  entries: readonly RuleSurfaceEntry[],
): StorageMetadataConstraint {
  const arms = collectStorageConstraintArms(entries);
  if (arms.length === 0) return {};
  if (arms.length === 1) return arms[0]!;

  let disjunctiveConjuncts: (readonly string[])[] | null = null;
  let allConstrainMime = true;
  for (const arm of arms) {
    const norm = normalizeContentTypeConjuncts(arm.contentTypePattern, arm.contentTypeConjuncts);
    if (norm.length === 0) {
      allConstrainMime = false;
      break;
    }
    if (disjunctiveConjuncts === null) {
      disjunctiveConjuncts = norm.map((d) => [...d]);
    } else {
      disjunctiveConjuncts = distributeDisjunctiveConjunctLists(disjunctiveConjuncts, norm);
      if (disjunctiveConjuncts === null) {
        allConstrainMime = false;
        break;
      }
    }
  }

  let minSizeBytes: number | undefined;
  if (arms.every((arm) => arm.minSizeBytes !== undefined)) {
    minSizeBytes = Math.min(...arms.map((arm) => arm.minSizeBytes!));
  }
  let maxSizeBytes: number | undefined;
  if (arms.every((arm) => arm.maxSizeBytes !== undefined)) {
    maxSizeBytes = Math.max(...arms.map((arm) => arm.maxSizeBytes!));
  }

  let intersectedKeys: string[] | undefined;
  for (const arm of arms) {
    const armKeys = arm.requiredCustomMetadataKeys ?? [];
    if (intersectedKeys === undefined) intersectedKeys = [...armKeys];
    else intersectedKeys = intersectedKeys.filter((k) => armKeys.includes(k));
  }

  const firstOwnerKey = arms[0]!.ownerMetadataKey;
  let ownerMetadataKey: string | undefined;
  if (firstOwnerKey !== undefined && arms.every((arm) => arm.ownerMetadataKey === firstOwnerKey)) {
    ownerMetadataKey = firstOwnerKey;
  }

  const mergedHttp: Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>> = {};
  let hasMergedHttp = false;
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    let acc: (readonly string[])[] | null = null;
    let allHave = true;
    for (const arm of arms) {
      const c = arm.httpHeaders?.[key];
      if (!c || c.length === 0) {
        allHave = false;
        break;
      }
      if (acc === null) acc = c.map((d) => [...d]);
      else {
        acc = distributeDisjunctiveConjunctLists(acc, c);
        if (acc === null) {
          allHave = false;
          break;
        }
      }
    }
    if (allHave && acc !== null && acc.length > 0) {
      mergedHttp[key] = acc;
      hasMergedHttp = true;
    }
  }

  const out: {
    contentTypePattern?: string;
    contentTypeConjuncts?: readonly (readonly string[])[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    requiredCustomMetadataKeys?: readonly string[];
    ownerMetadataKey?: string;
    httpHeaders?: Readonly<Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>>>;
  } = {};
  if (allConstrainMime && disjunctiveConjuncts !== null && disjunctiveConjuncts.length > 0) {
    out.contentTypePattern = disjunctiveConjuncts.map(formatDisjunctGroup).join(' && ');
    if (
      disjunctiveConjuncts.length > 1
      || disjunctiveConjuncts.some((disjuncts) => disjuncts.length > 1)
    ) {
      out.contentTypeConjuncts = disjunctiveConjuncts;
    }
  }
  if (minSizeBytes !== undefined) out.minSizeBytes = minSizeBytes;
  if (maxSizeBytes !== undefined) out.maxSizeBytes = maxSizeBytes;
  if (intersectedKeys && intersectedKeys.length > 0) out.requiredCustomMetadataKeys = intersectedKeys;
  if (ownerMetadataKey !== undefined) out.ownerMetadataKey = ownerMetadataKey;
  if (hasMergedHttp) out.httpHeaders = mergedHttp;
  return out;
}

function isArmSynthesizable(arm: StorageMetadataConstraint): boolean {
  if (
    arm.minSizeBytes !== undefined
    && arm.maxSizeBytes !== undefined
    && arm.minSizeBytes > arm.maxSizeBytes
  ) {
    return false;
  }
  const synthMime = synthesizeMatchingContentType(arm.contentTypePattern, arm.contentTypeConjuncts);
  if (!contentTypeMatchesPattern(synthMime, arm.contentTypePattern, arm.contentTypeConjuncts)) {
    return false;
  }
  const nullSet = new Set<StorageHttpHeaderKey>(arm.nullHttpHeaders ?? []);
  if (nullSet.has('contentEncoding')) return false;
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const conjuncts = arm.httpHeaders?.[key];
    if (!conjuncts || conjuncts.length === 0) continue;
    if (nullSet.has(key)) return false;
    const synthHeader = synthesizeMatchingHttpHeader(key, conjuncts);
    if (synthHeader === undefined || !httpHeaderMatchesConjuncts(synthHeader, conjuncts)) {
      return false;
    }
  }
  return true;
}

function siteStaticHttpCompatibleWithArm(
  site: AccessSite,
  arm: StorageMetadataConstraint,
): boolean {
  const up = site.storageUpload;
  const isUpdate = STORAGE_UPDATE_OPS.has(site.op);
  const nullSet = new Set<StorageHttpHeaderKey>(arm.nullHttpHeaders ?? []);
  const matchesStoragePat = (val: string, pat: string): boolean =>
    safeMatchesStorageRegex(pat, val) === true;

  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const actual = up?.[key];
    const isFieldUnresolved = Boolean(
      up?.httpMetadataUnresolvedFields?.includes(key)
        || (actual === undefined && (up?.customMetadataOpen === true || up?.customMetadataUnresolved === true)),
    );
    const conjuncts = arm.httpHeaders?.[key];
    if (nullSet.has(key)) {
      if (actual !== undefined || key === 'contentEncoding') return false;
      if (isFieldUnresolved) continue;
      const omittedVerdict = classifyOmittedClientHttpHeader(
        key,
        site,
        isUpdate,
        true,
        conjuncts,
        matchesStoragePat,
      );
      if (omittedVerdict === 'mismatched') return false;
      continue;
    }
    if (!conjuncts || conjuncts.length === 0) continue;
    if (isFieldUnresolved) continue;
    if (actual !== undefined) {
      if (!httpHeaderMatchesConjuncts(actual, conjuncts)) return false;
      continue;
    }
    const omittedVerdict = classifyOmittedClientHttpHeader(
      key,
      site,
      isUpdate,
      false,
      conjuncts,
      matchesStoragePat,
    );
    if (omittedVerdict === 'mismatched') return false;
  }
  return true;
}

function siteCompatibleWithArm(site: AccessSite, arm: StorageMetadataConstraint): boolean {
  const up = site.storageUpload;
  if (up) {
    if (
      up.contentType !== undefined
      && !contentTypeMatchesPattern(up.contentType, arm.contentTypePattern, arm.contentTypeConjuncts)
    ) {
      return false;
    }
    if (up.sizeBytes !== undefined) {
      if (arm.minSizeBytes !== undefined && up.sizeBytes < arm.minSizeBytes) return false;
      if (arm.maxSizeBytes !== undefined && up.sizeBytes > arm.maxSizeBytes) return false;
    }
    if (
      up.customMetadataKeys !== undefined
      && !up.customMetadataOpen
      && !up.customMetadataUnresolved
    ) {
      for (const reqKey of arm.requiredCustomMetadataKeys ?? []) {
        if (!up.customMetadataKeys.includes(reqKey)) return false;
      }
    }
  }
  return siteStaticHttpCompatibleWithArm(site, arm);
}

export function siteHasStaticHttpHeaderViolation(
  site: AccessSite,
  entries: readonly RuleSurfaceEntry[],
): boolean {
  const arms = collectStorageConstraintArms(entries);
  if (arms.length === 0) return false;
  return arms.every((arm) => !siteStaticHttpCompatibleWithArm(site, arm));
}

export function selectStorageConstraintForSite(
  entries: readonly RuleSurfaceEntry[],
  site: AccessSite,
): StorageMetadataConstraint {
  const arms = collectStorageConstraintArms(entries);
  if (arms.length === 0) return {};
  if (arms.length === 1) return arms[0]!;
  const matchingClient = arms.find(
    (arm) => isArmSynthesizable(arm) && siteCompatibleWithArm(site, arm),
  );
  if (matchingClient) return matchingClient;
  const firstValid = arms.find(isArmSynthesizable);
  if (firstValid) return firstValid;
  return mergedStorageConstraint(entries);
}

function constraintArmKey(arm: StorageMetadataConstraint): string {
  const ct = normalizeContentTypeConjuncts(arm.contentTypePattern, arm.contentTypeConjuncts)
    .map((c) => c.join('||'))
    .join('&&');
  const sz = `${arm.minSizeBytes ?? ''}:${arm.maxSizeBytes ?? ''}`;
  const meta = (arm.requiredCustomMetadataKeys ?? []).join(',');
  const httpParts: string[] = [];
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const c = arm.httpHeaders?.[key];
    if (c && c.length > 0) httpParts.push(`${key}=${c.map((d) => d.join('||')).join('&&')}`);
  }
  const nullHttp = (arm.nullHttpHeaders ?? []).join(',');
  return `${ct}#${sz}#${meta}#${arm.ownerMetadataKey ?? ''}#${httpParts.join(';')}#${nullHttp}`;
}

export interface StorageAttackArmCandidate {
  readonly constraint: StorageMetadataConstraint;
  readonly allowsUpdate: boolean;
}

export function distinctSynthesizableStorageArms(
  entries: readonly RuleSurfaceEntry[],
  preferredFirst?: StorageMetadataConstraint,
): StorageAttackArmCandidate[] {
  const permissive = entries.filter((entry) => entry.alwaysDeny !== true);
  const raw: StorageAttackArmCandidate[] = [];
  const anyAllowsUpdate = permissive.some(
    (e) => e.ops.includes('write') || e.ops.includes('update'),
  );
  if (preferredFirst !== undefined && isArmSynthesizable(preferredFirst)) {
    raw.push({ constraint: preferredFirst, allowsUpdate: anyAllowsUpdate });
  }
  for (const entry of permissive) {
    const allowsUpdate = entry.ops.includes('write') || entry.ops.includes('update');
    let entryArms: readonly StorageMetadataConstraint[] = [{}];
    if (entry.storageMetadataArms && entry.storageMetadataArms.length > 0) {
      entryArms = entry.storageMetadataArms;
    } else if (entry.storageMetadata) {
      entryArms = [entry.storageMetadata];
    }
    for (const arm of entryArms) {
      if (isArmSynthesizable(arm)) {
        raw.push({ constraint: arm, allowsUpdate });
      }
    }
  }
  const seen = new Set<string>();
  const out: StorageAttackArmCandidate[] = [];
  for (const item of raw) {
    const sig = `${constraintArmKey(item.constraint)}|${item.allowsUpdate ? 'u' : 'c'}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(item);
      if (out.length >= 16) break;
    }
  }
  if (out.length === 0) {
    return [{ constraint: preferredFirst ?? {}, allowsUpdate: anyAllowsUpdate }];
  }
  return out;
}

export function mergeSeedStorageConstraint(
  createConstraint: StorageMetadataConstraint,
  opConstraint: StorageMetadataConstraint,
): StorageMetadataConstraint {
  const seedMimePattern = createConstraint.contentTypePattern ?? opConstraint.contentTypePattern;
  const seedMimeConjuncts = createConstraint.contentTypeConjuncts ?? opConstraint.contentTypeConjuncts;
  const mergedHttp: Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>> = {};
  let hasHttp = false;
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const fromCreate = createConstraint.httpHeaders?.[key];
    const fromOpStored = opConstraint.storedHttpHeaders?.[key];
    if (fromCreate && fromOpStored) {
      mergedHttp[key] = mergeConjunctLists(fromCreate, fromOpStored);
      hasHttp = true;
    } else if (fromCreate) {
      mergedHttp[key] = fromCreate;
      hasHttp = true;
    } else if (fromOpStored) {
      mergedHttp[key] = fromOpStored;
      hasHttp = true;
    }
  }
  const out: {
    contentTypePattern?: string;
    contentTypeConjuncts?: readonly (readonly string[])[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    requiredCustomMetadataKeys?: readonly string[];
    ownerMetadataKey?: string;
    httpHeaders?: Readonly<Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>>>;
    nullHttpHeaders?: readonly StorageHttpHeaderKey[];
  } = { ...createConstraint };
  if (seedMimePattern !== undefined) out.contentTypePattern = seedMimePattern;
  if (seedMimeConjuncts !== undefined) out.contentTypeConjuncts = seedMimeConjuncts;
  if (hasHttp) out.httpHeaders = mergedHttp;
  return out;
}
