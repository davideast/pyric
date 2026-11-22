/**
 * Storage candidate-rules verification for `pyric verify`.
 */
import type { SandboxOperationEvent, ServiceMutationEvent } from 'pyric/sandbox';
import { isProductionServed } from 'pyric/sandbox/internal';
import { evaluateStorageRules } from 'pyric/storage';
import {
  bindRulesBucket,
  compileStorageRules,
  DEFAULT_BUCKET,
  normalizeRecordedStorageDeniedWrite,
  requestResourceFor,
  resourceFromStored,
  rulesBucketName,
  type CompiledStorageRules,
  type StoredMetadata,
} from 'pyric/storage/internal';

import {
  filterFixtureForFirestoreDatabase,
  firestoreEventDatabase,
} from './firestore-databases.js';
import {
  decodeCapturedFirestoreDoc,
  readOwnDocument,
  reconstructInitialFirestoreDocuments,
} from './firestore-doc-history.js';
import type { PyricVerifyFixture } from './fixture.js';
import {
  buildStorageVerifyRequest,
  VerifyInputError,
  type VerifyDivergence,
  type VerifyEngine,
  type VerifyEngineResult,
  type VerifyRulesInput,
  type VerifyServiceResult,
} from './index.js';
import {
  lockedBucketReason,
  recordedBucketName,
  storageBucketRules,
  type StorageBucketRules,
  type StorageCandidateRuleset,
} from './storage-buckets.js';

type StorageCandidateSource = string | { source: string };

function isInformational(divergence: VerifyDivergence): boolean {
  return divergence.kind === 'expected-drift';
}

