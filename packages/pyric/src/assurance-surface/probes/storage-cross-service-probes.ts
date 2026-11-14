/**
 * Seeded Storage object compatibility checks and Family 5 cross-service
 * non-member Storage probe construction (`firestore.get()` / `firestore.exists()`).
 */
import type { SnapshotStorageObject } from 'pyric/sandbox/internal';
import type { ResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import type { AccessSite, StorageHttpHeaderKey } from '../code/types.js';
import type {
  CrossServiceLookup,
  RuleSurface,
  RuleSurfaceEntry,
  StorageMetadataConstraint,
} from '../rules/rule-surface.js';
import { STORAGE_HTTP_HEADER_KEYS } from '../rules/storage-constraint-summary.js';
import type { ValueHint } from '../rules/value-hints.js';
import type { PlanInput } from './plan.js';
import { crossServiceLookupSeeds } from './prerequisites.js';
import {
  distinctSynthesizableStorageArms,
  httpHeaderMatchesConjuncts,
  mergeSeedStorageConstraint,
} from './storage-constraint-arms.js';
import {
  attachResourceId,
  buildCompliantUpdateStep,
  buildCompliantUploadStep,
  peerPathInSameScope,
  resolveStorageConcretePath,
} from './storage-metadata-materializer.js';
import {
  dedupeLookups,
  peerHasLiveMembershipAtPath,
} from './storage-scope-lookup.js';
import {
  contentTypeMatchesPattern,
  STORAGE_LIST_OPS,
  STORAGE_READ_OPS,
  STORAGE_UPDATE_OPS,
  STORAGE_UPLOAD_OPS,
} from './storage-step-builder.js';
import type { Probe } from './types.js';
import type { WorldState } from './world.js';
import { normalizeStorageBucketKey } from './world-storage.js';

export function hasCompatibleSeededStorageObject(
  state: WorldState | undefined,
  resourceId: string | undefined,
  objectPath: string,
  ownerUid: string,
  constraint: StorageMetadataConstraint,
  payloadOwnerFields: Iterable<string>,
): boolean {
  if (!state) return false;
  const bucketKey = normalizeStorageBucketKey(resourceId) ?? '(default)';
  const candidates: SnapshotStorageObject[] = [];
  const snapshotBucket = state.snapshot?.storage[bucketKey];
  if (snapshotBucket) candidates.push(...snapshotBucket);
  if (bucketKey === '(default)' && state.storage) {
    candidates.push(...state.storage);
  }
  const cleanTarget = objectPath.replace(/^\/+|\/+$/g, '');
  const existing = candidates.find(
    (obj) => obj.path.replace(/^\/+|\/+$/g, '') === cleanTarget,
  );
  if (!existing) return false;
  if (constraint.minSizeBytes !== undefined && existing.size < constraint.minSizeBytes) {
    return false;
  }
  if (constraint.maxSizeBytes !== undefined && existing.size > constraint.maxSizeBytes) {
    return false;
  }
  if (
    (constraint.contentTypePattern !== undefined || constraint.contentTypeConjuncts !== undefined)
    && !contentTypeMatchesPattern(
      existing.contentType ?? 'application/octet-stream',
      constraint.contentTypePattern,
      constraint.contentTypeConjuncts,
    )
  ) {
    return false;
  }
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const conjuncts = constraint.httpHeaders?.[key] ?? constraint.storedHttpHeaders?.[key];
    if (!conjuncts || conjuncts.length === 0) continue;
    const val = existing[key];
    if (typeof val !== 'string' || !httpHeaderMatchesConjuncts(val, conjuncts)) {
      return false;
    }
  }
  for (const reqKey of constraint.requiredCustomMetadataKeys ?? []) {
    if (!existing.customMetadata || !Object.hasOwn(existing.customMetadata, reqKey)) {
      return false;
    }
  }
  const ownerKeys = new Set<string>(payloadOwnerFields);
  if (constraint.ownerMetadataKey !== undefined) {
    ownerKeys.add(constraint.ownerMetadataKey);
  }
  for (const key of ownerKeys) {
    if (existing.customMetadata?.[key] !== ownerUid) {
      return false;
    }
  }
  return true;
}

export interface CrossServiceProbeContext {
  readonly input: PlanInput;
  readonly site: AccessSite;
  readonly sitePattern: ResourcePattern;
  readonly ownerPath: string;
  readonly createSource: readonly RuleSurfaceEntry[];
  readonly createConstraint: StorageMetadataConstraint;
  readonly opSource: readonly RuleSurfaceEntry[];
  readonly opConstraint: StorageMetadataConstraint;
  readonly siblingHttpHeaders: Readonly<Partial<Record<StorageHttpHeaderKey, string>>>;
  readonly directLookups: readonly CrossServiceLookup[];
  readonly membershipLookups: readonly CrossServiceLookup[];
  readonly primaryRulePattern: ResourcePattern | undefined;
  readonly hints: readonly ValueHint[];
  readonly surface: RuleSurface | undefined;
}

