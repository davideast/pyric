/**
 * Evaluates an observed Live-mode Cloud Storage call against a fetched
 * deployed Storage Security Rules snapshot (`#2363`).
 */
import type { ObservedCall } from 'pyric/sandbox';
import {
  observedMethod,
  productionVerdict,
  UNREAD_BUCKET,
  type LocalStorageEvaluation,
} from 'pyric/sandbox/internal';
import { parseStorageRules } from 'pyric/storage';
import {
  bindRulesBucket,
  DEFAULT_BUCKET,
  emptyStorageObservation,
  evaluateStorageRules,
  requestResourceFor,
  resourceFromStored,
  rulesBucketName,
  type StorageEvaluationObservation,
} from 'pyric/storage/internal';
import {
  authOf,
  definedOnly,
  givenBy,
  isPlainRecord,
  unionOf,
  type Gap,
  type Rule,
} from '../worker/host/observe-local-evaluation.js';
import type { DeployedStorageRulesSnapshot } from './deployed-rules.js';
import type {
  DeployedRulesEvaluationOutcome,
  DeployedRulesExplanation,
} from './deployed-rules-eval.js';

interface MutableStorageExplanation {
  source: 'deployed';
  service: 'storage';
  target: string;
  verdict: 'allow' | 'deny' | 'unevaluated';
  productionDisagrees: boolean;
  rule?: Rule;
  needs?: readonly Gap[];
  storage?: LocalStorageEvaluation;
  drift: DeployedStorageRulesSnapshot['drift'];
  releaseName: string;
  rulesetId: string;
  deployedHash: string;
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function storageCustomMetadata(raw: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true });
    }
  }
  return out;
}

function storageObjectPath(call: ObservedCall): string {
  if (call.path === undefined) return '';
  if (call.path.startsWith('/')) return call.path.slice(1);
  return call.path;
}

function productionDisagreesWith(call: ObservedCall, allowed: boolean): boolean {
  const verdict = productionVerdict(call.outcome);
  if (verdict === 'ok' && !allowed) return true;
  if (verdict === 'denied' && allowed) return true;
  return false;
}

/**
 * Evaluates a single observed Cloud Storage call against a deployed rules snapshot.
 */
