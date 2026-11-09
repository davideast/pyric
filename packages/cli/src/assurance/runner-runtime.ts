import { getAuth, sandbox as authSandbox, type SeedUser } from "pyric/auth";
import {
  getAdminDatabase,
  getDatabase,
  get as getRtdb,
  ref as rtdbRef,
  sandbox as rtdbSandbox,
  type Database,
} from "pyric/database";
import { getFirestore, type Firestore } from "pyric/firestore";
import { rtdbRulesSourceRejection } from "pyric/rules/internal/rtdb";
import {
  initializeSandbox,
  type AuthState,
  type LocalSandbox,
  type SandboxContext,
} from "pyric/sandbox";
import type { RtdbRulesJson } from "pyric/sandbox/database";
import { seedDocuments, setRules, snapshotDocuments } from "pyric/sandbox/firestore";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  decodeSnapshotMapForEnv,
  resolveDatabaseInstance,
} from "pyric/sandbox/internal";
import {
  getBlob,
  getMetadata,
  getStorageSandbox,
  listAll,
  ref as storageRef,
  uploadBytes,
  type FirebaseStorage,
} from "pyric/storage";
import {
  arrayBufferToBase64,
  deployStorageBucketRules,
  getAdminStorageSandbox,
} from "pyric/storage/internal";
import type {
  ActorEvidence,
  AssuranceActor,
  FirebaseOperation,
  LocalFirebaseTarget,
  StorageOperation,
} from "./types.js";

export interface ActorRuntime {
  evidence: ActorEvidence;
  auth: AuthState | null;
}

export interface ServiceRuntime {
  sandbox: LocalSandbox;
  actor: ActorRuntime;
  context: SandboxContext;
  firestore?: Firestore;
  rtdb?: Database;
  rtdbAdmin?: Database;
  storage?: FirebaseStorage;
  storageAdmin?: FirebaseStorage;
  storageDbName?: string;
}

let storageRunSequence = 0;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function targetHash(target: LocalFirebaseTarget): string {
  const input = stableStringify(target);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}

export function normalizeFirestorePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

export function normalizeFirestoreDocuments(
  docs: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  if (!docs) return {};
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [path, data] of Object.entries(docs)) {
    const cleanPath = normalizeFirestorePath(path);
    if (!cleanPath) continue;
    normalized[cleanPath] = decodeSnapshotMapForEnv(data);
  }
  return normalized;
}

function authUsers(target: LocalFirebaseTarget): SeedUser[] {
  return (target.state.auth?.users ?? []).map((user): SeedUser => {
    const record: SeedUser = { uid: user.uid };
    if (typeof user.email === "string") record.email = user.email;
    if (user.password !== undefined) record.password = user.password;
    if (user.displayName !== undefined) record.displayName = user.displayName;
    if (user.photoUrl !== undefined) record.photoUrl = user.photoUrl;
    if (user.phoneNumber !== undefined) record.phoneNumber = user.phoneNumber;
    if (user.tenantId !== undefined) record.tenantId = user.tenantId;
    if (user.providerId !== undefined) record.providerId = user.providerId;
    if (user.customClaims !== undefined) {
      record.customClaims = { ...user.customClaims };
    }
    if (user.disabled !== undefined) record.disabled = user.disabled;
    if (user.emailVerified !== undefined) {
      record.emailVerified = user.emailVerified;
    }
    return record;
  });
}

export function seedAuth(
  sandbox: LocalSandbox,
  target: LocalFirebaseTarget,
): ReturnType<typeof getAuth> {
  const auth = getAuth(sandbox);
  authSandbox.seedUsers(auth, authUsers(target));
  return auth;
}

