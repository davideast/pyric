/**
 * Rule-enforcement helper shared by every gated operation. Pulled
 * out so `upload.ts`, `download.ts`, and `metadata.ts` don't each
 * grow their own copy of the same dispatch.
 *
 * Behavior:
 *   - No rules configured → deny. Matches Firebase production fail-closed
 *     security invariants: bare `getStorage` with no `rules` option
 *     rejects client operations with `storage/unauthorized`.
 *   - A bucket with no rules deployed in permissive mode → allow, with no
 *     rule evaluated: the event says the bucket is open by its default
 *     policy rather than naming a synthetic rule.
 *   - Rules configured → call `evaluateStorageRules`. Throw
 *     `storage/unauthorized` with the evaluator's `reasons` joined
 *     into the message on denial.
 *
 * `listAll` DOES call this (ST-B2): Firebase Storage's `read`
 * permission governs both download and list, so `list.ts` enforces a
 * `read` check on the scanned prefix path. A previous v1 scope build
 * silently bypassed list — that contradicted the rules-enforcement
 * contract (a denied tree was still enumerable). When no rules are
 * configured the check fails closed (default-deny).
 *
 * Studio observability (storage-denial-events): every enforcement
 * decision — allow, deny, AND admin-plane bypass — lands on the
 * unified sandbox `onEvent`/`history()` stream as a `kind: 'operation'`
 * event, mirroring RTDB's `emitOperation` (see
 * `src/database/sandbox/backend.ts`) and Firestore's `RequestEvent`
 * deny path. Before this, a rules-denied storage op threw a plain
 * `StorageError` with NO trace on the event stream — invisible to
 * Studio's Traffic surface and the rules inspector. Field names are
 * chosen to match RTDB's `SandboxOperationEvent` exactly (`result`,
 * `reasons`, `rules.engine`/`.reason`, `origin`) so Traffic/inspector
 * work without Studio-side changes. The storage evaluator returns a
 * flat `{ allowed, reasons[] }` — no rule index/position is tracked —
 * so `rules.matchedRule`/`.ruleIndex` are always omitted rather than
 * fabricated.
 *
 * Emission is additive and best-effort: a throw from the emit path
 * never blocks the real allow/deny control flow, and a denial still
 * throws `StorageError` exactly as before — the error contract to
 * app code is unchanged.
 */
import {
  emitSandboxEvent,
  getClock,
  isSecretObservationKey,
  makeSandboxOperationEvent,
  observationText,
  redactEmails,
} from 'pyric/sandbox/internal';
import type { EventProvenance, Sandbox } from 'pyric/sandbox';
import { getAuthLens } from '../sandbox/internal/auth-lens.js';
import {
  storageOperationProvenance,
  storageRulesInForce,
  type CrossServiceIam,
  type StorageRulesInForce,
  type StorageService,
  type Target,
} from './service.js';
import { evaluateStorageRules } from './sandbox/rules-evaluator.js';
import { RuleEvalError } from './sandbox/rules-evaluation-error.js';
import type {
  EvaluationInput,
  FirestoreLookup,
  StorageRequestResource,
  StorageResource,
} from './sandbox/rules.js';
import { unauthorized } from './errors.js';
import { bindRulesBucket, rulesBucketName } from './sandbox/rules-bucket-name.js';

/**
 * Redacted `request.resource` and existing `resource` bindings captured beside
 * a denied Storage operation event for `pyric verify` replay, kept off the
 * live Traffic / Studio `SandboxOperationEvent.detail` payload.
 */
export interface RecordedStorageDeniedWrite {
  requestResource?: StorageRequestResource;
  resource?: StorageResource;
  /** True when one or more captured field values were replaced by redaction placeholders. */
  redacted?: true;
  /** Binding paths whose values were redacted (`request.resource.metadata`, `resource.metadata`, etc.). */
  redactedFields?: string[];
}

interface DeniedWriteStore {
  byEvent: Map<string, RecordedStorageDeniedWrite>;
  pruneAt: number;
}

type HistoryBearingSandbox = Pick<Sandbox, 'history'>;

const DENIED_WRITES_KEY = Symbol.for('pyric.storage.denied-writes');
const MIN_DENIED_WRITES_PRUNE_AT = 256;
const KNOWN_REDACTED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'request.resource.metadata',
  'request.resource.contentType',
  'request.resource.contentDisposition',
  'request.resource.contentEncoding',
  'request.resource.contentLanguage',
  'request.resource.cacheControl',
  'resource.metadata',
  'resource.contentType',
  'resource.contentDisposition',
  'resource.contentEncoding',
  'resource.contentLanguage',
  'resource.cacheControl',
]);

