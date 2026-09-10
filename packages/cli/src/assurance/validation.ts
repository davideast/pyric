/**
 * What a well-formed campaign record looks like, and what a caller is told
 * when one is not.
 *
 * Every rejection here is read by a caller that is about to send the record
 * again, so it carries the three facts that decide the next call: where the
 * bad value sits, which field it is, and, when the field holds a closed set,
 * every value that set holds. A rejection that names only the offending value
 * leaves the caller guessing at the vocabulary, which is the one failure mode
 * these validators exist to remove.
 *
 * The `where` argument every assertion takes is that position: `actors[1]`,
 * `observations[0]`, `probes[2]`. A caller that validates one record on its
 * own passes nothing and gets the record's kind instead.
 */
import {
  ASSURANCE_TARGET_SCHEMA,
  AssuranceInputError,
  type AssuranceActor,
  type AssuranceObservation,
  type AssuranceProbe,
  type FirebaseOperation,
  type LocalFirebaseTarget,
  type MutationDimension,
  type SecurityInvariant,
} from "./types.js";

/** The services whose rules an operation can name. */
export const OPERATION_SERVICES = [
  "firestore",
  "rtdb",
  "storage",
] as const;

/** The services an invariant can be stated about, the whole-system one included. */
export const INVARIANT_SERVICES = [
  ...OPERATION_SERVICES,
  "cross-service",
] as const;

/** The one dimension a probe is allowed to change. */
export const MUTATION_DIMENSIONS: readonly MutationDimension[] = [
  "path",
  "query",
  "payload",
  "operation",
];

/** How an actor's identity is obtained. */
export const ACQUISITION_KINDS = [
  "anonymous-request",
  "anonymous-account",
  "password",
  "fixture-user",
  "synthetic",
] as const;

/** Where an observation came from. */
export const OBSERVATION_SOURCES = ["captured", "authored", "discovered"] as const;

/** The only result an observation records, because an observation is a known-good operation. */
export const OBSERVATION_RESULTS = ["ALLOW"] as const;

/** The decision an invariant expects. */
export const INVARIANT_DECISIONS = ["ALLOW", "DENY"] as const;

/** Where an invariant came from. */
export const INVARIANT_SOURCES = [
  "declared",
  "authored-test",
  "captured",
  "derived",
  "agent",
] as const;

/** How much weight an invariant carries. */
export const INVARIANT_CONFIDENCES = ["authoritative", "strong", "tentative"] as const;

/** The request methods each service evaluates, by the service that evaluates them. */
export const OPERATION_METHODS: Readonly<Record<string, readonly string[]>> = {
  firestore: ["get", "list", "create", "set", "merge", "update", "delete"],
  rtdb: ["get", "set", "update", "remove"],
  storage: ["get", "list", "upload", "updateMetadata", "delete"],
};

/** The requires node kinds a probe can carry. */
const REQUIRES_KINDS = ["construct", "registry-row"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One value as a rejection spells it, so a caller sees what was actually sent. */
function received(value: unknown): string {
  if (value === undefined) return "nothing was sent";
  if (typeof value === "string") return `'${value}' was sent`;
  return `${JSON.stringify(value)} was sent`;
}

/**
 * Reject a missing or empty string, naming where it sits and which field it is.
 */
function requiredString(
  value: unknown,
  where: string,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssuranceInputError(
      `${where}.${field} is required and must be a non-empty string. ${received(value)}.`,
    );
  }
}

/**
 * Reject a value outside a closed set, listing every value the set holds.
 * This is the rejection a caller reads before its next call, so the list is
 * the whole point of it.
 */
function enumValue(
  value: unknown,
  allowed: readonly string[],
  where: string,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AssuranceInputError(
      `${where}.${field} must be one of ${allowed.join(", ")}. ${received(value)}.`,
    );
  }
}

/** Reject a value that is not an object, naming where it sits. */
function requiredRecord(
  value: unknown,
  where: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AssuranceInputError(`${where} must be an object. ${received(value)}.`);
  }
}