export function acquireActor(
  sandbox: LocalSandbox,
  target: LocalFirebaseTarget,
  actor: AssuranceActor,
): ActorRuntime {
  const auth = seedAuth(sandbox, target);
  try {
    switch (actor.acquisition.kind) {
      case "anonymous-request":
        return {
          auth: null,
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "reachable",
          },
        };
      case "anonymous-account": {
        const session = authSandbox.mintSession(auth, { kind: "anonymous" });
        return {
          auth: session.state,
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "reachable",
            uid: session.user.uid,
          },
        };
      }
      case "password": {
        const acqEmail = actor.acquisition.email;
        const acqPassword = actor.acquisition.password;
        const matchedUser = (target.state.auth?.users ?? []).find(
          (u) => u.email === acqEmail,
        );
        const req: {
          kind: "password";
          email: string;
          password: string;
          tenantId?: string;
        } = {
          kind: "password",
          email: acqEmail,
          password: acqPassword,
        };
        if (matchedUser?.tenantId !== undefined) {
          req.tenantId = matchedUser.tenantId;
        }
        const session = authSandbox.mintSession(auth, req);
        return {
          auth: session.state,
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "reachable",
            uid: session.user.uid,
          },
        };
      }
      case "fixture-user": {
        const acqUid = actor.acquisition.uid;
        const matchedUser = (target.state.auth?.users ?? []).find(
          (u) => u.uid === acqUid,
        );
        const req: {
          kind: "uid";
          uid: string;
          tenantId?: string;
        } = {
          kind: "uid",
          uid: acqUid,
        };
        if (matchedUser?.tenantId !== undefined) {
          req.tenantId = matchedUser.tenantId;
        }
        const session = authSandbox.mintSession(auth, req);
        return {
          auth: session.state,
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "reachable",
            uid: session.user.uid,
          },
        };
      }
      case "synthetic":
        return {
          auth: {
            uid: actor.acquisition.uid,
            token: actor.acquisition.token ?? {},
          },
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "synthetic",
            uid: actor.acquisition.uid,
          },
        };
    }
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }
    return {
      auth: null,
      evidence: {
        actorId: actor.id,
        acquisition: actor.acquisition.kind,
        reachability: "unreachable",
        error: message,
      },
    };
  }
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function createRuntime(
  campaignId: string,
  probeId: string,
  phase: "control" | "mutation",
  target: LocalFirebaseTarget,
  actorRuntime: ActorRuntime,
  service: FirebaseOperation["service"],
): Promise<ServiceRuntime> {
  const sandbox = initializeSandbox();
  seedAuth(sandbox, target);
  const context = sandbox.withAuth(actorRuntime.auth);
  const runtime: ServiceRuntime = { sandbox, actor: actorRuntime, context };

  if (service === "firestore") {
    const firestore = getFirestore(context);
    setRules(sandbox, target.rules.firestore!);
    seedDocuments(sandbox, normalizeFirestoreDocuments(target.state.firestore));
    runtime.firestore = firestore;
    return runtime;
  }

  if (service === "rtdb") {
    const rtdb = getDatabase(context);
    const admin = getAdminDatabase(sandbox);
    if (target.rules.rtdb) {
      const rootRules: RtdbRulesJson = target.rules.rtdb;
      const refusal = rtdbRulesSourceRejection(rootRules);
      if (refusal !== null) {
        throw new Error(
          `The assurance target's database rules would not deploy. ${refusal.message}`,
        );
      }
      rtdbSandbox.setRules(rtdb, rootRules);
      rtdbSandbox.setData(admin, { "/": target.state.rtdb ?? {} });
    }
    runtime.rtdb = rtdb;
    runtime.rtdbAdmin = admin;

    if (target.rules.rtdbInstances) {
      const stateByResolved = new Map<string, unknown>();
      if (target.state.rtdbInstances) {
        for (const [key, val] of Object.entries(target.state.rtdbInstances)) {
          stateByResolved.set(resolveDatabaseInstance(key)!.name, val);
        }
      }
      for (const [instanceName, instanceValue] of Object.entries(
        target.rules.rtdbInstances,
      )) {
        const instanceRefusal = rtdbRulesSourceRejection(instanceValue);
        if (instanceRefusal !== null) {
          throw new Error(
            `The assurance target's database rules for instance '${instanceName}' would not deploy. ${instanceRefusal.message}`,
          );
        }
        const resolved = resolveDatabaseInstance(instanceName)!;
        const instDb = getDatabase(context, resolved.url);
        const instAdmin = getAdminDatabase(sandbox, resolved.url);
        rtdbSandbox.setRules(instDb, instanceValue);
        const instData = stateByResolved.get(resolved.name);
        rtdbSandbox.setData(instAdmin, { "/": instData ?? {} });
      }
    }
    return runtime;
  }

  if (target.state.firestore) {
    seedDocuments(sandbox, normalizeFirestoreDocuments(target.state.firestore));
  }
  const dbName = [
    "pyric-assurance",
    campaignId,
    probeId,
    phase,
    Date.now(),
    storageRunSequence++,
  ]
    .join("-")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const admin = getAdminStorageSandbox(sandbox, {
    dbName,
    rules: target.rules.storage!,
  });
  for (const [bucketName, bucketRules] of Object.entries(
    target.rules.storageBuckets ?? {},
  )) {
    deployStorageBucketRules(sandbox, bucketName, bucketRules);
  }
  const seedBucketObjects = async (
    bucketHandle: FirebaseStorage,
    objects: NonNullable<LocalFirebaseTarget["state"]["storage"]>,
  ): Promise<void> => {
    for (const object of objects) {
      const metadata: {
        contentType?: string;
        customMetadata?: Record<string, string>;
      } = {};
      if (object.contentType) {
        metadata.contentType = object.contentType;
      }
      if (object.customMetadata) {
        metadata.customMetadata = { ...object.customMetadata };
      }
      await uploadBytes(
        storageRef(bucketHandle, object.path),
        decodeBase64(object.dataBase64),
        metadata,
      );
    }
  };
  await seedBucketObjects(admin, target.state.storage ?? []);
  for (const [bucketName, objects] of Object.entries(
    target.state.storageBuckets ?? {},
  )) {
    const bucketAdmin = getAdminStorageSandbox(sandbox, {
      dbName,
      bucket: bucketName,
    });
    await seedBucketObjects(bucketAdmin, objects);
  }
  runtime.storageDbName = dbName;
  runtime.storageAdmin = admin;
  runtime.storage = getStorageSandbox(context, { dbName });
  return runtime;
}

