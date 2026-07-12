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

const services = new Set(["firestore", "rtdb", "storage"]);
const dimensions = new Set<MutationDimension>([
  "path",
  "query",
  "payload",
  "operation",
]);
const firestoreMethods = new Set([
  "get",
  "list",
  "create",
  "set",
  "merge",
  "update",
  "delete",
]);
const rtdbMethods = new Set(["get", "set", "update", "remove"]);
const storageMethods = new Set([
  "get",
  "list",
  "upload",
  "updateMetadata",
  "delete",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  message: string,
): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssuranceInputError(message);
  }
}

function enumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  message: string,
): asserts value is string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new AssuranceInputError(message);
  }
}

export function assertTarget(
  target: unknown,
): asserts target is LocalFirebaseTarget {
  if (!isRecord(target)) {
    throw new AssuranceInputError("target must be an object.");
  }
  if (target.schema !== ASSURANCE_TARGET_SCHEMA) {
    throw new AssuranceInputError(
      `target schema must be '${ASSURANCE_TARGET_SCHEMA}'.`,
    );
  }
  if (target.network !== "forbid") {
    throw new AssuranceInputError(
      "assurance v1 requires target.network to be 'forbid'.",
    );
  }
  if (!isRecord(target.rules)) {
    throw new AssuranceInputError("target.rules must be an object.");
  }
  if (!isRecord(target.state)) {
    throw new AssuranceInputError("target.state must be an object.");
  }
  if (
    target.rules.firestore !== undefined &&
    typeof target.rules.firestore !== "string"
  ) {
    throw new AssuranceInputError("target.rules.firestore must be a string.");
  }
  if (
    target.rules.storage !== undefined &&
    typeof target.rules.storage !== "string"
  ) {
    throw new AssuranceInputError("target.rules.storage must be a string.");
  }
  if (target.rules.rtdb !== undefined) {
    if (!isRecord(target.rules.rtdb) || !isRecord(target.rules.rtdb.rules)) {
      throw new AssuranceInputError(
        "target.rules.rtdb must contain a rules object.",
      );
    }
  }
  if (
    target.state.firestore !== undefined &&
    !isRecord(target.state.firestore)
  ) {
    throw new AssuranceInputError("target.state.firestore must be an object.");
  }
  if (target.state.storage !== undefined) {
    if (!Array.isArray(target.state.storage)) {
      throw new AssuranceInputError("target.state.storage must be an array.");
    }
    for (const [index, object] of target.state.storage.entries()) {
      if (!isRecord(object)) {
        throw new AssuranceInputError(
          `target.state.storage[${index}] must be an object.`,
        );
      }
      requiredString(
        object.path,
        `target.state.storage[${index}] path is required.`,
      );
      if (typeof object.dataBase64 !== "string") {
        throw new AssuranceInputError(
          `target.state.storage[${index}] dataBase64 must be a string.`,
        );
      }
    }
  }
  if (target.state.auth !== undefined) {
    if (
      !isRecord(target.state.auth) ||
      !Array.isArray(target.state.auth.users)
    ) {
      throw new AssuranceInputError(
        "target.state.auth must contain a users array.",
      );
    }
    for (const [index, user] of target.state.auth.users.entries()) {
      if (!isRecord(user)) {
        throw new AssuranceInputError(
          `target.state.auth.users[${index}] must be an object.`,
        );
      }
      requiredString(
        user.uid,
        `target.state.auth.users[${index}] uid is required.`,
      );
      if (user.password !== undefined && typeof user.password !== "string") {
        throw new AssuranceInputError(
          `target.state.auth.users[${index}] password must be a string.`,
        );
      }
      if (user.customClaims !== undefined && !isRecord(user.customClaims)) {
        throw new AssuranceInputError(
          `target.state.auth.users[${index}] customClaims must be an object.`,
        );
      }
    }
  }
}

export function assertActor(actor: unknown): asserts actor is AssuranceActor {
  if (!isRecord(actor)) {
    throw new AssuranceInputError("actor must be an object.");
  }
  requiredString(actor.id, "actor id is required.");
  if (!isRecord(actor.acquisition)) {
    throw new AssuranceInputError(
      `actor '${actor.id}' must declare acquisition evidence.`,
    );
  }
  const kind = actor.acquisition.kind;
  enumValue(
    kind,
    new Set([
      "anonymous-request",
      "anonymous-account",
      "password",
      "fixture-user",
      "synthetic",
    ]),
    `actor '${actor.id}' has invalid acquisition kind '${String(kind)}'.`,
  );
  if (kind === "password") {
    requiredString(
      actor.acquisition.email,
      `actor '${actor.id}' password acquisition requires an email.`,
    );
    requiredString(
      actor.acquisition.password,
      `actor '${actor.id}' password acquisition requires a password.`,
    );
  }
  if (kind === "fixture-user" || kind === "synthetic") {
    requiredString(
      actor.acquisition.uid,
      `actor '${actor.id}' ${kind} acquisition requires a uid.`,
    );
  }
  if (
    kind === "synthetic" &&
    actor.acquisition.token !== undefined &&
    !isRecord(actor.acquisition.token)
  ) {
    throw new AssuranceInputError(
      `actor '${actor.id}' synthetic token must be an object.`,
    );
  }
}