const globalDeniedWrites = globalThis as {
  [DENIED_WRITES_KEY]?: WeakMap<HistoryBearingSandbox, DeniedWriteStore>;
};
const STORAGE_DENIED_WRITES: WeakMap<HistoryBearingSandbox, DeniedWriteStore> =
  (globalDeniedWrites[DENIED_WRITES_KEY] ??= new WeakMap());

function pruneDeniedWrites(sandbox: HistoryBearingSandbox, store: DeniedWriteStore): void {
  const held = new Set(sandbox.history().map((event) => event.id));
  for (const id of store.byEvent.keys()) {
    if (!held.has(id)) store.byEvent.delete(id);
  }
  store.pruneAt = Math.max(MIN_DENIED_WRITES_PRUNE_AT, store.byEvent.size * 2);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeCapturedText(value: string): { value: string; redacted: boolean } {
  const next = redactEmails(observationText(value));
  return { value: next, redacted: next !== value };
}

function sanitizeStorageMetadata(
  metadata: unknown,
): { value: Record<string, string> | null | undefined; redacted: boolean } {
  if (metadata === undefined) return { value: undefined, redacted: false };
  if (metadata === null) return { value: null, redacted: false };
  if (!isPlainRecord(metadata)) return { value: undefined, redacted: false };
  const out: Record<string, string> = {};
  let redacted = false;
  for (const [key, raw] of Object.entries(metadata)) {
    if (typeof raw !== 'string') continue;
    let sanitizedValue: string;
    if (isSecretObservationKey(key)) {
      sanitizedValue = '[redacted]';
      redacted = true;
    } else {
      const checked = sanitizeCapturedText(raw);
      sanitizedValue = checked.value;
      if (checked.redacted) redacted = true;
    }
    // Preserve metadata keys verbatim so `size()` and `keys()` never collapse distinct keys.
    Object.defineProperty(out, key, {
      value: sanitizedValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { value: out, redacted };
}

function sanitizeOptionalHeader(
  rawValue: unknown,
  fieldPath: string,
  redactedFields: string[],
): string | undefined {
  if (typeof rawValue !== 'string') return undefined;
  const checked = sanitizeCapturedText(rawValue);
  if (checked.redacted) redactedFields.push(fieldPath);
  return checked.value;
}

function sanitizeNullableHeader(
  rawValue: unknown,
  fieldPath: string,
  redactedFields: string[],
): string | null | undefined {
  if (rawValue === null) return null;
  return sanitizeOptionalHeader(rawValue, fieldPath, redactedFields);
}

function sanitizeStorageRequestResource(
  raw: unknown,
): { resource: StorageRequestResource | undefined; redactedFields: string[] } {
  if (!isPlainRecord(raw)) return { resource: undefined, redactedFields: [] };
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size)) {
    return { resource: undefined, redactedFields: [] };
  }
  const out: StorageRequestResource = { size: raw.size };
  const redactedFields: string[] = [];

  // Keep `name` and `bucket` unredacted (the path is already on `opEvent.path`).
  if (typeof raw.name === 'string') out.name = raw.name;
  if (typeof raw.bucket === 'string') out.bucket = raw.bucket;

  const contentType = sanitizeOptionalHeader(raw.contentType, 'request.resource.contentType', redactedFields);
  if (contentType !== undefined) out.contentType = contentType;
  const contentDisposition = sanitizeNullableHeader(raw.contentDisposition, 'request.resource.contentDisposition', redactedFields);
  if (contentDisposition !== undefined) out.contentDisposition = contentDisposition;
  const contentEncoding = sanitizeNullableHeader(raw.contentEncoding, 'request.resource.contentEncoding', redactedFields);
  if (contentEncoding !== undefined) out.contentEncoding = contentEncoding;
  const contentLanguage = sanitizeNullableHeader(raw.contentLanguage, 'request.resource.contentLanguage', redactedFields);
  if (contentLanguage !== undefined) out.contentLanguage = contentLanguage;
  const cacheControl = sanitizeNullableHeader(raw.cacheControl, 'request.resource.cacheControl', redactedFields);
  if (cacheControl !== undefined) out.cacheControl = cacheControl;
  if (raw.metadata === null || isPlainRecord(raw.metadata)) {
    const checked = sanitizeStorageMetadata(raw.metadata);
    if (checked.value !== undefined) out.metadata = checked.value;
    if (checked.redacted) redactedFields.push('request.resource.metadata');
  }
  if (raw.generation === null || (typeof raw.generation === 'number' && Number.isFinite(raw.generation))) {
    out.generation = raw.generation;
  }
  if (raw.metageneration === null || (typeof raw.metageneration === 'number' && Number.isFinite(raw.metageneration))) {
    out.metageneration = raw.metageneration;
  }
  if (raw.etag === null) {
    out.etag = null;
  }
  return { resource: out, redactedFields };
}

function sanitizeStorageResource(
  raw: unknown,
): { resource: StorageResource | undefined; redactedFields: string[] } {
  if (!isPlainRecord(raw)) return { resource: undefined, redactedFields: [] };
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size)) {
    return { resource: undefined, redactedFields: [] };
  }
  const out: StorageResource = { size: raw.size };
  const redactedFields: string[] = [];

  if (typeof raw.name === 'string') out.name = raw.name;
  if (typeof raw.bucket === 'string') out.bucket = raw.bucket;
  const contentType = sanitizeOptionalHeader(raw.contentType, 'resource.contentType', redactedFields);
  if (contentType !== undefined) out.contentType = contentType;
  if (isPlainRecord(raw.metadata)) {
    const checked = sanitizeStorageMetadata(raw.metadata);
    if (checked.value !== null && checked.value !== undefined) out.metadata = checked.value;
    if (checked.redacted) redactedFields.push('resource.metadata');
  }
  if (typeof raw.timeCreated === 'string') out.timeCreated = raw.timeCreated;
  if (typeof raw.updated === 'string') out.updated = raw.updated;
  if (typeof raw.generation === 'number' && Number.isFinite(raw.generation)) {
    out.generation = raw.generation;
  }
  if (typeof raw.metageneration === 'number' && Number.isFinite(raw.metageneration)) {
    out.metageneration = raw.metageneration;
  }
  if (typeof raw.md5Hash === 'string') out.md5Hash = raw.md5Hash;
  if (typeof raw.crc32c === 'string') out.crc32c = raw.crc32c;
  if (typeof raw.etag === 'string') out.etag = raw.etag;
  const contentDisposition = sanitizeOptionalHeader(raw.contentDisposition, 'resource.contentDisposition', redactedFields);
  if (contentDisposition !== undefined) out.contentDisposition = contentDisposition;
  const contentEncoding = sanitizeOptionalHeader(raw.contentEncoding, 'resource.contentEncoding', redactedFields);
  if (contentEncoding !== undefined) out.contentEncoding = contentEncoding;
  const contentLanguage = sanitizeOptionalHeader(raw.contentLanguage, 'resource.contentLanguage', redactedFields);
  if (contentLanguage !== undefined) out.contentLanguage = contentLanguage;
  const cacheControl = sanitizeOptionalHeader(raw.cacheControl, 'resource.cacheControl', redactedFields);
  if (cacheControl !== undefined) out.cacheControl = cacheControl;
  return { resource: out, redactedFields };
}

