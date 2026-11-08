/**
 * Decodes `/__pyric/state` envelopes (`pyric-v3-records` bundles and legacy
 * controller snapshots) into lossless `SandboxSnapshot` and `LocalFirebaseTarget`
 * service maps without mutating any live state.
 */
import { withPriorities, type InlinePriority } from "pyric/rules/internal/rtdb";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  decodeImportBundle,
  encodeSnapshotMap,
  parseResourcePattern,
  renderResourcePattern,
  type EncodedMap,
  type SnapshotUserRecord,
} from "pyric/sandbox/internal";
import type { PyricStateFile } from "../serve/state-file.js";
import { defineOwn, getOwn, isUnsafeObjectKey } from "./derive-campaign-state.js";
import {
  AssuranceInputError,
  type AuthFixtureUser,
} from "./types.js";

type RtdbJsonInput = Parameters<typeof withPriorities>[0];

export interface DecodedLiveState {
  readonly firestoreByDb: Record<string, Record<string, EncodedMap>>;
  readonly defaultTargetFirestore: Record<string, EncodedMap>;
  readonly rtdbByInstance: Record<string, unknown>;
  readonly defaultTargetRtdb: unknown;
  readonly rtdbInstanceRules: Record<string, { rules: Record<string, unknown> }>;
  readonly snapshotUsers: SnapshotUserRecord[];
  readonly fixtureUsers: AuthFixtureUser[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function storeEncodedFirestoreDoc(
  firestoreByDb: Record<string, Record<string, EncodedMap>>,
  defaultTargetFirestore: Record<string, EncodedMap>,
  rawDocPath: string,
  encodedFields: EncodedMap,
): void {
  const pattern = parseResourcePattern("firestore", rawDocPath);
  const dbId = pattern.resourceId;
  const docPath = renderResourcePattern(pattern);
  if (docPath.length === 0) return;

  let dbMap = getOwn(firestoreByDb, dbId);
  if (dbMap === undefined) {
    dbMap = {};
    defineOwn(firestoreByDb, dbId, dbMap);
  }
  defineOwn(dbMap, docPath, encodedFields);

  if (dbId === DEFAULT_SNAPSHOT_RESOURCE) {
    defineOwn(defaultTargetFirestore, docPath, { ...encodedFields });
  }
}

function extractInlinePriorities(rawPriorities: unknown): InlinePriority[] {
  const inlineEntries: InlinePriority[] = [];
  if (!isPlainRecord(rawPriorities)) {
    return inlineEntries;
  }
  for (const [rawPath, priority] of Object.entries(rawPriorities)) {
    if (typeof priority === "string" || typeof priority === "number") {
      const segments = rawPath.split("/").filter((s) => s.length > 0);
      inlineEntries.push({ segments, priority });
    }
  }
  return inlineEntries;
}

function extractRtdbRulesWrapper(
  rawRules: unknown,
): { rules: Record<string, unknown> } | undefined {
  if (!isPlainRecord(rawRules) || !Object.hasOwn(rawRules, "rules")) {
    return undefined;
  }
  const inner = rawRules.rules;
  if (!isPlainRecord(inner)) {
    return undefined;
  }
  return { rules: { ...inner } };
}

function decodePersistedRtdbTree(rawRtdb: unknown): {
  tree: unknown;
  rules?: { rules: Record<string, unknown> };
  instances: Record<string, unknown>;
  instanceRules: Record<string, { rules: Record<string, unknown> }>;
} {
  const instances: Record<string, unknown> = {};
  const instanceRules: Record<string, { rules: Record<string, unknown> }> = {};

  if (!isPlainRecord(rawRtdb)) {
    return { tree: undefined, instances, instanceRules };
  }

  if (rawRtdb[".pyricRtdbPersistence"] !== 1) {
    return { tree: rawRtdb, instances, instanceRules };
  }

  const rawData = (rawRtdb.data ?? null) as RtdbJsonInput;
  const inlineEntries = extractInlinePriorities(rawRtdb.priorities);
  const tree = withPriorities(rawData, inlineEntries);
  const rulesWrapper = extractRtdbRulesWrapper(rawRtdb.rules);

  if (isPlainRecord(rawRtdb.instances)) {
    for (const [instName, instEnvelope] of Object.entries(rawRtdb.instances)) {
      if (isUnsafeObjectKey(instName)) continue;
      const decodedInst = decodePersistedRtdbTree(instEnvelope);
      if (decodedInst.tree !== undefined && decodedInst.tree !== null) {
        defineOwn(instances, instName, decodedInst.tree);
      }
      if (decodedInst.rules !== undefined) {
        defineOwn(instanceRules, instName, decodedInst.rules);
      }
    }
  }

  const out: {
    tree: unknown;
    rules?: { rules: Record<string, unknown> };
    instances: Record<string, unknown>;
    instanceRules: Record<string, { rules: Record<string, unknown> }>;
  } = {
    tree,
    instances,
    instanceRules,
  };
  if (rulesWrapper !== undefined) {
    out.rules = rulesWrapper;
  }
  return out;
}

function normalizeUserList(rawUsers: readonly unknown[]): {
  snapshotUsers: SnapshotUserRecord[];
  fixtureUsers: AuthFixtureUser[];
} {
  const snapshotUsers: SnapshotUserRecord[] = [];
  const fixtureUsers: AuthFixtureUser[] = [];

  for (const candidate of rawUsers) {
    if (!isPlainRecord(candidate)) continue;
    const uid = candidate.uid;
    if (typeof uid !== "string" || uid.length === 0) continue;

    const snapUser: {
      uid: string;
      email?: string;
      displayName?: string;
      photoUrl?: string;
      phoneNumber?: string;
      emailVerified?: boolean;
      disabled?: boolean;
      customClaims?: Record<string, unknown>;
      tenantId?: string;
      providerId?: string;
    } = { uid };
    const fixUser: AuthFixtureUser = { uid };

    if (typeof candidate.email === "string") {
      snapUser.email = candidate.email;
      fixUser.email = candidate.email;
    }
    if (typeof candidate.displayName === "string") {
      snapUser.displayName = candidate.displayName;
      fixUser.displayName = candidate.displayName;
    }
    if (typeof candidate.photoUrl === "string") {
      snapUser.photoUrl = candidate.photoUrl;
    }
    if (typeof candidate.phoneNumber === "string") {
      snapUser.phoneNumber = candidate.phoneNumber;
    }
    if (typeof candidate.emailVerified === "boolean") {
      snapUser.emailVerified = candidate.emailVerified;
      fixUser.emailVerified = candidate.emailVerified;
    }
    if (typeof candidate.disabled === "boolean") {
      snapUser.disabled = candidate.disabled;
    }
    if (typeof candidate.tenantId === "string") {
      snapUser.tenantId = candidate.tenantId;
    }
    if (typeof candidate.providerId === "string") {
      snapUser.providerId = candidate.providerId;
    }
    if (isPlainRecord(candidate.customClaims)) {
      snapUser.customClaims = { ...candidate.customClaims };
      fixUser.customClaims = { ...candidate.customClaims };
    }

    snapshotUsers.push(snapUser);
    fixtureUsers.push(fixUser);
  }

  return { snapshotUsers, fixtureUsers };
}

function isV3RecordBundle(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.format === "pyric-v3-records") return true;
  return Object.hasOwn(value, "records") && isPlainRecord(value.records);
}

export function decodeLiveStatePayload(
  stateBody: PyricStateFile | null,
): DecodedLiveState {
  const firestoreByDb: Record<string, Record<string, EncodedMap>> = {
    [DEFAULT_SNAPSHOT_RESOURCE]: {},
  };
  const defaultTargetFirestore: Record<string, EncodedMap> = {};
  const rtdbByInstance: Record<string, unknown> = {};
  let defaultTargetRtdb: unknown;
  const rtdbInstanceRules: Record<string, { rules: Record<string, unknown> }> = {};

  if (stateBody === null) {
    return {
      firestoreByDb,
      defaultTargetFirestore,
      rtdbByInstance,
      defaultTargetRtdb,
      rtdbInstanceRules,
      snapshotUsers: [],
      fixtureUsers: [],
    };
  }

  let controllerUsers: readonly unknown[] | undefined;
  const rawFirestore = stateBody.firestore;

  if (isV3RecordBundle(rawFirestore)) {
    let decoded: ReturnType<typeof decodeImportBundle>;
    try {
      decoded = decodeImportBundle(JSON.stringify(rawFirestore));
    } catch (error) {
      let detail = String(error);
      if (error instanceof Error) detail = error.message;
      throw new AssuranceInputError(
        `Invalid pyric-v3-records state bundle from '/__pyric/state': ${detail}`,
      );
    }

    for (const [rawDocPath, docData] of Object.entries(decoded.firestore)) {
      if (isPlainRecord(docData)) {
        storeEncodedFirestoreDoc(
          firestoreByDb,
          defaultTargetFirestore,
          rawDocPath,
          encodeSnapshotMap(docData),
        );
      }
    }

    if (Object.hasOwn(decoded.services, "rtdb")) {
      const rtdbDecoded = decodePersistedRtdbTree(decoded.services.rtdb);
      if (rtdbDecoded.tree !== undefined && rtdbDecoded.tree !== null) {
        defineOwn(rtdbByInstance, DEFAULT_SNAPSHOT_RESOURCE, rtdbDecoded.tree);
        defaultTargetRtdb = structuredClone(rtdbDecoded.tree);
      }
      for (const [instName, instTree] of Object.entries(rtdbDecoded.instances)) {
        defineOwn(rtdbByInstance, instName, instTree);
      }
      for (const [instName, instRules] of Object.entries(rtdbDecoded.instanceRules)) {
        defineOwn(rtdbInstanceRules, instName, instRules);
      }
    }

    if (
      Object.hasOwn(decoded.services, "auth") &&
      isPlainRecord(decoded.services.auth) &&
      Array.isArray(decoded.services.auth.users)
    ) {
      controllerUsers = decoded.services.auth.users;
    }
  } else if (isPlainRecord(rawFirestore)) {
    let docsCandidate: unknown = rawFirestore;
    if (Object.hasOwn(rawFirestore, "firestore") && isPlainRecord(rawFirestore.firestore)) {
      docsCandidate = rawFirestore.firestore;
    }
    if (isPlainRecord(docsCandidate)) {
      for (const [rawDocPath, fields] of Object.entries(docsCandidate)) {
        if (isPlainRecord(fields)) {
          storeEncodedFirestoreDoc(
            firestoreByDb,
            defaultTargetFirestore,
            rawDocPath,
            { ...(fields as EncodedMap) },
          );
        }
      }
    }
    if (Object.hasOwn(rawFirestore, "services") && isPlainRecord(rawFirestore.services)) {
      const services = rawFirestore.services;
      if (Object.hasOwn(services, "rtdb")) {
        const rtdbDecoded = decodePersistedRtdbTree(services.rtdb);
        if (rtdbDecoded.tree !== undefined && rtdbDecoded.tree !== null) {
          defineOwn(rtdbByInstance, DEFAULT_SNAPSHOT_RESOURCE, rtdbDecoded.tree);
          defaultTargetRtdb = structuredClone(rtdbDecoded.tree);
        }
        for (const [instName, instTree] of Object.entries(rtdbDecoded.instances)) {
          defineOwn(rtdbByInstance, instName, instTree);
        }
        for (const [instName, instRules] of Object.entries(rtdbDecoded.instanceRules)) {
          defineOwn(rtdbInstanceRules, instName, instRules);
        }
      }
      if (
        Object.hasOwn(services, "auth") &&
        isPlainRecord(services.auth) &&
        Array.isArray(services.auth.users)
      ) {
        controllerUsers = services.auth.users;
      }
    }
  }

  let rawUsers: readonly unknown[] = stateBody.auth?.users ?? [];
  if (controllerUsers !== undefined) {
    rawUsers = controllerUsers;
  }
  const { snapshotUsers, fixtureUsers } = normalizeUserList(rawUsers);

  return {
    firestoreByDb,
    defaultTargetFirestore,
    rtdbByInstance,
    defaultTargetRtdb,
    rtdbInstanceRules,
    snapshotUsers,
    fixtureUsers,
  };
}
