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
import { resolveDatabaseInstance } from "pyric/sandbox/internal";
import { rtdbRulesSourceRejection } from "pyric/rules/internal/rtdb";
import {
  ASSURANCE_CAMPAIGN_SCHEMA,
  ASSURANCE_TARGET_SCHEMA,
  AssuranceInputError,
  type AssuranceActor,
  type AssuranceObservation,
  type AssuranceProbe,
  type FirebaseOperation,
  type AuthorizationCampaignSpec,
  type LocalFirebaseTarget,
  type MutationDimension,
  type SecurityInvariant,
} from "./types.js";

AssuranceInputError.prototype.name = "AssuranceInputError";

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
export const MUTATION_DIMENSIONS = [
  "path",
  "query",
  "payload",
  "operation",
] as const satisfies readonly MutationDimension[];

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
export const REQUIRES_KINDS = ["construct", "registry-row"] as const;

/** The comparison operators a Firestore query constraint can name. */
export const FIRESTORE_QUERY_OPS = [
  "<",
  "<=",
  "==",
  "!=",
  ">=",
  ">",
  "array-contains",
  "in",
  "not-in",
  "array-contains-any",
] as const;

/** The directions a Firestore orderBy clause can name. */
export const FIRESTORE_ORDER_DIRECTIONS = ["asc", "desc"] as const;

/** The orderBy kinds an RTDB query can name. */
export const RTDB_ORDER_KINDS = ["child", "key", "value", "priority"] as const;

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

/** Reject a value that is not a valid base64 string, naming where it sits. */
function assertValidBase64(
  value: unknown,
  where: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new AssuranceInputError(`${where} must be a string. ${received(value)}.`);
  }
  try {
    atob(value);
  } catch {
    throw new AssuranceInputError(`${where} must be valid base64. ${received(value)}.`);
  }
}