/**
 * Validate and sanitize a recorded or persisted denied Storage write entry,
 * allowlisting known fields and preserving redaction markers across hydration.
 */
export function normalizeRecordedStorageDeniedWrite(
  raw: unknown,
): RecordedStorageDeniedWrite | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const req = sanitizeStorageRequestResource(raw.requestResource);
  const res = sanitizeStorageResource(raw.resource);
  if (req.resource === undefined && res.resource === undefined) return undefined;

  const priorFields = Array.isArray(raw.redactedFields)
    ? raw.redactedFields.filter(
        (item): item is string => typeof item === 'string' && KNOWN_REDACTED_FIELD_NAMES.has(item),
      )
    : [];
  const combinedFields = [...new Set([...priorFields, ...req.redactedFields, ...res.redactedFields])];
  const isRedacted = raw.redacted === true || combinedFields.length > 0;
  return {
    ...(req.resource === undefined ? {} : { requestResource: req.resource }),
    ...(res.resource === undefined ? {} : { resource: res.resource }),
    ...(isRedacted ? { redacted: true as const } : {}),
    ...(combinedFields.length > 0 ? { redactedFields: combinedFields } : {}),
  };
}

function recordStorageDeniedWrite(
  sandbox: HistoryBearingSandbox,
  eventId: string,
  input: EvaluationInput,
): void {
  const normalized = normalizeRecordedStorageDeniedWrite({
    requestResource: input.request.resource,
    resource: input.resource ?? undefined,
  });
  if (normalized === undefined) return;
  let store = STORAGE_DENIED_WRITES.get(sandbox);
  if (store === undefined) {
    store = { byEvent: new Map(), pruneAt: MIN_DENIED_WRITES_PRUNE_AT };
    STORAGE_DENIED_WRITES.set(sandbox, store);
  } else if (store.byEvent.size >= store.pruneAt) {
    pruneDeniedWrites(sandbox, store);
  }
  store.byEvent.set(eventId, normalized);
}