export async function verifyStorage(
  fixture: PyricVerifyFixture,
  rules: VerifyRulesInput,
  engines: VerifyEngine[],
): Promise<VerifyServiceResult> {
  const storage = fixture.services.storage;
  if (!storage) {
    throw new VerifyInputError('fixture does not contain services.storage.');
  }
  if (engines.includes('rulesTestApi')) {
    throw new VerifyInputError(
      'rulesTestApi verification is Firestore-only; select --service firestore or use the sandbox engine for Storage.',
    );
  }

  const ruleset = storageCandidateRuleset(rules, fixture);

  const objectState = new Map<string, StoredMetadata>();
  const seededKeys = new Set<string>();
  const knownBuckets = new Set<string>();
  for (const event of fixture.events) {
    if (event.service !== 'storage') continue;
    if (event.kind === 'operation') {
      const opBucket = storageOperationBucket(event as SandboxOperationEvent);
      if (opBucket) knownBuckets.add(opBucket);
      continue;
    }
    if (event.kind !== 'service_mutation') continue;
    const mutation = event as ServiceMutationEvent;
    const bucket = storageMutationBucket(mutation);
    knownBuckets.add(bucket);
    const key = `${bucket}/${(mutation.path ?? '').replace(/^\/+/, '')}`;
    if (!seededKeys.has(key)) {
      seededKeys.add(key);
      if (mutation.before && typeof mutation.before === 'object') {
        objectState.set(key, mutation.before as StoredMetadata);
      }
    }
  }

  const divergences: VerifyDivergence[] = [];
  let checkedEvents = 0;
  const consumedMutationIndices = new Set<number>();
  const defaultFirestoreFixture = filterFixtureForFirestoreDatabase(fixture, undefined);
  const currentFirestoreDocs: Record<string, Record<string, unknown>> = {
    ...reconstructInitialFirestoreDocuments(defaultFirestoreFixture),
  };

  for (let i = 0; i < fixture.events.length; i++) {
    const event = fixture.events[i]!;
    if (event.kind === 'write') {
      if (firestoreEventDatabase(event) !== undefined) continue;
      if (event.nextState === null || event.method === 'delete') {
        delete currentFirestoreDocs[event.path];
      } else {
        Object.defineProperty(currentFirestoreDocs, event.path, {
          value: decodeCapturedFirestoreDoc(event.nextState, event.nextUnescapedPaths),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      continue;
    }
    if (event.kind === 'service_mutation' && event.service === 'storage') {
      const mutation = event as ServiceMutationEvent;
      const bucket = storageMutationBucket(mutation);
      const key = `${bucket}/${(mutation.path ?? '').replace(/^\/+/, '')}`;
      if (
        (mutation.op === 'object_put' || mutation.op === 'metadata_update') &&
        mutation.after &&
        typeof mutation.after === 'object'
      ) {
        objectState.set(key, mutation.after as StoredMetadata);
      } else if (mutation.op === 'object_delete') {
        objectState.delete(key);
      }
      continue;
    }

    if (event.kind !== 'operation' || event.service !== 'storage') continue;
    const opEvent = event as SandboxOperationEvent;
    const isUnchecked =
      opEvent.origin === 'admin' ||
      opEvent.result === 'not-applicable' ||
      isProductionServed(opEvent.rulesDisposition);
    if (isUnchecked) continue;

    const objectPath = (opEvent.path ?? '').replace(/^\/+/, '');
    const opBucket = storageOperationBucket(opEvent);
    let pairedMutation: ServiceMutationEvent | undefined;
    if (opEvent.result === 'allow' && isStorageWriteMethod(opEvent.method)) {
      for (let j = i + 1; j < fixture.events.length; j++) {
        if (consumedMutationIndices.has(j)) continue;
        const next = fixture.events[j]!;
        if (next.service !== 'storage') continue;
        if (next.kind !== 'operation' && next.kind !== 'service_mutation') continue;
        const nextPath = (next.path ?? '').replace(/^\/+/, '');
        if (nextPath !== objectPath) continue;
        if (next.kind === 'operation') {
          const nextOp = next as SandboxOperationEvent;
          const nextBucket = storageOperationBucket(nextOp);
          const sameBucket =
            opBucket === undefined || nextBucket === undefined || nextBucket === opBucket;
          if (
            sameBucket &&
            nextOp.result === 'allow' &&
            isStorageWriteMethod(nextOp.method) &&
            nextOp.method !== opEvent.method
          ) {
            break;
          }
          continue;
        }
        if (next.kind === 'service_mutation') {
          const candidate = next as ServiceMutationEvent;
          const mutBucket = storageMutationBucket(candidate);
          if (opBucket !== undefined && mutBucket !== opBucket) continue;
          if (!isMatchingStorageMutationOp(opEvent.method, candidate.op)) {
            break;
          }
          pairedMutation = candidate;
          consumedMutationIndices.add(j);
          break;
        }
      }
    }

    const bucket = resolveStorageOperationBucket(
      opEvent,
      pairedMutation,
      objectPath,
      objectState,
      knownBuckets,
    );
    const key = `${bucket}/${objectPath}`;
    let existing: StoredMetadata | undefined = objectState.get(key);
    if (pairedMutation && pairedMutation.before !== undefined) {
      existing = pairedMutation.before as StoredMetadata | undefined;
    }
    let rawDeniedWrite;
    if (
      fixture.storageDeniedWrites !== undefined &&
      Object.hasOwn(fixture.storageDeniedWrites, opEvent.id)
    ) {
      rawDeniedWrite = fixture.storageDeniedWrites[opEvent.id];
    }
    const deniedWrite = normalizeRecordedStorageDeniedWrite(rawDeniedWrite);
    const detailRequestResource = deniedWrite?.requestResource;
    const detailResource = deniedWrite?.resource;

    const bucketName = recordedBucketName(opEvent, bucket);
    const bucketRules = storageBucketRules(ruleset, bucket, bucketName);

    checkedEvents += 1;

    const requestResource = buildStorageRequestResource(
      opEvent.method,
      objectPath,
      bucket,
      pairedMutation,
      existing,
      detailRequestResource,
      detailResource,
    );
    let currentResource = detailResource ?? null;
    if (existing) {
      currentResource = resourceFromStored(existing);
    }
    const requestPayload = buildStorageVerifyRequest(
      opEvent.auth,
      opEvent.method,
      objectPath,
      requestResource,
    );
    const input = bindRulesBucket(
      {
        request: requestPayload,
        resource: currentResource,
      },
      bucket,
      bucketName,
    );
    const evaluated = evaluateReplayedStorageRequest(
      bucketRules,
      input,
      opEvent,
      fixture,
      currentFirestoreDocs,
    );

    if (opEvent.result === 'allow' && !evaluated.allowed) {
      divergences.push({
        service: 'storage',
        kind: 'now-denied',
        bucket: bucketName,
        path: opEvent.path,
        method: opEvent.method,
        reason: evaluated.reasons.join('; ') || 'expected ALLOW, got DENY',
      });
    } else if (opEvent.result === 'deny' && evaluated.allowed) {
      divergences.push({
        service: 'storage',
        kind: 'now-allowed',
        bucket: bucketName,
        path: opEvent.path,
        method: opEvent.method,
        reason: evaluated.reasons.join('; ') || 'expected DENY, got ALLOW',
      });
    }
  }

  const sandbox: VerifyEngineResult = {
    engine: 'sandbox',
    ok: divergences.every(isInformational),
    checkedEvents,
    divergences,
  };

  return {
    service: 'storage',
    ok: divergences.every(isInformational),
    checkedEvents,
    divergences,
    engines: { sandbox },
  };
}

function buildStorageRequestResource(
  method: string | undefined,
  objectPath: string,
  bucket: string,
  pairedMutation: ServiceMutationEvent | undefined,
  existing: StoredMetadata | undefined,
  detailRequestResource: ReturnType<typeof requestResourceFor> | undefined,
  detailResource: ReturnType<typeof resourceFromStored> | undefined,
): ReturnType<typeof requestResourceFor> | undefined {
  if (method === 'create' || method === 'write') {
    const after = pairedMutation?.after as StoredMetadata | undefined;
    if (after) return requestResourceFor(after, 'upload');
    if (detailRequestResource !== undefined) return detailRequestResource;
    return requestResourceFor(
      {
        fullPath: objectPath,
        bucket,
        size: 0,
        contentType: 'application/octet-stream',
      },
      'upload',
    );
  }
  if (method === 'update') {
    const after = pairedMutation?.after as StoredMetadata | undefined;
    if (after) {
      return requestResourceFor(
        { ...after, metageneration: existing?.metageneration ?? after.metageneration },
        'metadataUpdate',
      );
    }
    if (detailRequestResource !== undefined) return detailRequestResource;
    let generation = existing?.generation;
    if (generation === undefined && detailResource?.generation !== undefined) {
      generation = String(detailResource.generation);
    }
    let metageneration = existing?.metageneration;
    if (metageneration === undefined && detailResource?.metageneration !== undefined) {
      metageneration = String(detailResource.metageneration);
    }
    return requestResourceFor(
      {
        fullPath: objectPath,
        bucket,
        size: existing?.size ?? detailResource?.size ?? 0,
        contentType: existing?.contentType ?? detailResource?.contentType ?? 'application/octet-stream',
        generation,
        metageneration,
      },
      'metadataUpdate',
    );
  }
  return undefined;
}

function evaluateReplayedStorageRequest(
  bucketRules: StorageBucketRules,
  input: Parameters<typeof evaluateStorageRules>[1],
  opEvent: SandboxOperationEvent,
  fixture: PyricVerifyFixture,
  pointInTimeFirestoreDocs: Record<string, Record<string, unknown>>,
): { allowed: boolean; reasons: string[] } {
  if (bucketRules.kind === 'locked') {
    return { allowed: false, reasons: [lockedBucketReason(bucketRules.bucket)] };
  }
  if (input.request.method === 'update' && !input.resource) {
    return {
      allowed: false,
      reasons: ['Client updateMetadata requires an existing object to synthesize request.resource.'],
    };
  }
  let requestTime = new Date();
  if (typeof opEvent.at === 'number' && Number.isFinite(opEvent.at)) {
    requestTime = new Date(opEvent.at);
  }
  return evaluateStorageRules(
    bucketRules.rules,
    input,
    requestTime,
    fixtureFirestoreLookup(fixture, pointInTimeFirestoreDocs),
  );
}

function fixtureFirestoreLookup(
  _fixture: PyricVerifyFixture,
  pointInTimeFirestoreDocs: Record<string, Record<string, unknown>>,
): Parameters<typeof evaluateStorageRules>[3] {
  return {
    get: (docPath) => readOwnDocument(pointInTimeFirestoreDocs, docPath),
    exists: (docPath) => readOwnDocument(pointInTimeFirestoreDocs, docPath) !== null,
  };
}

function isStorageWriteMethod(method: string | undefined): boolean {
  return method === 'create' || method === 'update' || method === 'delete' || method === 'write';
}

function isMatchingStorageMutationOp(
  method: string | undefined,
  mutationOp: string | undefined,
): boolean {
  if (method === 'create') return mutationOp === 'object_put';
  if (method === 'update') return mutationOp === 'metadata_update';
  if (method === 'delete') return mutationOp === 'object_delete';
  if (method === 'write') {
    return (
      mutationOp === 'object_put' ||
      mutationOp === 'metadata_update' ||
      mutationOp === 'object_delete'
    );
  }
  return false;
}

function storageOperationBucket(opEvent: SandboxOperationEvent): string | undefined {
  const directBucket = (opEvent as { bucket?: unknown }).bucket;
  if (typeof directBucket === 'string' && directBucket.length > 0) return directBucket;
  const detailBucket = (opEvent.detail as { bucket?: unknown } | undefined)?.bucket;
  if (typeof detailBucket === 'string' && detailBucket.length > 0) return detailBucket;
  return undefined;
}

function resolveStorageOperationBucket(
  opEvent: SandboxOperationEvent,
  pairedMutation: ServiceMutationEvent | undefined,
  objectPath: string,
  objectState: ReadonlyMap<string, StoredMetadata>,
  knownBuckets: ReadonlySet<string>,
): string {
  const opBucket = storageOperationBucket(opEvent);
  if (opBucket) return opBucket;
  if (pairedMutation) return storageMutationBucket(pairedMutation);
  const matchingBuckets: string[] = [];
  for (const candidateBucket of knownBuckets) {
    if (objectState.has(`${candidateBucket}/${objectPath}`)) {
      matchingBuckets.push(candidateBucket);
    }
  }
  if (matchingBuckets.length === 1) return matchingBuckets[0]!;
  if (knownBuckets.size === 1) return [...knownBuckets][0]!;
  return DEFAULT_BUCKET;
}

function storageMutationBucket(mutation: ServiceMutationEvent): string {
  const detailBucket = (mutation.detail as { bucket?: unknown } | undefined)?.bucket;
  if (typeof detailBucket === 'string' && detailBucket.length > 0) return detailBucket;
  const afterBucket = (mutation.after as { bucket?: unknown } | undefined)?.bucket;
  if (typeof afterBucket === 'string' && afterBucket.length > 0) return afterBucket;
  const beforeBucket = (mutation.before as { bucket?: unknown } | undefined)?.bucket;
  if (typeof beforeBucket === 'string' && beforeBucket.length > 0) return beforeBucket;
  return DEFAULT_BUCKET;
}

function defaultStorageRulesSource(
  input: VerifyRulesInput,
  fixture: PyricVerifyFixture,
): string | undefined {
  const passed = storageSourceText(input.storage);
  if (passed !== undefined) return passed;
  const captured = fixture.services.storage?.rules?.source;
  const hasCaptured = typeof captured === 'string' && captured.length > 0;
  if (hasCaptured) return captured;
  return undefined;
}

function storageSourceText(rules: StorageCandidateSource | undefined): string | undefined {
  if (typeof rules === 'string') return rules;
  if (rules && typeof rules.source === 'string') return rules.source;
  return undefined;
}

function storageCandidateRuleset(
  input: VerifyRulesInput,
  fixture: PyricVerifyFixture,
): StorageCandidateRuleset {
  const defaultSource = defaultStorageRulesSource(input, fixture);
  const byBucket = input.storageBuckets;
  if (defaultSource === undefined && byBucket === undefined) {
    throw new VerifyInputError('missing candidate Storage rules. Pass rules.storage.');
  }
  const defaultRules =
    defaultSource === undefined ? undefined : compileCandidateStorageRules(defaultSource);
  if (byBucket === undefined) {
    if (defaultRules === undefined) return {};
    return { defaultRules };
  }
  const buckets = new Map<string, CompiledStorageRules['rules']>();
  for (const [rawBucket, rules] of Object.entries(byBucket)) {
    const bucket = rulesBucketName(rawBucket, rawBucket);
    if (buckets.has(bucket)) {
      throw new VerifyInputError(`duplicate candidate Storage rules for bucket "${bucket}".`);
    }
    const source = storageSourceText(rules);
    if (source === undefined) {
      throw new VerifyInputError(`missing candidate Storage rules for bucket "${rawBucket}".`);
    }
    buckets.set(bucket, compileCandidateStorageRules(source, bucket));
  }
  if (defaultRules === undefined) return { buckets };
  return { defaultRules, buckets };
}

function compileCandidateStorageRules(
  source: string,
  bucket?: string,
): CompiledStorageRules['rules'] {
  try {
    return compileStorageRules(source).rules;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const scope = bucket === undefined ? '' : ` for bucket "${bucket}"`;
    throw new VerifyInputError(`candidate Storage rules${scope} would not deploy. ${message}`);
  }
}
