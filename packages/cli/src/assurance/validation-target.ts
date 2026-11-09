import { resolveDatabaseInstance } from "pyric/sandbox/internal";
import {
  ASSURANCE_TARGET_SCHEMA,
  AssuranceInputError,
  type LocalFirebaseTarget,
} from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One value as a rejection spells it, so a caller sees what was actually sent. */
export function received(value: unknown): string {
  if (value === undefined) return "nothing was sent";
  if (typeof value === "string") return `'${value}' was sent`;
  return `${JSON.stringify(value)} was sent`;
}

/**
 * Reject a missing or empty string, naming where it sits and which field it is.
 */
export function requiredString(
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

/** Reject a value outside a closed set, listing every value the set holds. */
export function enumValue(
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
export function requiredRecord(
  value: unknown,
  where: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AssuranceInputError(
      `${where} must be an object. ${received(value)}.`,
    );
  }
}

/** Reject a value that is not a valid base64 string, naming where it sits. */
export function assertValidBase64(
  value: unknown,
  where: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new AssuranceInputError(
      `${where} must be a string. ${received(value)}.`,
    );
  }
  try {
    atob(value);
  } catch {
    throw new AssuranceInputError(
      `${where} must be valid base64. ${received(value)}.`,
    );
  }
}

/** Reject a value that is not a positive integer, naming where it sits. */
export function assertPositiveInteger(
  value: unknown,
  where: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new AssuranceInputError(
      `${where} must be a positive integer. ${received(value)}.`,
    );
  }
}

function optionalStringField(
  value: unknown,
  where: string,
  field: string,
): void {
  if (value !== undefined && typeof value !== "string") {
    throw new AssuranceInputError(
      `${where}.${field} must be a string. ${received(value)}.`,
    );
  }
}

function optionalBooleanField(
  value: unknown,
  where: string,
  field: string,
): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new AssuranceInputError(
      `${where}.${field} must be a boolean. ${received(value)}.`,
    );
  }
}

function assertAuthUser(user: unknown, at: string): void {
  requiredRecord(user, at);
  requiredString(user.uid, at, "uid");
  if (
    user.email !== undefined &&
    user.email !== null &&
    typeof user.email !== "string"
  ) {
    throw new AssuranceInputError(
      `${at}.email must be a string or null. ${received(user.email)}.`,
    );
  }
  optionalStringField(user.password, at, "password");
  optionalStringField(user.displayName, at, "displayName");
  optionalStringField(user.photoUrl, at, "photoUrl");
  optionalStringField(user.phoneNumber, at, "phoneNumber");
  optionalStringField(user.tenantId, at, "tenantId");
  optionalStringField(user.providerId, at, "providerId");
  optionalBooleanField(user.emailVerified, at, "emailVerified");
  optionalBooleanField(user.disabled, at, "disabled");
  if (user.customClaims !== undefined) {
    requiredRecord(user.customClaims, `${at}.customClaims`);
  }
}