async function readStorageState(
  operation: StorageOperation,
  storage: FirebaseStorage,
): Promise<unknown> {
  if (operation.method === "list") {
    const result = await listAll(storageRef(storage, operation.path));
    return {
      items: result.items.map((item) => item.fullPath),
      prefixes: result.prefixes.map((item) => item.fullPath),
    };
  }
  const target = storageRef(storage, operation.path);
  try {
    const [blob, metadata] = await Promise.all([
      getBlob(target),
      getMetadata(target),
    ]);
    const buffer = await blob.arrayBuffer();
    return {
      dataBase64: arrayBufferToBase64(buffer),
      text: new TextDecoder().decode(buffer),
      contentType: metadata.contentType,
      customMetadata: metadata.customMetadata ?? {},
    };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "storage/object-not-found") return null;
    throw error;
  }
}

export async function readState(
  operation: FirebaseOperation,
  runtime: ServiceRuntime,
): Promise<unknown> {
  if (operation.service === "firestore") {
    const state = snapshotDocuments(runtime.sandbox);
    const normalizedPath = normalizeFirestorePath(operation.path);
    if (operation.method === "list") {
      const prefix = `${normalizedPath}/`;
      return Object.fromEntries(
        Object.entries(state).filter(([path]) => path.startsWith(prefix)),
      );
    }
    return state[normalizedPath] ?? null;
  }
  if (operation.service === "rtdb") {
    let admin = runtime.rtdbAdmin!;
    if (operation.instance && operation.instance !== "default") {
      const url = resolveDatabaseInstance(operation.instance)!.url;
      admin = getAdminDatabase(runtime.sandbox, url);
    }
    return (await getRtdb(rtdbRef(admin, operation.path))).val();
  }
  if (
    operation.instance &&
    operation.instance !== "default" &&
    operation.instance !== DEFAULT_SNAPSHOT_RESOURCE &&
    runtime.storageDbName !== undefined
  ) {
    runtime.storageAdmin = getAdminStorageSandbox(runtime.sandbox, {
      dbName: runtime.storageDbName,
      bucket: operation.instance,
    });
    runtime.storage = getStorageSandbox(runtime.context, {
      dbName: runtime.storageDbName,
      bucket: operation.instance,
    });
  }
  return readStorageState(operation, runtime.storageAdmin!);
}