export function evaluateCallAgainstDeployedStorage(
  call: ObservedCall,
  snapshot: DeployedStorageRulesSnapshot,
): DeployedRulesEvaluationOutcome {
  if (call.sdk === 'admin' || call.service !== 'storage') {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: 'Deployed Storage rules evaluation applies only to client Storage calls.',
    };
  }
  const method = observedMethod('storage', call.method);
  if (method === null || method === 'set') {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: `Storage method "${call.method}" cannot be evaluated against deployed rules.`,
    };
  }

  let parsedRules: ReturnType<typeof parseStorageRules>;
  try {
    parsedRules = parseStorageRules(snapshot.source);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: 'local',
      reason: 'compile-error',
      message: `Could not parse deployed Storage rules: ${reason}`,
    };
  }

  let rawBucket = snapshot.bucket;
  if (call.bucket !== undefined && call.bucket !== UNREAD_BUCKET) {
    rawBucket = call.bucket;
  }
  const effectiveBucket = rulesBucketName(DEFAULT_BUCKET, rawBucket);
  const objectPath = storageObjectPath(call);
  const fullPath = `b/${effectiveBucket}/o/${objectPath}`;

  const written = isPlainRecord(call.writeData) ? call.writeData : undefined;
  const stored = isPlainRecord(call.document) ? call.document : undefined;

  let reqResource: ReturnType<typeof requestResourceFor> | undefined;
  if ((method === 'create' || method === 'update') && written !== undefined) {
    let size = 0;
    if (typeof written.size === 'number') {
      size = written.size;
    } else if (typeof stored?.size === 'number') {
      size = stored.size;
    }
    const writeKind = method === 'create' ? 'upload' : 'metadataUpdate';
    reqResource = requestResourceFor(
      {
        bucket: effectiveBucket,
        fullPath,
        size,
        contentType: stringProp(written, 'contentType'),
        customMetadata: storageCustomMetadata(written.customMetadata),
        cacheControl: stringProp(written, 'cacheControl'),
        contentDisposition: stringProp(written, 'contentDisposition'),
        contentEncoding: stringProp(written, 'contentEncoding'),
        contentLanguage: stringProp(written, 'contentLanguage'),
        generation: stringProp(stored ?? {}, 'generation'),
        metageneration: stringProp(stored ?? {}, 'metageneration'),
      },
      writeKind,
    );
  }

  let storedResource: ReturnType<typeof resourceFromStored> | null = null;
  if (stored !== undefined) {
    const size = typeof stored.size === 'number' ? stored.size : 0;
    storedResource = resourceFromStored({
      bucket: effectiveBucket,
      fullPath,
      size,
      contentType: stringProp(stored, 'contentType'),
      customMetadata: storageCustomMetadata(stored.customMetadata),
      cacheControl: stringProp(stored, 'cacheControl'),
      contentDisposition: stringProp(stored, 'contentDisposition'),
      contentEncoding: stringProp(stored, 'contentEncoding'),
      contentLanguage: stringProp(stored, 'contentLanguage'),
      md5Hash: stringProp(stored, 'md5Hash'),
      crc32c: stringProp(stored, 'crc32c'),
      etag: stringProp(stored, 'etag'),
      timeCreated: stringProp(stored, 'timeCreated'),
      updated: stringProp(stored, 'updated'),
      generation: stringProp(stored, 'generation'),
      metageneration: stringProp(stored, 'metageneration'),
    });
  }

  const input = bindRulesBucket(
    {
      request: {
        auth: authOf(call),
        method,
        path: objectPath,
        resource: reqResource,
      },
      resource: storedResource,
    },
    effectiveBucket,
    effectiveBucket,
  );

  const observation: StorageEvaluationObservation = {
    ...emptyStorageObservation(),
    evaluatedAllows: [],
  };
  const evaluated = evaluateStorageRules(parsedRules, input, new Date(call.at), undefined, observation);
  const given = givenBy(call, method);
  const gaps: Gap[] = [];
  if (observation.readResource && !given.document) gaps.push('stored-document');
  if (observation.readFirestore) gaps.push('stored-document');
  if (observation.readRequestResource && (method === 'create' || method === 'update') && !given.writeData) {
    gaps.push('write-data');
  }
  if (observation.readAuthToken && !given.claims) gaps.push('claim-values');
  if (observation.readAuthTokenEmail && !given.emailKnown) gaps.push('claim-values');
  const needs = unionOf(gaps, []);

  const matched = observation.matchedRule;
  let rule: Rule | undefined;
  if (matched !== undefined) {
    rule = definedOnly({ path: matched.path, line: matched.line });
  }

  const storageDetail: LocalStorageEvaluation = {};
  if (matched !== undefined) storageDetail.matchedPath = matched.path;
  if (matched?.line !== undefined) storageDetail.matchedLine = matched.line;
  if (needs.length === 0 && evaluated.reasons.length > 0) {
    storageDetail.reasons = [...evaluated.reasons];
  }
  const hasStorageDetail = Object.keys(storageDetail).length > 0;

  if (needs.length > 0) {
    const explanation: MutableStorageExplanation = {
      source: 'deployed',
      service: 'storage',
      target: snapshot.bucket,
      verdict: 'unevaluated',
      productionDisagrees: false,
      needs,
      drift: snapshot.drift,
      releaseName: snapshot.releaseName,
      rulesetId: snapshot.rulesetId,
      deployedHash: snapshot.hash,
    };
    if (rule !== undefined) explanation.rule = rule;
    if (hasStorageDetail) explanation.storage = storageDetail;
    return { ok: true, explanation: explanation as DeployedRulesExplanation };
  }

  const verdict = evaluated.allowed ? 'allow' : 'deny';
  const explanation: MutableStorageExplanation = {
    source: 'deployed',
    service: 'storage',
    target: snapshot.bucket,
    verdict,
    productionDisagrees: productionDisagreesWith(call, evaluated.allowed),
    drift: snapshot.drift,
    releaseName: snapshot.releaseName,
    rulesetId: snapshot.rulesetId,
    deployedHash: snapshot.hash,
  };
  if (rule !== undefined) explanation.rule = rule;
  if (hasStorageDetail) explanation.storage = storageDetail;
  return { ok: true, explanation: explanation as DeployedRulesExplanation };
}