export function planCrossServiceStorageProbes(
  ctx: CrossServiceProbeContext,
  add: (probe: Omit<Probe, 'id'>) => void,
): void {
  const {
    input,
    site,
    sitePattern,
    ownerPath,
    createSource,
    createConstraint,
    opSource,
    opConstraint,
    siblingHttpHeaders,
    directLookups,
    membershipLookups,
    primaryRulePattern,
    hints,
    surface,
  } = ctx;
  const { owner, peer } = input;
  const combinedLookups = dedupeLookups([...directLookups, ...membershipLookups]);
  const peerHasLiveDoc = peerHasLiveMembershipAtPath(
    site.path,
    primaryRulePattern,
    ownerPath,
    combinedLookups,
    peer,
    input.state,
  );
  const isolatedPath = resolveStorageConcretePath(
    site,
    owner,
    owner,
    peer.uid,
    primaryRulePattern,
    combinedLookups,
    input.state,
    undefined,
    peerHasLiveDoc,
  );
  const ownerOnlySeeds = crossServiceLookupSeeds({
    storageTemplate: site.path,
    rulePattern: primaryRulePattern,
    concreteStoragePath: isolatedPath,
    lookups: combinedLookups,
    actors: [owner],
    sites: input.sites,
    state: input.state,
  });

  if (STORAGE_UPLOAD_OPS.has(site.op)) {
    const ownerSetup = buildCompliantUploadStep(
      site,
      sitePattern,
      'owner',
      owner,
      isolatedPath,
      createConstraint,
      hints,
      {},
      surface,
    );
    const peerNonMemberPath = peerPathInSameScope(site.path, isolatedPath, '-peer');
    const uploadCandidates = distinctSynthesizableStorageArms(createSource, createConstraint);
    for (const candidate of uploadCandidates) {
      const peerAttack = buildCompliantUploadStep(
        site,
        sitePattern,
        'peer',
        peer,
        peerNonMemberPath,
        candidate.constraint,
        hints,
        {},
        surface,
        { useClientSiteMetadata: false },
      );
      add({
        kind: 'foreign-slot-write',
        op: 'write',
        service: 'storage',
        template: site.path,
        status: 'proven',
        seed: [...ownerOnlySeeds],
        setup: [ownerSetup],
        attack: peerAttack,
        expect: 'deny',
        evidence: `non-member ${peer.uid} uploaded to cross-service guarded Storage path ${peerNonMemberPath} (${site.source})`,
        sources: [site.source],
      });
    }
  } else if (STORAGE_UPDATE_OPS.has(site.op)) {
    const ownerUpdateControl = buildCompliantUpdateStep(
      site,
      sitePattern,
      'owner',
      owner,
      isolatedPath,
      opConstraint,
      hints,
      surface,
    );
    const updateCandidates = distinctSynthesizableStorageArms(opSource, opConstraint);
    for (const candidate of updateCandidates) {
      const updateSeedConstraint = mergeSeedStorageConstraint(
        createConstraint,
        candidate.constraint,
      );
      const adminSeedObj = buildCompliantUploadStep(
        site,
        sitePattern,
        'admin',
        owner,
        isolatedPath,
        updateSeedConstraint,
        hints,
        {},
        surface,
        { useClientSiteMetadata: false, fallbackHttpHeaders: siblingHttpHeaders },
      );
      const peerUpdateAttack = buildCompliantUpdateStep(
        site,
        sitePattern,
        'peer',
        peer,
        isolatedPath,
        candidate.constraint,
        hints,
        surface,
        { useClientSiteMetadata: false },
      );
      add({
        kind: 'foreign-slot-write',
        op: 'update',
        service: 'storage',
        template: site.path,
        status: 'proven',
        seed: [...ownerOnlySeeds, adminSeedObj],
        setup: [ownerUpdateControl],
        attack: peerUpdateAttack,
        expect: 'deny',
        evidence: `non-member ${peer.uid} updated metadata on cross-service guarded Storage path ${isolatedPath} (${site.source})`,
        sources: [site.source],
      });
    }
  } else if (STORAGE_READ_OPS.has(site.op)) {
    let seedObjPath = isolatedPath;
    let readMethod: 'get' | 'list' = 'get';
    if (STORAGE_LIST_OPS.has(site.op)) {
      readMethod = 'list';
      if (isolatedPath.length === 0) seedObjPath = 'item-1';
      else seedObjPath = `${isolatedPath}/item-1`;
    }
    const readSeedConstraint = mergeSeedStorageConstraint(createConstraint, opConstraint);
    const adminSeedObj = buildCompliantUploadStep(
      site,
      sitePattern,
      'admin',
      owner,
      seedObjPath,
      readSeedConstraint,
      hints,
      {},
      surface,
      { useClientSiteMetadata: false, fallbackHttpHeaders: siblingHttpHeaders },
    );
    const ownerReadControl = attachResourceId(
      { actor: 'owner', service: 'storage', method: readMethod, path: isolatedPath },
      site.resourceId,
    );
    const peerReadAttack = attachResourceId(
      { actor: 'peer', service: 'storage', method: readMethod, path: isolatedPath },
      site.resourceId,
    );
    add({
      kind: 'foreign-slot-write',
      op: 'read',
      service: 'storage',
      template: site.path,
      status: 'proven',
      seed: [...ownerOnlySeeds, adminSeedObj],
      setup: [ownerReadControl],
      attack: peerReadAttack,
      expect: 'deny',
      evidence: `non-member ${peer.uid} read cross-service guarded Storage path ${isolatedPath} (${site.source})`,
      sources: [site.source],
    });
  }
}