/** Reject a value that is not a positive integer, naming where it sits. */
function assertPositiveInteger(
  value: unknown,
  where: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new AssuranceInputError(
      `${where} must be a positive integer. ${received(value)}.`,
    );
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

  if (target.rules.rtdbInstances !== undefined) {
    requiredRecord(target.rules.rtdbInstances, `${where}.rules.rtdbInstances`);
    for (const [instance, rules] of Object.entries(target.rules.rtdbInstances)) {
      const at = `${where}.rules.rtdbInstances[${JSON.stringify(instance)}]`;
      requiredRecord(rules, at);
      requiredRecord((rules as any).rules, `${at}.rules`);

      try {
        resolveDatabaseInstance(instance);
      } catch (e) {
        throw new AssuranceInputError(`${at} names a malformed RTDB instance: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (target.state.rtdbInstances !== undefined) {
    requiredRecord(target.state.rtdbInstances, `${where}.state.rtdbInstances`);
    for (const [instance] of Object.entries(target.state.rtdbInstances)) {
      try {
        resolveDatabaseInstance(instance);
      } catch (e) {
        throw new AssuranceInputError(`${where}.state.rtdbInstances[${JSON.stringify(instance)}] names a malformed RTDB instance: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (target.state.firestore !== undefined) {
    requiredRecord(target.state.firestore, `${where}.state.firestore`);
    for (const [docPath, docData] of Object.entries(target.state.firestore)) {
      requiredRecord(docData, `${where}.state.firestore[${docPath}]`);
    }
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
      assertValidBase64(object.dataBase64, `${at}.dataBase64`);
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
  if (operation.service === "rtdb" && (operation as any).instance !== undefined) {
    requiredString((operation as any).instance, where, "instance");
  }
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
  if (operation.service === "rtdb" && operation.method === "update") {
    requiredRecord(operation.data, `${where}.data`);
  }
  if (operation.service !== "storage" && operation.query !== undefined) {
    const queryAt = `${where}.query`;
    requiredRecord(operation.query, queryAt);
    if (operation.service === "firestore") {
      if (operation.query.where !== undefined) {
        if (!Array.isArray(operation.query.where)) {
          throw new AssuranceInputError(
            `${queryAt}.where must be an array. ${received(operation.query.where)}.`,
          );
        }
        for (const [index, item] of operation.query.where.entries()) {
          const at = `${queryAt}.where[${index}]`;
          requiredRecord(item, at);
          requiredString(item.field, at, "field");
          enumValue(item.op, FIRESTORE_QUERY_OPS, at, "op");
        }
      }
      if (operation.query.orderBy !== undefined) {
        if (!Array.isArray(operation.query.orderBy)) {
          throw new AssuranceInputError(
            `${queryAt}.orderBy must be an array. ${received(operation.query.orderBy)}.`,
          );
        }
        for (const [index, item] of operation.query.orderBy.entries()) {
          const at = `${queryAt}.orderBy[${index}]`;
          requiredRecord(item, at);
          requiredString(item.field, at, "field");
          if (item.direction !== undefined) {
            enumValue(item.direction, FIRESTORE_ORDER_DIRECTIONS, at, "direction");
          }
        }
      }
      if (operation.query.limit !== undefined) {
        assertPositiveInteger(operation.query.limit, `${queryAt}.limit`);
      }
    } else if (operation.service === "rtdb") {
      if (operation.query.orderBy !== undefined) {
        const at = `${queryAt}.orderBy`;
        requiredRecord(operation.query.orderBy, at);
        enumValue(operation.query.orderBy.kind, RTDB_ORDER_KINDS, at, "kind");
        if (operation.query.orderBy.kind === "child") {
          requiredString(operation.query.orderBy.path, at, "path");
        }
      }
      if (operation.query.limitToFirst !== undefined) {
        assertPositiveInteger(
          operation.query.limitToFirst,
          `${queryAt}.limitToFirst`,
        );
      }
      if (operation.query.limitToLast !== undefined) {
        assertPositiveInteger(
          operation.query.limitToLast,
          `${queryAt}.limitToLast`,
        );
      }
    }
  }
  if (operation.service === "storage") {
    if (operation.method === "upload") {
      requiredString(operation.dataBase64, where, "dataBase64");
    }
    if (operation.dataBase64 !== undefined) {
      assertValidBase64(operation.dataBase64, `${where}.dataBase64`);
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
    .filter((key) => record[key] !== undefined)
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


export function assertCampaign(spec: AuthorizationCampaignSpec): void {
  if (spec.schema !== ASSURANCE_CAMPAIGN_SCHEMA) {
    throw new AssuranceInputError(
      `campaign schema must be '${ASSURANCE_CAMPAIGN_SCHEMA}'.`,
    );
  }
  if (!spec.id.trim())
    throw new AssuranceInputError("campaign id is required.");
  assertTarget(spec.target);
  if (!Array.isArray(spec.actors)) {
    throw new AssuranceInputError("campaign actors must be an array.");
  }
  if (!Array.isArray(spec.invariants)) {
    throw new AssuranceInputError("campaign invariants must be an array.");
  }
  if (!Array.isArray(spec.probes)) {
    throw new AssuranceInputError("campaign probes must be an array.");
  }
  for (const actor of spec.actors) assertActor(actor);
  for (const invariant of spec.invariants) assertInvariant(invariant);
  for (const probe of spec.probes) assertProbe(probe);
  uniqueIds(spec.actors, "actor");
  uniqueIds(spec.invariants, "invariant");
  uniqueIds(spec.probes, "probe");

  const declaredRtdbInstances = Object.keys(spec.target.rules.rtdbInstances ?? {});
  for (const probe of spec.probes) {
    for (const op of [probe.control, probe.mutation.operation]) {
      // test what happens to unknown fields (unrecognized keys)
      const allowedKeys = new Set(["service", "method", "path", "data", "query", "dataBase64", "contentType", "customMetadata", "instance"]);
      for (const key of Object.keys(op)) {
        if (!allowedKeys.has(key)) {
          throw new AssuranceInputError(`operation names unknown field '${key}'`);
        }
      }
      
      if (op.service === "rtdb" && op.instance !== undefined && op.instance !== "default") {
        let resolvedName;
        try {
          resolvedName = resolveDatabaseInstance(op.instance)!.name;
        } catch (e) {
          throw new AssuranceInputError(`invalid RTDB instance '${op.instance}': ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!declaredRtdbInstances.includes(resolvedName)) {
          throw new AssuranceInputError(`probe '${probe.id}' names undeclared RTDB instance '${op.instance}'. Declared instances: ${declaredRtdbInstances.length > 0 ? declaredRtdbInstances.join(", ") : "none"}.`);
        }
      }
    }
  }

  for (const probe of spec.probes) {
    const actor = spec.actors.find((item) => item.id === probe.actorId);
    const invariant = spec.invariants.find(
      (item) => item.id === probe.invariantId,
    );
    if (!actor)
      throw new AssuranceInputError(
        `probe '${probe.id}' references unknown actor '${probe.actorId}'.`,
      );
    if (!invariant) {
      throw new AssuranceInputError(
        `probe '${probe.id}' references unknown invariant '${probe.invariantId}'.`,
      );
    }
    if (
      invariant.service !== "cross-service" &&
      invariant.service !== probe.control.service
    ) {
      throw new AssuranceInputError(
        `probe '${probe.id}' service does not match invariant '${invariant.id}'.`,
      );
    }
  }
}

function uniqueIds(items: ReadonlyArray<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id.trim())
      throw new AssuranceInputError(`${label} id is required.`);
    if (seen.has(item.id))
      throw new AssuranceInputError(`duplicate ${label} id '${item.id}'.`);
    seen.add(item.id);
  }
}