/**
 * Redacted resource bindings recorded for denied Storage operations on
 * `sandbox`, keyed by `SandboxOperationEvent.id` and pruned to events still
 * retained in `sandbox.history()`.
 */
export function storageDeniedWrites(
  sandbox: HistoryBearingSandbox,
): ReadonlyMap<string, RecordedStorageDeniedWrite> {
  const store = STORAGE_DENIED_WRITES.get(sandbox);
  if (store === undefined) return new Map();
  pruneDeniedWrites(sandbox, store);
  return store.byEvent;
}

/**
 * Restore redacted denied-write bindings onto a freshly hydrated worker
 * sandbox for events present in `sandbox.history()`.
 */
export function primeStorageDeniedWrites(
  sandbox: HistoryBearingSandbox,
  deniedWrites: Record<string, RecordedStorageDeniedWrite> | undefined,
): void {
  if (!isPlainRecord(deniedWrites)) return;
  const held = new Set(sandbox.history().map((event) => event.id));
  if (held.size === 0) return;
  let store = STORAGE_DENIED_WRITES.get(sandbox);
  for (const [eventId, entry] of Object.entries(deniedWrites)) {
    if (!held.has(eventId)) continue;
    const normalized = normalizeRecordedStorageDeniedWrite(entry);
    if (normalized === undefined) continue;
    if (store === undefined) {
      store = { byEvent: new Map(), pruneAt: MIN_DENIED_WRITES_PRUNE_AT };
      STORAGE_DENIED_WRITES.set(sandbox, store);
    }
    store.byEvent.set(eventId, normalized);
  }
  if (store !== undefined) {
    store.pruneAt = Math.max(MIN_DENIED_WRITES_PRUNE_AT, store.byEvent.size * 2);
  }
}

/** What {@link enforceRules} records besides deciding. */
export interface EnforceOptions {
  /**
   * `'denials'` records only a denial. An early check of an operation that a
   * later check decides again passes it, so the stream shows one decision
   * per operation: a chunked upload checks at its start and as it lands.
   */
  record?: 'every-decision' | 'denials';
}

export function enforceRules(
  service: StorageService,
  input: EvaluationInput,
  target?: Target,
  provenance?: EventProvenance,
  { record = 'every-decision' }: EnforceOptions = {},
): void {
  const boundProvenance = target?.kind === 'sandbox'
    ? storageOperationProvenance(target, provenance)
    : provenance;
  const recordsAllow = record === 'every-decision';
  // Where an allow or admin bypass is recorded; nowhere when only denials are.
  const allowTarget = recordsAllow ? target : undefined;
  // Admin plane (internal `getAdminStorageSandbox` handles): rules are
  // bypassed entirely — firebase-admin semantics. See `SandboxTarget.admin`.
  // Rules never ran; the event still lands so Studio can show the op, with
  // `result: 'not-applicable'` + `origin: 'admin'` — the same shape RTDB's
  // admin plane (`adminSet`/`adminGet`/...) emits, with an explicit
  // bypass disposition independent of source or auth-lens presentation.
  const isAdminPlane = target?.kind === 'sandbox' && (
    target.admin === true || (target.currentAuth !== undefined && getAuthLens()?.mode === 'admin')
  );
  if (isAdminPlane) {
    emitOperation(allowTarget, input, 'not-applicable', undefined, 'admin', false, boundProvenance);
    return;
  }
  const inForce = rulesFor(service, target);
  if (inForce.kind === 'open') {
    emitOperation(allowTarget, input, 'allow', [openBucketReason(inForce.bucket)], 'user', false, boundProvenance, 'allow');
    return;
  }
  if (inForce.kind !== 'rules') {
    const reason = noRulesReason(inForce);
    emitOperation(target, input, 'deny', [reason], 'user', false, boundProvenance);
    throw unauthorized(input.request.method, input.request.path, ` — ${reason}`, deniedBucketName(target));
  }
  const evaluationInput = target ? withCanonicalRulesPath(input, target) : input;
  // `request.time` is the sandbox's clock when the caller has a sandbox handle,
  // so a `request.time < timestamp.date(...)` rule flips with it. A pure
  // evaluation with no target keeps the evaluator's own wall-clock default.
  const requestTime = target ? getClock(target.sandbox).date() : undefined;
  const result = evaluateStorageRules(
    inForce.rules,
    evaluationInput,
    requestTime,
    firestoreLookupFor(target, service.crossServiceIam),
  );
  if (!result.allowed) {
    emitOperation(target, input, 'deny', result.reasons, 'user', true, boundProvenance);
    const detail = result.reasons.length > 0 ? ` — ${result.reasons.join('; ')}` : '';
    throw unauthorized(input.request.method, input.request.path, detail, deniedBucketName(target));
  }
  emitOperation(allowTarget, input, 'allow', result.reasons, 'user', true, boundProvenance);
}

