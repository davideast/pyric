import { Timestamp } from '../../rules/simulator/wrappers/timestamp.js';
import type { EvaluationInput, StorageResource } from './rules.js';
import { RuleError } from './rules-values.js';
import { normalizeAuthState } from '../../sandbox/sandbox-context.js';

/**
 * Build the `resource.*` binding from the existing-object record, converting
 * the ISO-8601 time fields to timestamps so they compare against
 * `request.time` (which {@link buildRequestObject} models the same way),
 * against each other (`resource.timeCreated == resource.updated`), and take
 * durations (`resource.timeCreated + duration.value(1, 'h')`).
 *
 * A field the record does not carry is left `undefined`, which the
 * evaluator's property read reports as production's absent-property ERROR.
 */
export function buildResourceObject(resource: StorageResource): Record<string, unknown> {
  return {
    size: resource.size,
    contentType: resource.contentType,
    metadata: resource.metadata,
    name: resource.name,
    bucket: resource.bucket,
    generation: resource.generation,
    metageneration: resource.metageneration,
    timeCreated: isoToTimestamp(resource.timeCreated),
    updated: isoToTimestamp(resource.updated),
  };
}

/** ISO-8601 → timestamp. An unparseable or absent value stays `undefined`
 *  (→ absent-property error → deny) rather than becoming a NaN timestamp. */
function isoToTimestamp(iso: string | undefined): Timestamp | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return Timestamp.fromMillis(ms);
}

/** Build the `request.*` binding; `now` is the evaluation instant in epoch millis. */
export function buildRequestObject(input: EvaluationInput, now: number): Record<string, unknown> {
  const auth = input.request.auth;
  let requestAuth: unknown;
  if (auth === null || auth === undefined) {
    // The production Storage engine represents anonymous auth as an absent
    // property, not a usable null value. Ordinary `request.auth != null`
    // gates still deny, while conditionals cannot incorrectly select a
    // fallback branch from the synthetic null.
    requestAuth = new RuleError('Property auth is undefined on object.');
  } else {
    // Projecting a top-level `tenant` into `token.firebase.tenant` is one
    // cross-surface rule about an identity, not a Storage rules concern, so
    // the sandbox context owns it and every surface reads the same shape.
    requestAuth = normalizeAuthState(auth);
  }
  const request: Record<string, unknown> = {
    auth: requestAuth,
    // Production treats an operation without an incoming object (notably
    // delete/read) as an absent binding. A direct null comparison errors just
    // like a property read; neither may turn the missing value into an allow.
    resource: input.request.resource ?? new RuleError('Property resource is undefined on object.'),
    method: input.request.method,
    path: input.request.path,
    // The same Timestamp value `timestamp.date(...)` and `timestamp.value(...)`
    // build, so `request.time < timestamp.date(2030, 1, 1)` compares
    // timestamps and `request.time.year()` reads a component.
    time: Timestamp.fromMillis(now),
  };
  return request;
}