export function assertTarget(
  target: unknown,
  where = "target",
): asserts target is LocalFirebaseTarget {
  requiredRecord(target, where);
  if (target.schema !== ASSURANCE_TARGET_SCHEMA) {
    throw new AssuranceInputError(
      `${where}.schema must be one of ${ASSURANCE_TARGET_SCHEMA}. ${received(target.schema)}.`,
    );
  }
  if (target.network !== "forbid") {
    throw new AssuranceInputError(
      `${where}.network must be one of forbid. ${received(target.network)}.`,
    );
  }
  requiredRecord(target.rules, `${where}.rules`);
  requiredRecord(target.state, `${where}.state`);
  if (
    target.rules.firestore !== undefined &&
    typeof target.rules.firestore !== "string"
  ) {
    throw new AssuranceInputError(
      `${where}.rules.firestore must be a string. ${received(target.rules.firestore)}.`,
    );
  }
  if (
    target.rules.storage !== undefined &&
    typeof target.rules.storage !== "string"
  ) {
    throw new AssuranceInputError(
      `${where}.rules.storage must be a string. ${received(target.rules.storage)}.`,
    );
  }
  if (target.rules.rtdb !== undefined) {
    requiredRecord(target.rules.rtdb, `${where}.rules.rtdb`);
    requiredRecord(target.rules.rtdb.rules, `${where}.rules.rtdb.rules`);
  }
  if (target.state.firestore !== undefined) {
    requiredRecord(target.state.firestore, `${where}.state.firestore`);
  }
  if (target.state.storage !== undefined) {
    if (!Array.isArray(target.state.storage)) {
      throw new AssuranceInputError(
        `${where}.state.storage must be an array. ${received(target.state.storage)}.`,
      );
    }
    for (const [index, object] of target.state.storage.entries()) {
      const at = `${where}.state.storage[${index}]`;
      requiredRecord(object, at);
      requiredString(object.path, at, "path");
      if (typeof object.dataBase64 !== "string") {
        throw new AssuranceInputError(
          `${at}.dataBase64 must be a string. ${received(object.dataBase64)}.`,
        );
      }
    }
  }
  if (target.state.auth !== undefined) {
    requiredRecord(target.state.auth, `${where}.state.auth`);
    if (!Array.isArray(target.state.auth.users)) {
      throw new AssuranceInputError(
        `${where}.state.auth.users must be an array. ${received(target.state.auth.users)}.`,
      );
    }
    for (const [index, user] of target.state.auth.users.entries()) {
      const at = `${where}.state.auth.users[${index}]`;
      requiredRecord(user, at);
      requiredString(user.uid, at, "uid");
      if (user.password !== undefined && typeof user.password !== "string") {
        throw new AssuranceInputError(
          `${at}.password must be a string. ${received(user.password)}.`,
        );
      }
      if (user.customClaims !== undefined) {
        requiredRecord(user.customClaims, `${at}.customClaims`);
      }
    }
  }
}

export function assertActor(
  actor: unknown,
  where = "actor",
): asserts actor is AssuranceActor {
  requiredRecord(actor, where);
  requiredString(actor.id, where, "id");
  requiredRecord(actor.acquisition, `${where}.acquisition`);
  const kind = actor.acquisition.kind;
  enumValue(kind, ACQUISITION_KINDS, where, "acquisition.kind");
  if (kind === "password") {
    requiredString(actor.acquisition.email, where, "acquisition.email");
    requiredString(actor.acquisition.password, where, "acquisition.password");
  }
  if (kind === "fixture-user" || kind === "synthetic") {
    requiredString(actor.acquisition.uid, where, "acquisition.uid");
  }
  if (kind === "synthetic" && actor.acquisition.token !== undefined) {
    requiredRecord(actor.acquisition.token, `${where}.acquisition.token`);
  }
}

export function assertInvariant(
  invariant: unknown,
  where = "invariant",
): asserts invariant is SecurityInvariant {
  requiredRecord(invariant, where);
  requiredString(invariant.id, where, "id");
  requiredString(invariant.statement, where, "statement");
  enumValue(invariant.service, INVARIANT_SERVICES, where, "service");
  enumValue(invariant.expected, INVARIANT_DECISIONS, where, "expected");
  enumValue(invariant.source, INVARIANT_SOURCES, where, "source");
  enumValue(invariant.confidence, INVARIANT_CONFIDENCES, where, "confidence");
}

export function assertObservation(
  observation: unknown,
  where = "observation",
): asserts observation is AssuranceObservation {
  requiredRecord(observation, where);
  requiredString(observation.id, where, "id");
  requiredString(observation.actorId, where, "actorId");
  enumValue(observation.result, OBSERVATION_RESULTS, where, "result");
  enumValue(observation.source, OBSERVATION_SOURCES, where, "source");
  assertOperation(observation.operation, `${where}.operation`);
}

