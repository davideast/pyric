/**
 * Cloud Storage assurance probe planning across all five Storage defect families:
 *   1. `must-allow-denied` (including client MIME, byte-size, and customMetadata mismatches)
 *   2. `foreign-slot-write` on UID-keyed Storage paths
 *   3. `foreign-delete` on UID-keyed or metadata-owned Storage objects
 *   4. `metadata-owner-forge` on `customMetadata` owner fields (create forge + `updateMetadata` hijack)
 *   5. Cross-service non-member upload and read denial (`firestore.get()` / `firestore.exists()`)
 */
import { parseResourcePattern, resourceShapeKey } from '../../sandbox/internal/resource-pattern.js';
import type { RuleSurfaceEntry, StorageMetadataConstraint } from '../rules/rule-surface.js';
import { uidFields } from './fixtures.js';
import type { PlanInput } from './plan.js';
import { crossServiceLookupSeeds } from './prerequisites.js';
import {
  dedupeLookups,
  discoverScopeMembershipLookups,
  peerHasLiveMembershipAtPath,
} from './storage-scope-lookup.js';
import {
  STORAGE_DELETE_OPS,
  STORAGE_LIST_OPS,
  STORAGE_READ_OPS,
  STORAGE_UPDATE_OPS,
  STORAGE_UPLOAD_OPS,
  attachResourceId,
  buildClientCustomMetadata,
  buildCompliantCustomMetadata,
  buildCompliantUpdateStep,
  buildCompliantUploadStep,
  compliantByteSize,
  dedupeStorageSites,
  isExactUidAuth,
  isProbeableStorageSite,
  mergedStorageConstraint,
  peerPathInSameScope,
  resolveStorageConcretePath,
  setStorageOwn,
  storageBindingsAt,
  storageOpCategory,
  synthesizeMatchingContentType,
} from './storage-step-builder.js';
import type { Probe, ProbeStep } from './types.js';