function assertStorageFixtureObject(object: unknown, at: string): void {
  requiredRecord(object, at);
  requiredString(object.path, at, "path");
  assertValidBase64(object.dataBase64, `${at}.dataBase64`);
  optionalStringField(object.contentType, at, "contentType");
  optionalStringField(object.cacheControl, at, "cacheControl");
  optionalStringField(object.contentDisposition, at, "contentDisposition");
  optionalStringField(object.contentEncoding, at, "contentEncoding");
  optionalStringField(object.contentLanguage, at, "contentLanguage");
  optionalStringField(object.timeCreated, at, "timeCreated");
  optionalStringField(object.updated, at, "updated");
  if (object.customMetadata !== undefined) {
    requiredRecord(object.customMetadata, `${at}.customMetadata`);
    const values = Object.values(object.customMetadata);
    if (!values.every((entry) => typeof entry === "string")) {
      throw new AssuranceInputError(
        `${at}.customMetadata must hold string values only.`,
      );
    }
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
  optionalStringField(target.rules.firestore, `${where}.rules`, "firestore");
  optionalStringField(target.rules.storage, `${where}.rules`, "storage");
  if (target.rules.rtdb !== undefined) {
    requiredRecord(target.rules.rtdb, `${where}.rules.rtdb`);
    requiredRecord(target.rules.rtdb.rules, `${where}.rules.rtdb.rules`);
  }

  const declaredRuleInstances = new Map<string, string>();
  if (target.rules.rtdbInstances !== undefined) {
    requiredRecord(target.rules.rtdbInstances, `${where}.rules.rtdbInstances`);
    for (const [instance, rules] of Object.entries(target.rules.rtdbInstances)) {
      const at = `${where}.rules.rtdbInstances[${JSON.stringify(instance)}]`;
      requiredRecord(rules, at);
      requiredRecord(rules.rules, `${at}.rules`);
      try {
        const resolvedName = resolveDatabaseInstance(instance)!.name;
        if (declaredRuleInstances.has(resolvedName)) {
          throw new AssuranceInputError(
            `${at} declares instance '${resolvedName}' which is already declared by key '${declaredRuleInstances.get(resolvedName)}'`,
          );
        }
        declaredRuleInstances.set(resolvedName, instance);
      } catch (error) {
        if (error instanceof AssuranceInputError) throw error;
        let detail = String(error);
        if (error instanceof Error) detail = error.message;
        throw new AssuranceInputError(
          `${at} names a malformed RTDB instance: ${detail}`,
        );
      }
    }
  }

  if (target.state.firestore !== undefined) {
    requiredRecord(target.state.firestore, `${where}.state.firestore`);
    for (const [docPath, docData] of Object.entries(target.state.firestore)) {
      requiredRecord(docData, `${where}.state.firestore[${docPath}]`);
    }
  }
  if (target.state.rtdbInstances !== undefined) {
    requiredRecord(target.state.rtdbInstances, `${where}.state.rtdbInstances`);
    const declaredStateInstances = new Map<string, string>();
    for (const [instance] of Object.entries(target.state.rtdbInstances)) {
      const at = `${where}.state.rtdbInstances[${JSON.stringify(instance)}]`;
      try {
        const resolvedName = resolveDatabaseInstance(instance)!.name;
        if (!declaredRuleInstances.has(resolvedName)) {
          throw new AssuranceInputError(
            `${at} provides state for instance '${resolvedName}' which has no declared rules`,
          );
        }
        if (declaredStateInstances.has(resolvedName)) {
          throw new AssuranceInputError(
            `${at} provides state for instance '${resolvedName}' which is already provided by key '${declaredStateInstances.get(resolvedName)}'`,
          );
        }
        declaredStateInstances.set(resolvedName, instance);
      } catch (error) {
        if (error instanceof AssuranceInputError) throw error;
        let detail = String(error);
        if (error instanceof Error) detail = error.message;
        throw new AssuranceInputError(
          `${at} names a malformed RTDB instance: ${detail}`,
        );
      }
    }
  }

  if (target.state.storage !== undefined) {
    if (!Array.isArray(target.state.storage)) {
      throw new AssuranceInputError(
        `${where}.state.storage must be an array. ${received(target.state.storage)}.`,
      );
    }
    for (const [index, object] of target.state.storage.entries()) {
      assertStorageFixtureObject(object, `${where}.state.storage[${index}]`);
    }
  }
  if (target.state.storageConfig !== undefined) {
    requiredRecord(target.state.storageConfig, `${where}.state.storageConfig`);
    if (target.state.storageConfig.crossServiceIam !== undefined) {
      enumValue(
        target.state.storageConfig.crossServiceIam,
        ["granted", "denied"],
        `${where}.state.storageConfig`,
        "crossServiceIam",
      );
    }
    if (target.state.storageConfig.undeployedBucketPolicy !== undefined) {
      enumValue(
        target.state.storageConfig.undeployedBucketPolicy,
        ["allow", "deny"],
        `${where}.state.storageConfig`,
        "undeployedBucketPolicy",
      );
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
      assertAuthUser(user, `${where}.state.auth.users[${index}]`);
    }
    if (target.state.auth.providers !== undefined) {
      requiredRecord(target.state.auth.providers, `${where}.state.auth.providers`);
      for (const [providerId, enabled] of Object.entries(target.state.auth.providers)) {
        optionalBooleanField(
          enabled,
          `${where}.state.auth.providers`,
          providerId,
        );
      }
    }
  }
}