/** The name a denial gives the bucket: the one its rules saw, when the request came through a sandbox handle. */
function deniedBucketName(target: Target | undefined): string | undefined {
  if (target?.kind !== 'sandbox') return undefined;
  return rulesBucketName(target.bucket, target.bucketName);
}

/** The rules a request is checked against: its bucket's, through a sandbox handle. */
function rulesFor(service: StorageService, target: Target | undefined): StorageRulesInForce {
  if (target !== undefined) return storageRulesInForce(service, target);
  if (service.rules) return { kind: 'rules', rules: service.rules };
  return { kind: 'none' };
}

/** Why a request to a bucket with no rules deployed is allowed in permissive mode. */
function openBucketReason(bucket: string): string {
  return `Storage bucket "${bucket}" has no rules deployed in firebase.json; permissive mode allows every client operation on it.`;
}

/** Why a request with no rules to check denies. A locked bucket names the fix. */
function noRulesReason(inForce: Exclude<StorageRulesInForce, { kind: 'rules' | 'open' }>): string {
  if (inForce.kind === 'none') return 'No Storage rules configured; default deny.';
  if (inForce.kind === 'second-default') {
    return `Storage bucket "${inForce.bucket}" is a second default bucket in this sandbox, which already serves "${inForce.defaultBucket}" as its default bucket, so pyric denies every client operation on it rather than share that bucket's objects. Give each app the same storageBucket, or open the other bucket with getStorage(app, "gs://${inForce.bucket}").`;
  }
  const { bucket } = inForce;
  return `Storage bucket "${bucket}" has no rules deployed in firebase.json, so pyric denies every client operation on it. Add {"bucket": "${bucket}", "rules": "<file>"} to the storage array.`;
}

/**
 * Firebase's modular Storage SDK exposes object-relative references, while
 * Storage Rules match those objects below `/b/{bucket}/o`, under the bucket's
 * real name. Keep the public reference, persistence key, errors, and emitted
 * Traffic path object-relative; canonicalize only the evaluator input at this
 * boundary, under the name the caller knows the bucket by.
 */
function withCanonicalRulesPath(input: EvaluationInput, target: Target): EvaluationInput {
  return bindRulesBucket(input, target.bucket, rulesBucketName(target.bucket, target.bucketName));
}

/**
 * Build + emit the `SandboxOperationEvent` for one enforcement decision.
 * No-op for bare `StorageService` calls with no `target` (unit tests that drive
 * `enforceRules` directly without a sandbox handle).
 */
