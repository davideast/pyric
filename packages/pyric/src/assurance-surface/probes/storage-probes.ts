/**
 * Cloud Storage assurance probe planning across all five Storage defect families:
 *   1. `must-allow-denied` (`storage-must-allow-probes.ts`)
 *   2. `foreign-slot-write` on UID-keyed Storage paths (across all sibling/nested allow arms)
 *   3. `foreign-delete` on UID-keyed or metadata-owned Storage objects
 *   4. `metadata-owner-forge` on `customMetadata` owner fields (create forge + `updateMetadata` hijack)
 *   5. Cross-service non-member upload and read denial (`firestore.get()` / `firestore.exists()`)
 */
import type { AccessSite, StorageHttpHeaderKey } from '../code/types.js';
import { parseResourcePattern, resourceShapeKey } from '../../sandbox/internal/resource-pattern.js';
import type { RuleSurface, RuleSurfaceEntry } from '../rules/rule-surface.js';
import { STORAGE_HTTP_HEADER_KEYS } from '../rules/storage-constraint-summary.js';
import { uidFields } from './fixtures.js';
import type { PlanInput } from './plan.js';
import { crossServiceLookupSeeds } from './prerequisites.js';
import {
  distinctSynthesizableStorageArms,
  mergeSeedStorageConstraint,
} from './storage-constraint-arms.js';
import {
  hasCompatibleSeededStorageObject,
  planCrossServiceStorageProbes,
} from './storage-cross-service-probes.js';
import {
  attachResourceId,
  buildCompliantCustomMetadata,
  buildCompliantUploadStep,
  isExactUidAuth,
  resolveStorageConcretePath,
  setStorageOwn,
  storageBindingsAt,
} from './storage-metadata-materializer.js';
import { planMustAllowStorageProbe } from './storage-must-allow-probes.js';
import { discoverScopeMembershipLookups } from './storage-scope-lookup.js';
import {
  STORAGE_DELETE_OPS,
  STORAGE_UPDATE_OPS,
  STORAGE_UPLOAD_OPS,
  dedupeStorageSites,
  isProbeableStorageSite,
  selectStorageConstraintForSite,
} from './storage-step-builder.js';
import type { Probe, ProbeStep } from './types.js';
import { normalizeStorageBucketKey } from './world-storage.js';

function matchingStorageSurfaceEntries(
  surface: RuleSurface | undefined,
  sitePattern: ReturnType<typeof parseResourcePattern>,
  op: string | undefined,
  defaultBucket: string | undefined,
): RuleSurfaceEntry[] {
  if (!surface) return [];
  const seen = new Set<RuleSurfaceEntry>();
  const out: RuleSurfaceEntry[] = [];
  const pushAll = (items: readonly RuleSurfaceEntry[]): void => {
    for (const item of items) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  };
  pushAll(surface.matching(sitePattern, op));
  if (sitePattern.resourceId === '(default)' && defaultBucket !== undefined) {
    pushAll(surface.matching({ ...sitePattern, resourceId: defaultBucket }, op));
  }
  return out;
}

function collectSiblingUploadHttpHeaders(
  storageSites: readonly AccessSite[],
  targetShapeKey: string,
): Partial<Record<StorageHttpHeaderKey, string>> {
  const out: Partial<Record<StorageHttpHeaderKey, string>> = {};
  for (const other of storageSites) {
    if (!STORAGE_UPLOAD_OPS.has(other.op) || !other.storageUpload) continue;
    const otherShape = resourceShapeKey(
      parseResourcePattern('storage', other.path, other.resourceId),
    );
    if (otherShape !== targetShapeKey) continue;
    for (const key of STORAGE_HTTP_HEADER_KEYS) {
      const val = other.storageUpload[key];
      if (val !== undefined && out[key] === undefined) {
        out[key] = val;
      }
    }
  }
  return out;
}

