import type { EvaluationInput, StorageResource } from './rules.js';
import { RuleError } from './rules-values.js';
import { normalizeAuthState } from '../../sandbox/sandbox-context.js';

/**
 * Build the `resource.*` binding from the existing-object record, converting
 * the ISO-8601 time fields to epoch millis so they compare numerically against
 * `request.time` (which {@link buildRequestObject} models the same way) and
 * against each other (`resource.timeCreated == resource.updated`).
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
    timeCreated: isoToMillis(resource.timeCreated),
    updated: isoToMillis(resource.updated),
  };
}

/** ISO-8601 → epoch millis. An unparseable or absent value stays `undefined`
 *  (→ absent-property error → deny) rather than becoming `NaN`. */
function isoToMillis(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

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
    // `request.time` as epoch millis — see the timestamp constructors in
    // `evalMethodCall`, which produce the same representation so comparisons
    // like `request.time < timestamp.date(2030, 1, 1)` are plain numerics.
    time: now,
  };
  return request;
}