export function assertInvariant(
  invariant: unknown,
): asserts invariant is SecurityInvariant {
  if (!isRecord(invariant)) {
    throw new AssuranceInputError("invariant must be an object.");
  }
  requiredString(invariant.id, "invariant id is required.");
  requiredString(
    invariant.statement,
    `invariant '${invariant.id}' statement is required.`,
  );
  enumValue(
    invariant.service,
    new Set([...services, "cross-service"]),
    `invariant '${invariant.id}' has invalid service '${String(invariant.service)}'.`,
  );
  enumValue(
    invariant.expected,
    new Set(["ALLOW", "DENY"]),
    `invariant '${invariant.id}' has invalid expected decision '${String(invariant.expected)}'.`,
  );
  enumValue(
    invariant.source,
    new Set(["declared", "authored-test", "captured", "derived", "agent"]),
    `invariant '${invariant.id}' has invalid source '${String(invariant.source)}'.`,
  );
  enumValue(
    invariant.confidence,
    new Set(["authoritative", "strong", "tentative"]),
    `invariant '${invariant.id}' has invalid confidence '${String(invariant.confidence)}'.`,
  );
}

export function assertObservation(
  observation: unknown,
): asserts observation is AssuranceObservation {
  if (!isRecord(observation)) {
    throw new AssuranceInputError("observation must be an object.");
  }
  requiredString(observation.id, "observation id is required.");
  requiredString(
    observation.actorId,
    `observation '${observation.id}' actorId is required.`,
  );
  if (observation.result !== "ALLOW") {
    throw new AssuranceInputError(
      `observation '${observation.id}' result must be 'ALLOW'.`,
    );
  }
  enumValue(
    observation.source,
    new Set(["captured", "authored", "discovered"]),
    `observation '${observation.id}' has invalid source '${String(observation.source)}'.`,
  );
  assertOperation(observation.operation, `observation '${observation.id}'`);
}

export function assertProbe(probe: unknown): asserts probe is AssuranceProbe {
  if (!isRecord(probe)) {
    throw new AssuranceInputError("probe must be an object.");
  }
  requiredString(probe.id, "probe id is required.");
  requiredString(probe.actorId, `probe '${probe.id}' actorId is required.`);
  requiredString(
    probe.invariantId,
    `probe '${probe.id}' invariantId is required.`,
  );
  assertOperation(probe.control, `probe '${probe.id}' control`);
  if (!isRecord(probe.mutation)) {
    throw new AssuranceInputError(`probe '${probe.id}' mutation is required.`);
  }
  enumValue(
    probe.mutation.dimension,
    dimensions,
    `probe '${probe.id}' has invalid or unsupported mutation dimension '${String(probe.mutation.dimension)}'.`,
  );
  requiredString(
    probe.mutation.description,
    `probe '${probe.id}' mutation description is required.`,
  );
  assertOperation(
    probe.mutation.operation,
    `probe '${probe.id}' mutation operation`,
  );
  if (
    probe.requires !== undefined &&
    (!Array.isArray(probe.requires) ||
      !probe.requires.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          (item.kind === "construct" || item.kind === "registry-row") &&
          typeof item.id === "string" &&
          item.id.length > 0,
      ))
  ) {
    throw new AssuranceInputError(
      `probe '${probe.id}' requires must be an array of { kind: 'construct' | 'registry-row', id } nodes.`,
    );
  }
  if (probe.control.service !== probe.mutation.operation.service) {
    throw new AssuranceInputError(
      `probe '${probe.id}' control and mutation must use the same service.`,
    );
  }

  const changed = changedDimensions(probe.control, probe.mutation.operation);
  if (changed.length !== 1 || changed[0] !== probe.mutation.dimension) {
    const changeDescription =
      changed.length === 0 ? "no dimensions" : changed.join(", ");
    throw new AssuranceInputError(
      `probe '${probe.id}' declares a '${probe.mutation.dimension}' mutation but changes ${changeDescription}.`,
    );
  }
}

function assertOperation(
  operation: unknown,
  label: string,
): asserts operation is FirebaseOperation {
  if (!isRecord(operation)) {
    throw new AssuranceInputError(`${label} must be an object.`);
  }
  enumValue(
    operation.service,
    services,
    `${label} has invalid service '${String(operation.service)}'.`,
  );
  requiredString(operation.path, `${label} path is required.`);
  const allowedMethods =
    operation.service === "firestore"
      ? firestoreMethods
      : operation.service === "rtdb"
        ? rtdbMethods
        : storageMethods;
  enumValue(
    operation.method,
    allowedMethods,
    `${label} has invalid ${operation.service} method '${String(operation.method)}'.`,
  );
  if (
    operation.service === "firestore" &&
    operation.data !== undefined &&
    !isRecord(operation.data)
  ) {
    throw new AssuranceInputError(`${label} data must be an object.`);
  }
  if (
    operation.service !== "storage" &&
    operation.query !== undefined &&
    !isRecord(operation.query)
  ) {
    throw new AssuranceInputError(`${label} query must be an object.`);
  }
  if (
    operation.service === "storage" &&
    operation.dataBase64 !== undefined &&
    typeof operation.dataBase64 !== "string"
  ) {
    throw new AssuranceInputError(`${label} dataBase64 must be a string.`);
  }
  if (operation.service === "storage") {
    if (
      operation.contentType !== undefined &&
      typeof operation.contentType !== "string"
    ) {
      throw new AssuranceInputError(`${label} contentType must be a string.`);
    }
    if (operation.customMetadata !== undefined) {
      if (
        !isRecord(operation.customMetadata) ||
        !Object.values(operation.customMetadata).every(
          (value) => typeof value === "string",
        )
      ) {
        throw new AssuranceInputError(
          `${label} customMetadata must contain only string values.`,
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
