/**
 * Family 4 (`metadata-owner-forge`) probe builder for Cloud Storage create
 * forge and `updateMetadata` hijack across all synthesizable rule arms.
 */
import type { ResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import type { AccessSite, StorageHttpHeaderKey } from '../code/types.js';
import type {
  CrossServiceLookup,
  RuleSurface,
  RuleSurfaceEntry,
  StorageMetadataConstraint,
} from '../rules/rule-surface.js';
import type { ValueHint } from '../rules/value-hints.js';
import {
  distinctSynthesizableStorageArms,
  mergeSeedStorageConstraint,
  selectStorageConstraintForSite,
} from './storage-constraint-arms.js';
import { hasCompatibleSeededStorageObject } from './storage-cross-service-probes.js';
import {
  buildCompliantUpdateStep,
  buildCompliantUploadStep,
  resolveStorageConcretePath,
  setStorageOwn,
} from './storage-metadata-materializer.js';
import {
  STORAGE_UPDATE_OPS,
  STORAGE_UPLOAD_OPS,
} from './storage-step-builder.js';
import type { Probe, ProbeActor, ProbeStep } from './types.js';
import type { WorldState } from './world.js';

interface OwnerForgeStorageProbeContext {
  readonly site: AccessSite;
  readonly sitePattern: ResourcePattern;
  readonly owner: ProbeActor;
  readonly peer: ProbeActor;
  readonly ownerPath: string;
  readonly bothCrossSeeds: readonly ProbeStep[];
  readonly createSource: readonly RuleSurfaceEntry[];
  readonly createConstraint: StorageMetadataConstraint;
  readonly updateSource: readonly RuleSurfaceEntry[];
  readonly allPathEntries: readonly RuleSurfaceEntry[];
  readonly hasSiblingUpdateSite: boolean;
  readonly metadataOwnerKeys: ReadonlySet<string>;
  readonly metaStatus: 'proven' | 'flagged';
  readonly primaryRulePattern: ResourcePattern | undefined;
  readonly directLookups: readonly CrossServiceLookup[];
  readonly siblingHttpHeaders: Readonly<Partial<Record<StorageHttpHeaderKey, string>>>;
  readonly hints: readonly ValueHint[];
  readonly surface: RuleSurface | undefined;
  readonly state: WorldState | undefined;
}

export function planOwnerForgeStorageProbes(
  ctx: OwnerForgeStorageProbeContext,
  add: (probe: Omit<Probe, 'id'>) => void,
): void {
  const {
    site,
    sitePattern,
    owner,
    peer,
    ownerPath,
    bothCrossSeeds,
    createSource,
    createConstraint,
    updateSource,
    allPathEntries,
    hasSiblingUpdateSite,
    metadataOwnerKeys,
    metaStatus,
    primaryRulePattern,
    directLookups,
    siblingHttpHeaders,
    hints,
    surface,
    state,
  } = ctx;
  const keyList = [...metadataOwnerKeys].join(', ');

  if (STORAGE_UPLOAD_OPS.has(site.op)) {
    const peerControlPath = resolveStorageConcretePath(
      site,
      peer,
      peer,
      owner.uid,
      primaryRulePattern,
      directLookups,
      state,
      '-peer-own',
    );
    const peerForgedPath = resolveStorageConcretePath(
      site,
      peer,
      peer,
      owner.uid,
      primaryRulePattern,
      directLookups,
      state,
      '-forged',
    );
    const forgedOverrides: Record<string, string> = {};
    for (const k of metadataOwnerKeys) setStorageOwn(forgedOverrides, k, owner.uid);

    const createCandidates = distinctSynthesizableStorageArms(createSource, createConstraint);
    for (const candidate of createCandidates) {
      const peerControlStep = buildCompliantUploadStep(
        site,
        sitePattern,
        'peer',
        peer,
        peerControlPath,
        candidate.constraint,
        hints,
        {},
        surface,
        { useClientSiteMetadata: false },
      );
      const peerForgedStep = buildCompliantUploadStep(
        site,
        sitePattern,
        'peer',
        peer,
        peerForgedPath,
        candidate.constraint,
        hints,
        forgedOverrides,
        surface,
        { useClientSiteMetadata: false },
      );
      add({
        kind: 'metadata-owner-forge',
        op: 'create',
        service: 'storage',
        template: site.path,
        status: metaStatus,
        seed: [...bothCrossSeeds],
        setup: [peerControlStep],
        attack: peerForgedStep,
        expect: 'deny',
        evidence: `${peer.uid} uploaded a Storage object forging customMetadata (${keyList} = ${owner.uid}) at ${peerForgedPath} (${site.source})`,
        sources: [site.source],
      });
    }
  }

  const rulesAllowUpdate = allPathEntries.some(
    (e) => e.ops.includes('update') || e.ops.includes('write'),
  );
  if (
    STORAGE_UPDATE_OPS.has(site.op)
    || (STORAGE_UPLOAD_OPS.has(site.op) && !hasSiblingUpdateSite && rulesAllowUpdate)
  ) {
    const ownerMetaOverrides: Record<string, string> = {};
    for (const k of metadataOwnerKeys) setStorageOwn(ownerMetaOverrides, k, owner.uid);
    const hijackOverrides: Record<string, string> = {};
    for (const k of metadataOwnerKeys) setStorageOwn(hijackOverrides, k, peer.uid);

    const preferredUpdateConstraint = selectStorageConstraintForSite(updateSource, site);
    const updateCandidates = distinctSynthesizableStorageArms(
      updateSource,
      preferredUpdateConstraint,
    );
    for (const candidate of updateCandidates) {
      const hijackSeedConstraint = mergeSeedStorageConstraint(
        createConstraint,
        candidate.constraint,
      );
      const reuseSeededForHijack = hasCompatibleSeededStorageObject(
        state,
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
      const peerHijackStep = buildCompliantUpdateStep(
        site,
        sitePattern,
        'peer',
        peer,
        ownerPath,
        candidate.constraint,
        hints,
        surface,
        { useClientSiteMetadata: false, metadataOverrides: hijackOverrides },
      );
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
}