/** Plan Cloud Storage assurance probes from extracted Storage sites and projected `RuleSurface`. */
export function planStorageProbes(
  input: PlanInput,
  add: (probe: Omit<Probe, 'id'>) => void,
): void {
  const { owner, peer, surface } = input;
  const defaultBucket = normalizeStorageBucketKey(input.defaultBucket);
  const hints = input.hints ?? [];
  const storageSites = dedupeStorageSites(input.sites.filter(isProbeableStorageSite));
  if (storageSites.length === 0) return;

  for (const site of storageSites) {
    const sitePattern = parseResourcePattern('storage', site.path, site.resourceId);
    const shapeKey = resourceShapeKey(sitePattern);
    const matchingEntries = matchingStorageSurfaceEntries(
      surface,
      sitePattern,
      site.op,
      defaultBucket,
    );
    const allPathEntries = matchingStorageSurfaceEntries(
      surface,
      sitePattern,
      undefined,
      defaultBucket,
    );
    const createMatched = matchingStorageSurfaceEntries(
      surface,
      sitePattern,
      'uploadBytes',
      defaultBucket,
    );
    let createEntries = allPathEntries;
    if (createMatched.length > 0) createEntries = createMatched;

    let createSource: readonly RuleSurfaceEntry[] = allPathEntries;
    if (createEntries.length > 0) createSource = createEntries;
    const createConstraint = selectStorageConstraintForSite(createSource, site);

    let opSource: readonly RuleSurfaceEntry[] = allPathEntries;
    if (matchingEntries.length > 0) opSource = matchingEntries;
    const opConstraint = selectStorageConstraintForSite(opSource, site);
    const siblingHttpHeaders = collectSiblingUploadHttpHeaders(storageSites, shapeKey);

    const { directLookups, membershipLookups, primaryRulePattern } = discoverScopeMembershipLookups(
      site,
      sitePattern,
      matchingEntries,
      allPathEntries,
      surface,
      input.conditions,
      input.state,
      owner,
    );

    const ownerPath = resolveStorageConcretePath(
      site,
      owner,
      owner,
      peer.uid,
      primaryRulePattern,
      directLookups,
      input.state,
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

    if (!site.source.startsWith('seed:')) {
      planMustAllowStorageProbe(
        {
          site,
          sitePattern,
          owner,
          ownerPath,
          ownerCrossSeeds,
          createConstraint,
          opConstraint,
          opSource,
          siblingHttpHeaders,
          hints,
          surface,
          state: input.state,
        },
        add,
      );
    }

    const siteBindings = storageBindingsAt(site, input.bindings, surface, defaultBucket);
    const uidVars = (site.pathVariables ?? []).filter((v) =>
      v.auth?.some((a) => a.source === 'auth.uid'),
    );
    const hasPathBinding = siteBindings.some((b) => b.kind === 'pathVar');

    // 2. Family 2: foreign-slot-write on UID-keyed Storage path across all synthesizable rule arms
    if ((uidVars.length > 0 || hasPathBinding) && STORAGE_UPLOAD_OPS.has(site.op)) {
      const ownerSetupUpload = buildCompliantUploadStep(
        site,
        sitePattern,
        'owner',
        owner,
        ownerPath,
        createConstraint,
        hints,
        {},
        surface,
      );
      const createOnlySetupPath = resolveStorageConcretePath(
        site,
        owner,
        owner,
        peer.uid,
        primaryRulePattern,
        directLookups,
        input.state,
        '-setup',
      );
      const createOnlySetupSteps: ProbeStep[] = [];
      if (createOnlySetupPath !== ownerPath) {
        createOnlySetupSteps.push(
          buildCompliantUploadStep(
            site,
            sitePattern,
            'owner',
            owner,
            createOnlySetupPath,
            createConstraint,
            hints,
            {},
            surface,
          ),
        );
      }
      let slotStatus: 'proven' | 'flagged' = 'flagged';
      const ruleConfirmedSlot = siteBindings.some(
        (b) => b.kind === 'pathVar' && (b.strength === 'strong' || b.evidence !== 'code-only'),
      );
      const exactClientSlot =
        site.resolution === 'resolved' && uidVars.some((v) => isExactUidAuth(v.auth));
      if (ruleConfirmedSlot || exactClientSlot) slotStatus = 'proven';

      const attackCandidates = distinctSynthesizableStorageArms(createSource, createConstraint);
      for (const candidate of attackCandidates) {
        const ownerUidMetaOverrides: Record<string, string> = {};
        for (const f of uidFields(site.payload)) setStorageOwn(ownerUidMetaOverrides, f, owner.uid);
        if (candidate.constraint.ownerMetadataKey !== undefined) {
          setStorageOwn(ownerUidMetaOverrides, candidate.constraint.ownerMetadataKey, owner.uid);
        }
        const peerSlotAttack = buildCompliantUploadStep(
          site,
          sitePattern,
          'peer',
          peer,
          ownerPath,
          candidate.constraint,
          hints,
          ownerUidMetaOverrides,
          surface,
          { useClientSiteMetadata: false },
        );
        let setupSteps: ProbeStep[] = createOnlySetupSteps;
        if (candidate.allowsUpdate) setupSteps = [ownerSetupUpload];
        add({
          kind: 'foreign-slot-write',
          op: 'write',
          service: 'storage',
          template: site.path,
          status: slotStatus,
          seed: bothCrossSeeds,
          setup: setupSteps,
          attack: peerSlotAttack,
          expect: 'deny',
          evidence: `${peer.uid} uploaded into ${owner.uid}'s Storage path at ${ownerPath} (client write ${site.source})`,
          sources: [site.source],
        });
      }
    }

    const metadataOwnerKeys = new Set<string>(uidFields(site.payload));
    for (const b of siteBindings) {
      if (b.kind === 'incomingField' || b.kind === 'storedField') {
        metadataOwnerKeys.add(b.field.replace(/^metadata\./, ''));
      }
    }
    if (createConstraint.ownerMetadataKey !== undefined) {
      metadataOwnerKeys.add(createConstraint.ownerMetadataKey);
    }
    if (opConstraint.ownerMetadataKey !== undefined) {
      metadataOwnerKeys.add(opConstraint.ownerMetadataKey);
    }

    // 3. Family 3: foreign-delete on UID-keyed or metadata-owned Storage paths
    const isDeleteSite = STORAGE_DELETE_OPS.has(site.op);
    const hasSiblingDeleteSite = storageSites.some(
      (other) =>
        STORAGE_DELETE_OPS.has(other.op)
        && resourceShapeKey(parseResourcePattern('storage', other.path, other.resourceId)) === shapeKey,
    );
    const shouldPlanForeignDelete =
      (uidVars.length > 0 || hasPathBinding || metadataOwnerKeys.size > 0)
      && (isDeleteSite || (STORAGE_UPLOAD_OPS.has(site.op) && !hasSiblingDeleteSite));

    if (shouldPlanForeignDelete) {
      const ownerMetaOverrides: Record<string, string> = {};
      for (const k of metadataOwnerKeys) setStorageOwn(ownerMetaOverrides, k, owner.uid);
      const reuseSeededForDelete = hasCompatibleSeededStorageObject(
        input.state,
        site.resourceId,
        ownerPath,
        owner.uid,
        createConstraint,
        metadataOwnerKeys,
      );
      const foreignDeleteSeeds: ProbeStep[] = [...bothCrossSeeds];
      if (!reuseSeededForDelete) {
        foreignDeleteSeeds.push(
          buildCompliantUploadStep(
            site,
            sitePattern,
            'admin',
            owner,
            ownerPath,
            createConstraint,
            hints,
            ownerMetaOverrides,
            surface,
            { useClientSiteMetadata: false, fallbackHttpHeaders: siblingHttpHeaders },
          ),
        );
      }
      const peerDeleteAttack = attachResourceId(
        { actor: 'peer', service: 'storage', method: 'delete', path: ownerPath },
        site.resourceId,
      );

      let deleteStatus: 'proven' | 'flagged' = 'flagged';
      const exactUid =
        uidVars.some((v) => isExactUidAuth(v.auth))
        || (site.payload?.fields ?? []).some(
          (f) => metadataOwnerKeys.has(f.name) && isExactUidAuth(f.auth),
        );
      const ruleConfirmed = siteBindings.some(
        (b) => b.strength === 'strong' || b.evidence !== 'code-only',
      );
      if (exactUid || ruleConfirmed) deleteStatus = 'proven';

      add({
        kind: 'foreign-delete',
        op: 'delete',
        service: 'storage',
        template: site.path,
        status: deleteStatus,
        seed: foreignDeleteSeeds,
        setup: [],
        attack: peerDeleteAttack,
        expect: 'deny',
        evidence: `${peer.uid} deleted ${owner.uid}'s Storage object at ${ownerPath} (${site.source})`,
        sources: [site.source],
      });
    }

    // 4. Family 4: metadata-owner-forge (create forge + updateMetadata hijack)
    const ruleUsesMetadataOwner =
      siteBindings.some(
        (b) => (b.kind === 'incomingField' || b.kind === 'storedField') && b.evidence !== 'code-only',
      )
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
          site,
          peer,
          peer,
          owner.uid,
          primaryRulePattern,
          directLookups,
          input.state,
          '-peer-own',
        );
        const peerForgedPath = resolveStorageConcretePath(
          site,
          peer,
          peer,
          owner.uid,
          primaryRulePattern,
          directLookups,
          input.state,
          '-forged',
        );
        const peerControlStep = buildCompliantUploadStep(
          site,
          sitePattern,
          'peer',
          peer,
          peerControlPath,
          createConstraint,
          hints,
          {},
          surface,
        );
        const forgedOverrides: Record<string, string> = {};
        for (const k of metadataOwnerKeys) setStorageOwn(forgedOverrides, k, owner.uid);
        const peerForgedStep = buildCompliantUploadStep(
          site,
          sitePattern,
          'peer',
          peer,
          peerForgedPath,
          createConstraint,
          hints,
          forgedOverrides,
          surface,
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
        (other) =>
          STORAGE_UPDATE_OPS.has(other.op)
          && resourceShapeKey(parseResourcePattern('storage', other.path, other.resourceId)) === shapeKey,
      );
      const rulesAllowUpdate = allPathEntries.some(
        (e) => e.ops.includes('update') || e.ops.includes('write'),
      );
      if (
        STORAGE_UPDATE_OPS.has(site.op)
        || (STORAGE_UPLOAD_OPS.has(site.op) && !hasSiblingUpdateSite && rulesAllowUpdate)
      ) {
        const ownerMetaOverrides: Record<string, string> = {};
        for (const k of metadataOwnerKeys) setStorageOwn(ownerMetaOverrides, k, owner.uid);
        const hijackSeedConstraint = mergeSeedStorageConstraint(createConstraint, opConstraint);
        const reuseSeededForHijack = hasCompatibleSeededStorageObject(
          input.state,
          site.resourceId,
          ownerPath,
          owner.uid,
          hijackSeedConstraint,
          metadataOwnerKeys,
        );
        const hijackSeeds: ProbeStep[] = [...bothCrossSeeds];
        if (!reuseSeededForHijack) {
          hijackSeeds.push(
            buildCompliantUploadStep(
              site,
              sitePattern,
              'admin',
              owner,
              ownerPath,
              hijackSeedConstraint,
              hints,
              ownerMetaOverrides,
              surface,
              { useClientSiteMetadata: false, fallbackHttpHeaders: siblingHttpHeaders },
            ),
          );
        }
        const hijackOverrides: Record<string, string> = {};
        for (const k of metadataOwnerKeys) setStorageOwn(hijackOverrides, k, peer.uid);
        const hijackMeta = buildCompliantCustomMetadata(
          site,
          sitePattern,
          opConstraint,
          hints,
          peer,
          hijackOverrides,
          surface,
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
          seed: hijackSeeds,
          setup: [],
          attack: peerHijackStep,
          expect: 'deny',
          evidence: `${peer.uid} overwrote customMetadata (${keyList} = ${peer.uid}) on ${owner.uid}'s Storage object at ${ownerPath} (${site.source})`,
          sources: [site.source],
        });
      }
    }

    if (membershipLookups.length > 0 && uidVars.length === 0) {
      planCrossServiceStorageProbes(
        {
          input,
          site,
          sitePattern,
          ownerPath,
          createConstraint,
          opConstraint,
          directLookups,
          membershipLookups,
          primaryRulePattern,
          hints,
          surface,
        },
        add,
      );
    }
  }
}
