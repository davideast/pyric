/**
 * Family 1 (`must-allow-denied`) probe builder for Cloud Storage upload,
 * download, list, metadata update, and delete operations.
 */
import type { AccessSite, StorageHttpHeaderKey } from '../code/types.js';
import { uploadContentDisposition } from '../../storage/content-defaults.js';
import type { ResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import type {
  RuleSurface,
  RuleSurfaceEntry,
  StorageMetadataConstraint,
} from '../rules/rule-surface.js';
import type { ValueHint } from '../rules/value-hints.js';
import { uidFields } from './fixtures.js';
import {
  httpHeaderMatchesConjuncts,
  mergeSeedStorageConstraint,
  siteHasStaticHttpHeaderViolation,
  synthesizeMatchingHttpHeader,
} from './storage-constraint-arms.js';
import { hasCompatibleSeededStorageObject } from './storage-cross-service-probes.js';
import {
  applyClientHttpMetadataToStep,
  attachResourceId,
  buildClientCustomMetadata,
  buildCompliantUploadStep,
} from './storage-metadata-materializer.js';
import {
  compliantByteSize,
  contentTypeMatchesPattern,
  STORAGE_DELETE_OPS,
  STORAGE_LIST_OPS,
  STORAGE_UPDATE_OPS,
  STORAGE_UPLOAD_OPS,
  storageOpCategory,
  synthesizeMatchingContentType,
} from './storage-step-builder.js';
import type { Probe, ProbeActor, ProbeStep } from './types.js';
import type { WorldState } from './world.js';

export interface MustAllowStorageProbeContext {
  readonly site: AccessSite;
  readonly sitePattern: ResourcePattern;
  readonly owner: ProbeActor;
  readonly ownerPath: string;
  readonly ownerCrossSeeds: readonly ProbeStep[];
  readonly createConstraint: StorageMetadataConstraint;
  readonly opConstraint: StorageMetadataConstraint;
  readonly opSource: readonly RuleSurfaceEntry[];
  readonly siblingHttpHeaders: Readonly<Partial<Record<StorageHttpHeaderKey, string>>>;
  readonly hints: readonly ValueHint[];
  readonly surface: RuleSurface | undefined;
  readonly state: WorldState | undefined;
}

export function planMustAllowStorageProbe(
  ctx: MustAllowStorageProbeContext,
  add: (probe: Omit<Probe, 'id'>) => void,
): void {
  const {
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
    state,
  } = ctx;

  if (STORAGE_UPLOAD_OPS.has(site.op)) {
    const clientMeta = buildClientCustomMetadata(
      site,
      sitePattern,
      opConstraint,
      hints,
      owner,
      surface,
    );
    const blobMimeUnresolved = site.storageUpload?.blobContentTypeUnresolved === true;
    let contentType = 'application/octet-stream';
    if (!blobMimeUnresolved) {
      contentType = synthesizeMatchingContentType(
        opConstraint.contentTypePattern,
        opConstraint.contentTypeConjuncts,
      );
    }
    if (site.storageUpload?.contentType !== undefined) {
      contentType = site.storageUpload.contentType;
    }
    let sizeBytes = compliantByteSize(opConstraint.maxSizeBytes, opConstraint.minSizeBytes);
    if (site.storageUpload?.sizeBytes !== undefined) sizeBytes = site.storageUpload.sizeBytes;

    const attackStep: ProbeStep = attachResourceId(
      {
        actor: 'owner',
        service: 'storage',
        method: 'create',
        path: ownerPath,
        data: 'probe-bytes',
        sizeBytes,
        contentType,
      },
      site.resourceId,
    );
    applyClientHttpMetadataToStep(attackStep, site);
    const staticHttpViolated = siteHasStaticHttpHeaderViolation(site, opSource);
    if (staticHttpViolated && site.storageUpload?.httpMetadataUnresolvedFields) {
      for (const key of site.storageUpload.httpMetadataUnresolvedFields) {
        if (attackStep[key] === undefined) {
          const synth = synthesizeMatchingHttpHeader(key, opConstraint.httpHeaders?.[key]);
          if (synth !== undefined) attackStep[key] = synth;
        }
      }
    }
    if (clientMeta.metadata !== undefined) attackStep.customMetadata = clientMeta.metadata;

    const mustAllowUpload: Omit<Probe, 'id'> = {
      kind: 'must-allow-denied',
      op: 'create',
      service: 'storage',
      template: site.path,
      status: 'proven',
      seed: [...ownerCrossSeeds],
      setup: [],
      attack: attackStep,
      expect: 'allow',
      evidence: `the owner's own ${site.op} at ${site.source} is denied`,
      sources: [site.source],
    };
    if (
      clientMeta.openMap
      || site.storageUpload?.customMetadataOpen === true
      || site.storageUpload?.customMetadataUnresolved === true
      || (site.storageUpload?.httpMetadataUnresolved === true && !staticHttpViolated)
    ) {
      mustAllowUpload.inconclusiveOnDeny =
        'client upload metadata contains open or runtime-resolved fields';
    } else if (
      blobMimeUnresolved
      && !contentTypeMatchesPattern(
        contentType,
        opConstraint.contentTypePattern,
        opConstraint.contentTypeConjuncts,
      )
    ) {
      mustAllowUpload.inconclusiveOnDeny =
        'client Blob/File upload omits explicit contentType and relies on runtime Blob.type';
    } else if (
      site.storageUpload?.contentType === undefined
      && !contentTypeMatchesPattern(
        contentType,
        opConstraint.contentTypePattern,
        opConstraint.contentTypeConjuncts,
      )
    ) {
      mustAllowUpload.inconclusiveOnDeny =
        'client upload contentType is supplied at runtime and could not be synthesized for rule regex';
    } else if (
      site.storageUpload?.sizeBytes === undefined
      && ((opConstraint.minSizeBytes !== undefined && sizeBytes < opConstraint.minSizeBytes)
        || (opConstraint.maxSizeBytes !== undefined && sizeBytes > opConstraint.maxSizeBytes))
    ) {
      mustAllowUpload.inconclusiveOnDeny =
        'client upload size is supplied at runtime and could not be synthesized for rule bounds';
    } else if (
      !staticHttpViolated
      && site.storageUpload?.contentDisposition === undefined
      && opConstraint.httpHeaders?.contentDisposition !== undefined
      && !httpHeaderMatchesConjuncts(
        uploadContentDisposition(undefined, ownerPath),
        opConstraint.httpHeaders.contentDisposition,
      )
    ) {
      mustAllowUpload.inconclusiveOnDeny =
        'client upload contentDisposition depends on runtime object filename';
    }
    add(mustAllowUpload);
    return;
  }

  let seedObjectPath = ownerPath;
  if (STORAGE_LIST_OPS.has(site.op)) {
    if (ownerPath.length === 0) seedObjectPath = 'item-1';
    else seedObjectPath = `${ownerPath}/item-1`;
  }
  const opSeedConstraint = mergeSeedStorageConstraint(createConstraint, opConstraint);
  const reuseSeededObject =
    !STORAGE_LIST_OPS.has(site.op)
    && hasCompatibleSeededStorageObject(
      state,
      site.resourceId,
      seedObjectPath,
      owner.uid,
      opSeedConstraint,
      uidFields(site.payload),
    );
  const seedSteps: ProbeStep[] = [...ownerCrossSeeds];
  let seededStep: ProbeStep | undefined;
  if (!reuseSeededObject) {
    seededStep = buildCompliantUploadStep(
      site,
      sitePattern,
      'admin',
      owner,
      seedObjectPath,
      opSeedConstraint,
      hints,
      {},
      surface,
      { useClientSiteMetadata: false, fallbackHttpHeaders: siblingHttpHeaders },
    );
    seedSteps.push(seededStep);
  }

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
    applyClientHttpMetadataToStep(attackStep, site);
    const staticHttpViolated = siteHasStaticHttpHeaderViolation(site, opSource);
    const clientMeta = buildClientCustomMetadata(
      site,
      sitePattern,
      opConstraint,
      hints,
      owner,
      surface,
    );
    if (clientMeta.metadata !== undefined) {
      attackStep.customMetadata = clientMeta.metadata;
    }
    if (
      clientMeta.openMap
      || site.storageUpload?.customMetadataOpen === true
      || site.storageUpload?.customMetadataUnresolved === true
      || (site.storageUpload?.httpMetadataUnresolved === true && !staticHttpViolated)
    ) {
      inconclusiveReason =
        'client updateMetadata argument contains open or runtime-resolved fields';
    }
  }
  if (
    inconclusiveReason === undefined
    && seededStep?.contentType !== undefined
    && !contentTypeMatchesPattern(
      seededStep.contentType,
      opSeedConstraint.contentTypePattern,
      opSeedConstraint.contentTypeConjuncts,
    )
  ) {
    inconclusiveReason = 'seeded object contentType could not be synthesized for rule regex';
  }

  const mustAllowOp: Omit<Probe, 'id'> = {
    kind: 'must-allow-denied',
    op: storageOpCategory(site),
    service: 'storage',
    template: site.path,
    status: 'proven',
    seed: seedSteps,
    setup: [],
    attack: attackStep,
    expect: 'allow',
    evidence: `the owner's own ${site.op} at ${site.source} is denied`,
    sources: [site.source],
  };
  if (inconclusiveReason !== undefined) mustAllowOp.inconclusiveOnDeny = inconclusiveReason;
  add(mustAllowOp);
}