/** Plan Cloud Storage assurance probes from extracted Storage sites and projected `RuleSurface`. */
export function planStorageProbes(
  input: PlanInput,
  add: (probe: Omit<Probe, 'id'>) => void,
): void {
  const { owner, peer, surface } = input;
  const hints = input.hints ?? [];
  const storageSites = dedupeStorageSites(input.sites.filter(isProbeableStorageSite));
  if (storageSites.length === 0) return;

  for (const site of storageSites) {
    const sitePattern = parseResourcePattern('storage', site.path, site.resourceId);
    const matchingEntries = surface?.matching(sitePattern, site.op) ?? [];
    const allPathEntries = surface?.matching(sitePattern) ?? [];
    const createEntries = surface?.matching(sitePattern, 'uploadBytes') ?? allPathEntries;

    let createSource: readonly RuleSurfaceEntry[] = allPathEntries;
    if (createEntries.length > 0) createSource = createEntries;
    const createConstraint = mergedStorageConstraint(createSource);

    let opSource: readonly RuleSurfaceEntry[] = allPathEntries;
    if (matchingEntries.length > 0) opSource = matchingEntries;
    const opConstraint = mergedStorageConstraint(opSource);

    const { directLookups, membershipLookups, primaryRulePattern } = discoverScopeMembershipLookups(
      site, sitePattern, matchingEntries, allPathEntries, surface, input.conditions, input.state, owner,
    );

    const ownerPath = resolveStorageConcretePath(
      site, owner, owner, peer.uid, primaryRulePattern, directLookups, input.state,
    );
    const ownerCrossSeeds = crossServiceLookupSeeds({
      storageTemplate: site.path,
      rulePattern: primaryRulePattern,
      concreteStoragePath: ownerPath,
      lookups: directLookups,
      actors: [owner],
      sites: input.sites,
      state: input.state,
    });
    const bothCrossSeeds = crossServiceLookupSeeds({
      storageTemplate: site.path,
      rulePattern: primaryRulePattern,
      concreteStoragePath: ownerPath,
      lookups: directLookups,
      actors: [owner, peer],
      sites: input.sites,
      state: input.state,
    });

    // 1. Family 1: must-allow-denied (including client MIME / size / missing customMetadata mismatches)
    if (!site.source.startsWith('seed:')) {
      if (STORAGE_UPLOAD_OPS.has(site.op)) {
        const clientMeta = buildClientCustomMetadata(site, sitePattern, opConstraint, hints, owner, surface);
        let contentType = synthesizeMatchingContentType(opConstraint.contentTypePattern);
        if (site.storageUpload?.contentType !== undefined) contentType = site.storageUpload.contentType;
        let sizeBytes = compliantByteSize(opConstraint.maxSizeBytes);
        if (site.storageUpload?.sizeBytes !== undefined) sizeBytes = site.storageUpload.sizeBytes;

        const attackStep: ProbeStep = attachResourceId(
          { actor: 'owner', service: 'storage', method: 'create', path: ownerPath, data: 'probe-bytes', sizeBytes, contentType },
          site.resourceId,
        );
        if (clientMeta.metadata !== undefined) attackStep.customMetadata = clientMeta.metadata;

        const mustAllowUpload: Omit<Probe, 'id'> = {
          kind: 'must-allow-denied',
          op: 'create',
          service: 'storage',
          template: site.path,
          status: 'proven',
          seed: ownerCrossSeeds,
          setup: [],
          attack: attackStep,
          expect: 'allow',
          evidence: `the owner's own ${site.op} at ${site.source} is denied`,
          sources: [site.source],
        };
        if (clientMeta.openMap) {
          mustAllowUpload.inconclusiveOnDeny = 'client customMetadata map is open and may carry required keys at runtime';
        }
        add(mustAllowUpload);
      } else {
        let seedObjectPath = ownerPath;
        if (STORAGE_LIST_OPS.has(site.op)) {
          if (ownerPath.length === 0) seedObjectPath = 'item-1';
          else seedObjectPath = `${ownerPath}/item-1`;
        }
        const seedMimePattern = createConstraint.contentTypePattern ?? opConstraint.contentTypePattern;
        let opSeedConstraint: StorageMetadataConstraint = createConstraint;
        if (seedMimePattern !== undefined && createConstraint.contentTypePattern === undefined) {
          opSeedConstraint = { ...createConstraint, contentTypePattern: seedMimePattern };
        }
        const adminSeedObj = buildCompliantUploadStep(
          site, sitePattern, 'admin', owner, seedObjectPath, opSeedConstraint, hints, {}, surface,
        );

        let attackMethod: ProbeStep['method'] = 'get';
        if (STORAGE_LIST_OPS.has(site.op)) attackMethod = 'list';
        else if (STORAGE_DELETE_OPS.has(site.op)) attackMethod = 'delete';
        else if (STORAGE_UPDATE_OPS.has(site.op)) attackMethod = 'update';

        const attackStep: ProbeStep = attachResourceId(
          { actor: 'owner', service: 'storage', method: attackMethod, path: ownerPath },
          site.resourceId,
        );
        let inconclusiveReason: string | undefined;
        if (attackMethod === 'update') {
          if (site.storageUpload?.contentType !== undefined) {
            attackStep.contentType = site.storageUpload.contentType;
          }
          const clientMeta = buildClientCustomMetadata(site, sitePattern, opConstraint, hints, owner, surface);
          if (clientMeta.metadata !== undefined) {
            attackStep.customMetadata = clientMeta.metadata;
          }
          if (clientMeta.openMap) {
            inconclusiveReason = 'client customMetadata map is open and may carry required keys at runtime';
          }
        }

        const mustAllowOp: Omit<Probe, 'id'> = {
          kind: 'must-allow-denied',
          op: storageOpCategory(site),
          service: 'storage',
          template: site.path,
          status: 'proven',
          seed: [...ownerCrossSeeds, adminSeedObj],
          setup: [],
          attack: attackStep,
          expect: 'allow',
          evidence: `the owner's own ${site.op} at ${site.source} is denied`,
          sources: [site.source],
        };
        if (inconclusiveReason !== undefined) mustAllowOp.inconclusiveOnDeny = inconclusiveReason;
        add(mustAllowOp);
      }
    }

    const siteBindings = storageBindingsAt(site, input.bindings, surface);
    const uidVars = (site.pathVariables ?? []).filter((v) => v.auth?.some((a) => a.source === 'auth.uid'));
    const hasPathBinding = siteBindings.some((b) => b.kind === 'pathVar');

    // 2. Family 2: foreign-slot-write on UID-keyed Storage path
    if ((uidVars.length > 0 || hasPathBinding) && STORAGE_UPLOAD_OPS.has(site.op)) {
      const ownerSetupUpload = buildCompliantUploadStep(
        site, sitePattern, 'owner', owner, ownerPath, createConstraint, hints, {}, surface,
      );
      const ownerUidMetaOverrides: Record<string, string> = {};
      for (const f of uidFields(site.payload)) setStorageOwn(ownerUidMetaOverrides, f, owner.uid);
      if (createConstraint.ownerMetadataKey !== undefined) {
        setStorageOwn(ownerUidMetaOverrides, createConstraint.ownerMetadataKey, owner.uid);
      }
      const peerSlotAttack = buildCompliantUploadStep(
        site, sitePattern, 'peer', peer, ownerPath, createConstraint, hints, ownerUidMetaOverrides, surface,
      );

      let slotStatus: 'proven' | 'flagged' = 'flagged';
      const ruleConfirmedSlot = siteBindings.some(
        (b) => b.kind === 'pathVar' && (b.strength === 'strong' || b.evidence !== 'code-only'),
      );
      const exactClientSlot = site.resolution === 'resolved' && uidVars.some((v) => isExactUidAuth(v.auth));
      if (ruleConfirmedSlot || exactClientSlot) slotStatus = 'proven';

      add({
        kind: 'foreign-slot-write',
        op: 'write',
        service: 'storage',
        template: site.path,
        status: slotStatus,
        seed: bothCrossSeeds,
        setup: [ownerSetupUpload],
        attack: peerSlotAttack,
        expect: 'deny',
        evidence: `${peer.uid} uploaded into ${owner.uid}'s Storage path at ${ownerPath} (client write ${site.source})`,
        sources: [site.source],
      });
    }

    // Metadata owner keys on this path
    const metadataOwnerKeys = new Set<string>(uidFields(site.payload));
    for (const b of siteBindings) {
      if (b.kind === 'incomingField' || b.kind === 'storedField') {
        metadataOwnerKeys.add(b.field.replace(/^metadata\./, ''));
      }
    }
    if (createConstraint.ownerMetadataKey !== undefined) metadataOwnerKeys.add(createConstraint.ownerMetadataKey);
    if (opConstraint.ownerMetadataKey !== undefined) metadataOwnerKeys.add(opConstraint.ownerMetadataKey);

    const shapeKey = resourceShapeKey(sitePattern);

    // 3. Family 3: foreign-delete on UID-keyed or metadata-owned Storage paths
    const isDeleteSite = STORAGE_DELETE_OPS.has(site.op);
    const hasSiblingDeleteSite = storageSites.some(
      (other) => STORAGE_DELETE_OPS.has(other.op) && resourceShapeKey(parseResourcePattern('storage', other.path, other.resourceId)) === shapeKey,
    );
    const shouldPlanForeignDelete =
      (uidVars.length > 0 || hasPathBinding || metadataOwnerKeys.size > 0)
      && (isDeleteSite || (STORAGE_UPLOAD_OPS.has(site.op) && !hasSiblingDeleteSite));

    if (shouldPlanForeignDelete) {
      const ownerMetaOverrides: Record<string, string> = {};
      for (const k of metadataOwnerKeys) setStorageOwn(ownerMetaOverrides, k, owner.uid);
      const adminSeedOwnerObj = buildCompliantUploadStep(
        site, sitePattern, 'admin', owner, ownerPath, createConstraint, hints, ownerMetaOverrides, surface,
      );
      const peerDeleteAttack = attachResourceId(
        { actor: 'peer', service: 'storage', method: 'delete', path: ownerPath },
        site.resourceId,
      );

      let deleteStatus: 'proven' | 'flagged' = 'flagged';
      const exactUid = uidVars.some((v) => isExactUidAuth(v.auth))
        || (site.payload?.fields ?? []).some((f) => metadataOwnerKeys.has(f.name) && isExactUidAuth(f.auth));
      const ruleConfirmed = siteBindings.some((b) => b.strength === 'strong' || b.evidence !== 'code-only');
      if (exactUid || ruleConfirmed) deleteStatus = 'proven';

      add({
        kind: 'foreign-delete',
        op: 'delete',
        service: 'storage',
        template: site.path,
        status: deleteStatus,
        seed: [...bothCrossSeeds, adminSeedOwnerObj],
        setup: [],
        attack: peerDeleteAttack,
        expect: 'deny',
        evidence: `${peer.uid} deleted ${owner.uid}'s Storage object at ${ownerPath} (${site.source})`,
        sources: [site.source],
      });
    }

    // 4. Family 4: metadata-owner-forge (create forge + updateMetadata hijack)
    const ruleUsesMetadataOwner =
      siteBindings.some((b) => (b.kind === 'incomingField' || b.kind === 'storedField') && b.evidence !== 'code-only')
      || createConstraint.ownerMetadataKey !== undefined
      || opConstraint.ownerMetadataKey !== undefined;

    if (metadataOwnerKeys.size > 0 && (uidVars.length === 0 || ruleUsesMetadataOwner)) {
      let metaStatus: 'proven' | 'flagged' = 'flagged';
      const exactFieldAuth = (site.payload?.fields ?? []).some(
        (f) => metadataOwnerKeys.has(f.name) && isExactUidAuth(f.auth),
      );
      if (ruleUsesMetadataOwner || exactFieldAuth) metaStatus = 'proven';
      const keyList = [...metadataOwnerKeys].join(', ');

      if (STORAGE_UPLOAD_OPS.has(site.op)) {
        const peerControlPath = resolveStorageConcretePath(
          site, peer, peer, owner.uid, primaryRulePattern, directLookups, input.state, '-peer-own',
        );
        const peerForgedPath = resolveStorageConcretePath(
          site, peer, peer, owner.uid, primaryRulePattern, directLookups, input.state, '-forged',
        );
        const peerControlStep = buildCompliantUploadStep(
          site, sitePattern, 'peer', peer, peerControlPath, createConstraint, hints, {}, surface,
        );
        const forgedOverrides: Record<string, string> = {};
        for (const k of metadataOwnerKeys) setStorageOwn(forgedOverrides, k, owner.uid);
        const peerForgedStep = buildCompliantUploadStep(
          site, sitePattern, 'peer', peer, peerForgedPath, createConstraint, hints, forgedOverrides, surface,
        );
        add({
          kind: 'metadata-owner-forge',
          op: 'create',
          service: 'storage',
          template: site.path,
          status: metaStatus,
          seed: bothCrossSeeds,
          setup: [peerControlStep],
          attack: peerForgedStep,
          expect: 'deny',
          evidence: `${peer.uid} uploaded a Storage object forging customMetadata (${keyList} = ${owner.uid}) at ${peerForgedPath} (${site.source})`,
          sources: [site.source],
        });
      }

      const hasSiblingUpdateSite = storageSites.some(
        (other) => STORAGE_UPDATE_OPS.has(other.op) && resourceShapeKey(parseResourcePattern('storage', other.path, other.resourceId)) === shapeKey,
      );
      const rulesAllowUpdate = allPathEntries.some((e) => e.ops.includes('update') || e.ops.includes('write'));
      if (STORAGE_UPDATE_OPS.has(site.op) || (STORAGE_UPLOAD_OPS.has(site.op) && !hasSiblingUpdateSite && rulesAllowUpdate)) {
        const ownerMetaOverrides: Record<string, string> = {};
        for (const k of metadataOwnerKeys) setStorageOwn(ownerMetaOverrides, k, owner.uid);
        const adminSeedOwnerObj = buildCompliantUploadStep(
          site, sitePattern, 'admin', owner, ownerPath, createConstraint, hints, ownerMetaOverrides, surface,
        );
        const hijackOverrides: Record<string, string> = {};
        for (const k of metadataOwnerKeys) setStorageOwn(hijackOverrides, k, peer.uid);
        const hijackMeta = buildCompliantCustomMetadata(
          site, sitePattern, opConstraint, hints, peer, hijackOverrides, surface,
        );
        const peerHijackStep: ProbeStep = attachResourceId(
          { actor: 'peer', service: 'storage', method: 'update', path: ownerPath },
          site.resourceId,
        );
        if (hijackMeta !== undefined) peerHijackStep.customMetadata = hijackMeta;
        add({
          kind: 'metadata-owner-forge',
          op: 'update',
          service: 'storage',
          template: site.path,
          status: metaStatus,
          seed: [...bothCrossSeeds, adminSeedOwnerObj],
          setup: [],
          attack: peerHijackStep,
          expect: 'deny',
          evidence: `${peer.uid} overwrote customMetadata (${keyList} = ${peer.uid}) on ${owner.uid}'s Storage object at ${ownerPath} (${site.source})`,
          sources: [site.source],
        });
      }
    }

    // 5. Family 5: Cross-service non-member upload and read denial
    if (membershipLookups.length > 0 && uidVars.length === 0) {
      const combinedLookups = dedupeLookups([...directLookups, ...membershipLookups]);
      const peerHasLiveDoc = peerHasLiveMembershipAtPath(
        site.path, primaryRulePattern, ownerPath, combinedLookups, peer, input.state,
      );
      const isolatedPath = resolveStorageConcretePath(
        site, owner, owner, peer.uid, primaryRulePattern, combinedLookups, input.state, undefined, peerHasLiveDoc,
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
          site, sitePattern, 'owner', owner, isolatedPath, createConstraint, hints, {}, surface,
        );
        const peerNonMemberPath = peerPathInSameScope(site.path, isolatedPath, '-peer');
        const peerAttack = buildCompliantUploadStep(
          site, sitePattern, 'peer', peer, peerNonMemberPath, createConstraint, hints, {}, surface,
        );
        add({
          kind: 'foreign-slot-write',
          op: 'write',
          service: 'storage',
          template: site.path,
          status: 'proven',
          seed: ownerOnlySeeds,
          setup: [ownerSetup],
          attack: peerAttack,
          expect: 'deny',
          evidence: `non-member ${peer.uid} uploaded to cross-service guarded Storage path ${peerNonMemberPath} (${site.source})`,
          sources: [site.source],
        });
      } else if (STORAGE_UPDATE_OPS.has(site.op)) {
        const seedMimePattern = createConstraint.contentTypePattern ?? opConstraint.contentTypePattern;
        let updateSeedConstraint: StorageMetadataConstraint = createConstraint;
        if (seedMimePattern !== undefined && createConstraint.contentTypePattern === undefined) {
          updateSeedConstraint = { ...createConstraint, contentTypePattern: seedMimePattern };
        }
        const adminSeedObj = buildCompliantUploadStep(
          site, sitePattern, 'admin', owner, isolatedPath, updateSeedConstraint, hints, {}, surface,
        );
        const ownerUpdateControl = buildCompliantUpdateStep(
          site, sitePattern, 'owner', owner, isolatedPath, opConstraint, hints, surface,
        );
        const peerUpdateAttack = buildCompliantUpdateStep(
          site, sitePattern, 'peer', peer, isolatedPath, opConstraint, hints, surface,
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
      } else if (STORAGE_READ_OPS.has(site.op)) {
        let seedObjPath = isolatedPath;
        let readMethod: 'get' | 'list' = 'get';
        if (STORAGE_LIST_OPS.has(site.op)) {
          readMethod = 'list';
          if (isolatedPath.length === 0) seedObjPath = 'item-1';
          else seedObjPath = `${isolatedPath}/item-1`;
        }
        const adminSeedObj = buildCompliantUploadStep(
          site, sitePattern, 'admin', owner, seedObjPath, createConstraint, hints, {}, surface,
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
  }
}