export function assertProbe(
  probe: unknown,
  where = "probe",
): asserts probe is AssuranceProbe {
  requiredRecord(probe, where);
  requiredString(probe.id, where, "id");
  requiredString(probe.actorId, where, "actorId");
  requiredString(probe.invariantId, where, "invariantId");
  assertOperation(probe.control, `${where}.control`);
  requiredRecord(probe.mutation, `${where}.mutation`);
  enumValue(probe.mutation.dimension, MUTATION_DIMENSIONS, where, "mutation.dimension");
  requiredString(probe.mutation.description, where, "mutation.description");
  assertOperation(probe.mutation.operation, `${where}.mutation.operation`);
  assertRequires(probe.requires, where);

  if (probe.control.service !== probe.mutation.operation.service) {
    throw new AssuranceInputError(
      `${where}.control.service and ${where}.mutation.operation.service must name the same service.`,
    );
  }

  const changed = changedDimensions(probe.control, probe.mutation.operation);
  if (changed.length !== 1 || changed[0] !== probe.mutation.dimension) {
    const changeDescription =
      changed.length === 0 ? "no dimensions" : changed.join(", ");
    throw new AssuranceInputError(
      `${where}.mutation declares a '${probe.mutation.dimension}' mutation but changes ${changeDescription}.`,
    );
  }
}

/** Reject a requires list whose nodes do not name a kind and an id. */
function assertRequires(requires: unknown, where: string): void {
  if (requires === undefined) return;
  if (!Array.isArray(requires)) {
    throw new AssuranceInputError(
      `${where}.requires must be an array. ${received(requires)}.`,
    );
  }
  for (const [index, node] of requires.entries()) {
    const at = `${where}.requires[${index}]`;
    requiredRecord(node, at);
    enumValue(node.kind, REQUIRES_KINDS, at, "kind");
    requiredString(node.id, at, "id");
  }
}

function assertOperation(
  operation: unknown,
  where: string,
): asserts operation is FirebaseOperation {
  requiredRecord(operation, where);
  enumValue(operation.service, OPERATION_SERVICES, where, "service");
  requiredString(operation.path, where, "path");
  enumValue(
    operation.method,
    OPERATION_METHODS[operation.service as string]!,
    where,
    "method",
  );
  if (operation.service === "firestore" && operation.data !== undefined) {
    requiredRecord(operation.data, `${where}.data`);
  }
  if (operation.service !== "storage" && operation.query !== undefined) {
    requiredRecord(operation.query, `${where}.query`);
  }
  if (operation.service === "storage") {
    if (
      operation.dataBase64 !== undefined &&
      typeof operation.dataBase64 !== "string"
    ) {
      throw new AssuranceInputError(
        `${where}.dataBase64 must be a string. ${received(operation.dataBase64)}.`,
      );
    }
    if (
      operation.contentType !== undefined &&
      typeof operation.contentType !== "string"
    ) {
      throw new AssuranceInputError(
        `${where}.contentType must be a string. ${received(operation.contentType)}.`,
      );
    }
    if (operation.customMetadata !== undefined) {
      requiredRecord(operation.customMetadata, `${where}.customMetadata`);
      const values = Object.values(operation.customMetadata);
      if (!values.every((value) => typeof value === "string")) {
        throw new AssuranceInputError(
          `${where}.customMetadata must hold string values only.`,
        );
      }
    }
  }
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

function payload(operation: FirebaseOperation): unknown {
  if (operation.service === "storage") {
    return {
      dataBase64: operation.dataBase64,
      contentType: operation.contentType,
      customMetadata: operation.customMetadata,
    };
  }
  return operation.data;
}

function queryShape(operation: FirebaseOperation): unknown {
  return operation.service === "storage" ? undefined : operation.query;
}

export function changedDimensions(
  control: FirebaseOperation,
  mutation: FirebaseOperation,
): MutationDimension[] {
  const changed: MutationDimension[] = [];
  if (control.method !== mutation.method) changed.push("operation");
  if (control.path !== mutation.path) changed.push("path");
  if (stableValue(queryShape(control)) !== stableValue(queryShape(mutation))) {
    changed.push("query");
  }
  if (stableValue(payload(control)) !== stableValue(payload(mutation))) {
    changed.push("payload");
  }
  return changed;
}
