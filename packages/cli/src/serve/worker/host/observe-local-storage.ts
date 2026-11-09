/**
 * The local Storage rules' verdict on an observed Cloud Storage call.
 *
 * The host evaluates the call against the rules deployed for its bucket,
 * with `request.resource` built from the metadata an upload or metadata
 * update sent and `resource` from the metadata a `getMetadata` returned. The
 * evaluator reports which of those it read, so a verdict that rested on one
 * the call did not carry is `unevaluated` instead of a guess. Object bytes
 * never reach the host.
 */
import {
  bindRulesBucket,
  compiledStorageRulesForBucket,
  DEFAULT_BUCKET,
  emptyStorageObservation,
  evaluateStorageRules,
  requestResourceFor,
  resourceFromStored,
  rulesBucketName,
  type StorageEvaluationObservation,
} from 'pyric/storage/internal';
import { UNREAD_BUCKET, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { HostCtx } from '../host-context.js';
import {
  authOf,
  definedOnly,
  givenBy,
  isPlainRecord,
  unionOf,
  verdictOf,
  type Gap,
  type Given,
  type LocalVerdict,
  type StorageLocal,
} from './observe-local-evaluation.js';

type StorageMethod = Exclude<ObservedMethod, 'set'>;
type ObjectFields = Record<string, unknown>;

/** The buckets the app's default rules govern: its configured bucket and the project's two default names. */
function storageDefaultBuckets(ctx: HostCtx): string[] {
  const buckets: string[] = [];
  const configuredBucket = stringField(ctx.appOptions ?? {}, 'storageBucket');
  if (configuredBucket) buckets.push(configuredBucket);
  let projectId = stringField(ctx.appOptions ?? {}, 'projectId');
  if (projectId === undefined) projectId = ctx.rtdbProjectId;
  if (projectId) buckets.push(`${projectId}.appspot.com`, `${projectId}.firebasestorage.app`);
  return buckets;
}

/** The bucket a call names, or `undefined` when the page could not read it from the reference. */
function namedBucket(call: ObservedCall): string | undefined {
  if (call.bucket === UNREAD_BUCKET) return undefined;
  return call.bucket;
}

/** The object path a call names, without a leading slash. */
function objectPathOf(call: ObservedCall): string {
  const path = call.path;
  if (path === undefined) return '';
  if (path.startsWith('/')) return path.slice(1);
  return path;
}

function stringField(fields: ObjectFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function customMetadataOf(raw: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * The size `request.resource` names: the written size, else the stored
 * object's (a metadata update leaves the bytes as they are), else zero.
 */
function requestedObjectSize(written: ObjectFields, stored: ObjectFields | undefined): number {
  const writtenSize = written.size;
  if (typeof writtenSize === 'number') return writtenSize;
  const storedSize = stored?.size;
  if (typeof storedSize === 'number') return storedSize;
  return 0;
}

/** Whether the method sends object metadata the rules see as `request.resource`. */
function writesObject(method: StorageMethod): boolean {
  return method === 'create' || method === 'update';
}

/** `request.resource` for an upload or a metadata update, or `null` for a call that sent no metadata. */
function requestResourceOf(call: ObservedCall, method: StorageMethod, bucket: string, fullPath: string) {
  const written = isPlainRecord(call.writeData) ? call.writeData : undefined;
  if (!writesObject(method) || written === undefined) return undefined;
  const stored = isPlainRecord(call.document) ? call.document : undefined;
  const object = {
    bucket,
    fullPath,
    size: requestedObjectSize(written, stored),
    contentType: stringField(written, 'contentType'),
    customMetadata: customMetadataOf(written.customMetadata),
    cacheControl: stringField(written, 'cacheControl'),
    contentDisposition: stringField(written, 'contentDisposition'),
    contentEncoding: stringField(written, 'contentEncoding'),
    contentLanguage: stringField(written, 'contentLanguage'),
    generation: stringField(stored ?? {}, 'generation'),
    metageneration: stringField(stored ?? {}, 'metageneration'),
  };
  let write: 'upload' | 'metadataUpdate' = 'metadataUpdate';
  if (method === 'create') write = 'upload';
  return requestResourceFor(object, write);
}

/** `resource` from the metadata a call returned, or `null` when it returned none. */
function storedResourceOf(call: ObservedCall, bucket: string, fullPath: string) {
  if (!isPlainRecord(call.document)) return null;
  const stored = call.document;
  let size = 0;
  if (typeof stored.size === 'number') size = stored.size;
  return resourceFromStored({
    bucket,
    fullPath,
    size,
    contentType: stringField(stored, 'contentType'),
    customMetadata: customMetadataOf(stored.customMetadata),
    timeCreated: stringField(stored, 'timeCreated'),
    updated: stringField(stored, 'updated'),
    generation: stringField(stored, 'generation'),
    metageneration: stringField(stored, 'metageneration'),
  });
}

/** The data the evaluation read that the call did not carry. */
function storageGaps(observation: StorageEvaluationObservation, method: StorageMethod, given: Given): Gap[] {
  const gaps: Gap[] = [];
  if (observation.readResource && !given.document) gaps.push('stored-document');
  if (observation.readFirestore) gaps.push('stored-document');
  if (observation.readRequestResource) {
    if (writesObject(method) && !given.writeData) gaps.push('write-data');
    // A metadata update's incoming object keeps the stored fields it does not name.
    if (method === 'update' && !given.document) gaps.push('stored-document');
  }
  if (observation.readAuthToken && !given.claims) gaps.push('claim-values');
  if (observation.readAuthTokenEmail && !given.emailKnown) gaps.push('claim-values');
  return unionOf(gaps, []);
}

/** The Storage record a verdict carries: the matched rule and the evaluator's reasons. */
function storageRecordOf(observation: StorageEvaluationObservation, reasons: readonly string[]): StorageLocal | undefined {
  const record: StorageLocal = {};
  const matched = observation.matchedRule;
  if (matched !== undefined) record.matchedPath = matched.path;
  if (matched?.line !== undefined) record.matchedLine = matched.line;
  if (reasons.length > 0) record.reasons = [...reasons];
  if (Object.keys(record).length === 0) return undefined;
  return record;
}

/** The app's Storage rules' verdict on an observed Storage call, or `undefined` when no rules govern its bucket. */
export function storageVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  if (method === 'set') return undefined;
  const bucket = namedBucket(call);
  const rules = compiledStorageRulesForBucket(ctx.sandbox, bucket, storageDefaultBuckets(ctx));
  if (rules === null) return undefined;
  const effectiveBucket = rulesBucketName(DEFAULT_BUCKET, bucket);
  const objectPath = objectPathOf(call);
  const fullPath = `b/${effectiveBucket}/o/${objectPath}`;
  const request = {
    auth: authOf(call),
    method,
    path: objectPath,
    resource: requestResourceOf(call, method, effectiveBucket, fullPath),
  };
  const input = bindRulesBucket(
    { request, resource: storedResourceOf(call, effectiveBucket, fullPath) },
    effectiveBucket,
    effectiveBucket,
  );
  const observation = emptyStorageObservation();
  const evaluated = evaluateStorageRules(rules, input, new Date(call.at), undefined, observation);
  const matched = observation.matchedRule;
  let rule: LocalVerdict['rule'];
  if (matched !== undefined) rule = definedOnly({ path: matched.path, line: matched.line });
  return verdictOf(call, {
    allowed: evaluated.allowed,
    rule,
    needs: storageGaps(observation, method, givenBy(call, method)),
    storage: storageRecordOf(observation, evaluated.reasons),
  });
}