function emitOperation(
  target: Target | undefined,
  input: EvaluationInput,
  result: 'allow' | 'deny' | 'not-applicable',
  reasons: string[] | undefined,
  origin: 'user' | 'admin',
  evaluated: boolean,
  provenance: EventProvenance | undefined,
  defaultPolicy?: 'allow',
): void {
  if (!target) return;
  try {
    const operationEvent = makeSandboxOperationEvent({
      at: getClock(target.sandbox).now(),
      service: 'storage',
      method: input.request.method,
      path: input.request.path,
      auth: input.request.auth,
      result,
      origin,
      reasons,
      // The store key, and the name the rules saw it by, so a replay binds
      // the same name (ST-H2-4).
      // A permissive-mode open bucket says so, since no rule decided it.
      detail: {
        bucket: target.bucket,
        bucketName: rulesBucketName(target.bucket, target.bucketName),
        ...(defaultPolicy === undefined ? {} : { defaultPolicy }),
      },
      rulesDisposition: origin === 'admin'
        ? { kind: 'bypassed', reason: 'admin' }
        : evaluated
          ? { kind: 'evaluated', verdict: result === 'deny' ? 'deny' : 'allow' }
          : { kind: 'not-evaluated', reason: 'no-rules' },
      rules: evaluated
        ? {
            engine: 'storage',
            reason: reasons && reasons.length > 0 ? reasons.join('; ') : undefined,
          }
        : undefined,
    });
    if (result === 'deny') {
      recordStorageDeniedWrite(target.sandbox, operationEvent.id, input);
    }
    emitSandboxEvent(
      target.sandbox,
      operationEvent,
      { ...provenance, service: 'storage' },
    );
  } catch {
    // Observational — never let event emission break storage enforcement.
  }
}

/**
 * Build the {@link FirestoreLookup} a rule's `firestore.get()/exists()`
 * calls read from. Only sandbox targets have Firestore data reachable
 * in-process: `sandbox.admin.getDocument` is a SYNCHRONOUS, rules-bypassing
 * in-memory read of the SAME per-sandbox store the user-plane writes to, so
 * the enforcement seam stays synchronous AND the lookup is invoked lazily
 * during evaluation (honoring short-circuit) exactly like production.
 *
 * Calls without a target get no lookup — a rule that reaches for
 * `firestore.*` there denies "unsupported" rather than false-allowing.
 *
 * `crossServiceIam: 'denied'` models the production project state WITHOUT
 * `roles/firebaserules.firestoreServiceAgent` on the Storage service agent:
 * the lookup capability is still injected (so path validation and laziness
 * behave identically), but every EXECUTED get/exists fails. See
 * {@link crossServiceIamDeniedLookup}.
 */
function firestoreLookupFor(
  target: Target | undefined,
  crossServiceIam: CrossServiceIam,
): FirestoreLookup | undefined {
  if (!target) return undefined;
  return storageFirestoreLookup(target.sandbox, crossServiceIam);
}

/**
 * The lookup one sandbox's Storage rules read `firestore.get()/exists()` from,
 * under one IAM posture.
 *
 * Enforcement is not the only reader of it. A rules simulation asks the same
 * question of the same ruleset without issuing the operation, and a simulation
 * that built its own lookup, or none, would answer a cross-service rule
 * differently from the operation it is meant to predict. So the construction
 * lives here, once, and both paths call it.
 */
export function storageFirestoreLookup(
  sandbox: Sandbox,
  crossServiceIam: CrossServiceIam,
): FirestoreLookup {
  if (crossServiceIam === 'denied') return crossServiceIamDeniedLookup();
  const admin = sandbox.admin;
  return {
    get: (path) => admin.getDocument(path) as Record<string, unknown> | null,
    exists: (path) => admin.getDocument(path) !== null,
  };
}

/**
 * The `crossServiceIam: 'denied'` lookup: every executed
 * `firestore.get()/exists()` throws a {@link RuleEvalError} naming the
 * missing service-agent role, so the rule denies with that reason,
 * mirroring production's IAM-disabled boundary captured by conformance
 * observation `stdlib-realstorage-p3-lookup-budget` (row storage-rules#134):
 * every lookup-executing family DENIES while a short-circuited lookup is
 * never invoked and its rule still ALLOWS. The capture pins only that
 * executed-lookup/short-circuit boundary; how an IAM failure interacts
 * with CEL `&&`/`||` error absorption is NOT pinned by it (no absorption
 * family ran IAM-disabled), so this uses the same absorbable
 * {@link RuleEvalError} class as the existing no-capability deny path.
 *
 * Exported for the conformance replay test
 * (`packages/conformance/test/src/storage-stdlib-real-replay.test.ts`),
 * which runs the captured IAM-disabled matrix against the evaluator with
 * THIS production lookup, not a hand-rolled twin.
 */
export function crossServiceIamDeniedLookup(): FirestoreLookup {
  const fail = (method: 'get' | 'exists'): never => {
    throw new RuleEvalError(
      `firestore.${method}() failed: cross-service Firestore access is not authorized: ` +
        "the Storage service agent lacks roles/firebaserules.firestoreServiceAgent (crossServiceIam: 'denied')",
    );
  };
  return {
    get: () => fail('get'),
    exists: () => fail('exists'),
  };
}
