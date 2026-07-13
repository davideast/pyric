import { getAuth, sandbox as authSandbox, type SeedUser } from "pyric/auth";
import {
  endAt as endAtRtdb,
  endBefore as endBeforeRtdb,
  equalTo as equalToRtdb,
  getAdminDatabase,
  getDatabase,
  get as getRtdb,
  limitToFirst as limitToFirstRtdb,
  limitToLast as limitToLastRtdb,
  orderByChild as orderByChildRtdb,
  orderByKey as orderByKeyRtdb,
  orderByValue as orderByValueRtdb,
  query as queryRtdb,
  ref as rtdbRef,
  remove as removeRtdb,
  sandbox as rtdbSandbox,
  set as setRtdb,
  startAfter as startAfterRtdb,
  startAt as startAtRtdb,
  update as updateRtdb,
  type Database,
  type QueryConstraint as RtdbQueryConstraint,
} from "pyric/database/modular";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type Query,
  type QueryConstraint,
} from "pyric/firestore";
import { seedDocuments, setRules } from "pyric/sandbox/firestore";
import {
  deleteObject,
  getBlob,
  getMetadata,
  getStorageSandbox,
  listAll,
  ref as storageRef,
  updateMetadata,
  uploadBytes,
  type FirebaseStorage,
} from "pyric/storage";
import { getAdminStorageSandbox } from "pyric/storage/internal";
import {
  initializeSandbox,
  type AuthState,
  type Sandbox,
  type SandboxEvent,
} from "pyric/sandbox";
import { qualifyProbe } from "./capabilities.js";
import {
  assertActor,
  assertInvariant,
  assertProbe,
  assertTarget,
} from "./validation.js";
import {
  ASSURANCE_CAMPAIGN_SCHEMA,
  ASSURANCE_REPORT_SCHEMA,
  AssuranceInputError,
  type ActorEvidence,
  type AssuranceActor,
  type AssuranceDecision,
  type AssuranceEventEvidence,
  type AssuranceProbe,
  type AssuranceProbeResult,
  type AuthorizationCampaignReport,
  type AuthorizationCampaignSpec,
  type FirebaseOperation,
  type LocalFirebaseTarget,
  type OperationEvidence,
  type ProbeClassification,
  type SecurityInvariant,
  type StateDiff,
  type StorageOperation,
} from "./types.js";

interface ActorRuntime {
  evidence: ActorEvidence;
  auth: AuthState | null;
}

interface ServiceRuntime {
  sandbox: Sandbox;
  actor: ActorRuntime;
  firestore?: Firestore;
  rtdb?: Database;
  rtdbAdmin?: Database;
  storage?: FirebaseStorage;
  storageAdmin?: FirebaseStorage;
}

interface ExecutedOperation {
  actorEvidence: ActorEvidence;
  evidence: OperationEvidence;
  stateDiff: StateDiff;
}

let storageRunSequence = 0;

function assertCampaign(spec: AuthorizationCampaignSpec): void {
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function targetHash(target: LocalFirebaseTarget): string {
  const input = stableStringify(target);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}

function authUsers(target: LocalFirebaseTarget): SeedUser[] {
  return (target.state.auth?.users ?? []).map((user) => ({
    uid: user.uid,
    email: user.email ?? `${user.uid}@fixture.pyric.invalid`,
    password: user.password ?? "__pyric_fixture_password__",
    ...(user.customClaims ? { customClaims: user.customClaims } : {}),
  }));
}

function seedAuth(
  sandbox: Sandbox,
  target: LocalFirebaseTarget,
): ReturnType<typeof getAuth> {
  const auth = getAuth(sandbox);
  authSandbox.seedUsers(auth, authUsers(target));
  for (const user of target.state.auth?.users ?? []) {
    if (user.disabled !== undefined || user.emailVerified !== undefined) {
      authSandbox.updateUser(auth, user.uid, {
        ...(user.disabled !== undefined ? { disabled: user.disabled } : {}),
        ...(user.emailVerified !== undefined
          ? { emailVerified: user.emailVerified }
          : {}),
      });
    }
  }
  return auth;
}

function acquireActor(
  sandbox: Sandbox,
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
        const session = authSandbox.mintSession(auth, {
          kind: "password",
          email: actor.acquisition.email,
          password: actor.acquisition.password,
        });
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
        const session = authSandbox.mintSession(auth, {
          kind: "uid",
          uid: actor.acquisition.uid,
        });
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
    return {
      auth: null,
      evidence: {
        actorId: actor.id,
        acquisition: actor.acquisition.kind,
        reachability: "unreachable",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function createRuntime(
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
  const runtime: ServiceRuntime = { sandbox, actor: actorRuntime };

  if (service === "firestore") {
    const firestore = getFirestore(context);
    setRules(sandbox, target.rules.firestore!);
    seedDocuments(sandbox, target.state.firestore ?? {});
    runtime.firestore = firestore;
  } else if (service === "rtdb") {
    const rtdb = getDatabase(context);
    const admin = getAdminDatabase(sandbox);
    rtdbSandbox.setRules(rtdb, target.rules.rtdb!);
    rtdbSandbox.setData(admin, { "/": target.state.rtdb ?? {} });
    runtime.rtdb = rtdb;
    runtime.rtdbAdmin = admin;
  } else {
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
    for (const object of target.state.storage ?? []) {
      await uploadBytes(
        storageRef(admin, object.path),
        decodeBase64(object.dataBase64),
        {
          ...(object.contentType ? { contentType: object.contentType } : {}),
          ...(object.customMetadata
            ? { customMetadata: object.customMetadata }
            : {}),
        },
      );
    }
    runtime.storageAdmin = admin;
    runtime.storage = getStorageSandbox(context, { dbName });
  }
  return runtime;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function eventEvidence(events: SandboxEvent[]): AssuranceEventEvidence[] {
  return events.map((event) => {
    const raw = event as unknown as Record<string, unknown>;
    return {
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      ...(typeof raw.at === "number" ? { at: raw.at } : {}),
      ...(typeof raw.kind === "string" ? { kind: raw.kind } : {}),
      ...(typeof raw.service === "string" ? { service: raw.service } : {}),
      ...(typeof raw.method === "string" ? { method: raw.method } : {}),
      ...(typeof raw.op === "string" ? { op: raw.op } : {}),
      ...(typeof raw.path === "string" ? { path: raw.path } : {}),
      ...(typeof raw.result === "string" ? { result: raw.result } : {}),
      ...(raw.auth !== undefined ? { auth: raw.auth } : {}),
      ...(raw.actor !== undefined ? { actor: raw.actor } : {}),
      ...(raw.authLens !== undefined ? { authLens: raw.authLens } : {}),
      ...(Array.isArray(raw.reasons) &&
      raw.reasons.every((item) => typeof item === "string")
        ? { reasons: raw.reasons as string[] }
        : {}),
      ...(raw.origin !== undefined ? { origin: raw.origin } : {}),
      ...(raw.request !== undefined ? { request: raw.request } : {}),
      ...(raw.resourceBefore !== undefined
        ? { resourceBefore: raw.resourceBefore }
        : {}),
      ...(raw.matchedRule !== undefined
        ? { matchedRule: raw.matchedRule }
        : {}),
      ...(raw.evaluatedRule !== undefined
        ? { evaluatedRule: raw.evaluatedRule }
        : {}),
      ...(raw.rules !== undefined ? { rules: raw.rules } : {}),
    };
  });
}

function errorDecision(error: unknown): {
  decision: AssuranceDecision;
  error: { code?: string; message: string };
} {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const codeString = typeof code === "string" ? code : undefined;
  const denied =
    /permission[-_ ]?denied|unauthorized/i.test(message) ||
    (codeString
      ? /permission[-_ ]?denied|unauthorized/i.test(codeString)
      : false);
  return {
    decision: denied ? "DENY" : "ERROR",
    error: { ...(codeString ? { code: codeString } : {}), message },
  };
}

async function executeFirestore(
  operation: FirebaseOperation,
  db: Firestore,
): Promise<unknown> {
  if (operation.service !== "firestore")
    throw new Error("Expected a Firestore operation.");
  switch (operation.method) {
    case "get": {
      const snapshot = await getDoc(doc(db, operation.path));
      const exists =
        typeof snapshot.exists === "function"
          ? snapshot.exists()
          : snapshot.exists;
      return exists ? snapshot.data() : null;
    }
    case "list": {
      const constraints: QueryConstraint[] = [];
      for (const item of operation.query?.where ?? []) {
        constraints.push(where(item.field, item.op, item.value));
      }
      for (const item of operation.query?.orderBy ?? []) {
        constraints.push(orderBy(item.field, item.direction));
      }
      if (operation.query?.limit !== undefined)
        constraints.push(limit(operation.query.limit));
      const source = constraints.length
        ? query(collection(db, operation.path), ...constraints)
        : collection(db, operation.path);
      const snapshot = await getDocs(source as Query);
      return snapshot.docs.map((item) => ({
        path: `${operation.path.replace(/\/$/, "")}/${item.id}`,
        data: item.data(),
      }));
    }
    case "create":
    case "set":
      await setDoc(doc(db, operation.path), operation.data ?? {});
      return null;
    case "merge":
      await setDoc(doc(db, operation.path), operation.data ?? {}, {
        merge: true,
      });
      return null;
    case "update":
      await updateDoc(doc(db, operation.path), operation.data ?? {});
      return null;
    case "delete":
      await deleteDoc(doc(db, operation.path));
      return null;
  }
}

async function executeRtdb(
  operation: FirebaseOperation,
  db: Database,
): Promise<unknown> {
  if (operation.service !== "rtdb")
    throw new Error("Expected an RTDB operation.");
  const target = rtdbRef(db, operation.path);
  switch (operation.method) {
    case "get": {
      const constraints: RtdbQueryConstraint[] = [];
      const querySpec = operation.query;
      if (querySpec?.orderBy?.kind === "child") {
        constraints.push(orderByChildRtdb(querySpec.orderBy.path));
      } else if (querySpec?.orderBy?.kind === "key") {
        constraints.push(orderByKeyRtdb());
      } else if (querySpec?.orderBy?.kind === "value") {
        constraints.push(orderByValueRtdb());
      }
      if (querySpec?.startAt) {
        constraints.push(
          startAtRtdb(querySpec.startAt.value as never, querySpec.startAt.key),
        );
      }
      if (querySpec?.startAfter) {
        constraints.push(
          startAfterRtdb(
            querySpec.startAfter.value as never,
            querySpec.startAfter.key,
          ),
        );
      }
      if (querySpec?.endAt) {
        constraints.push(
          endAtRtdb(querySpec.endAt.value as never, querySpec.endAt.key),
        );
      }
      if (querySpec?.endBefore) {
        constraints.push(
          endBeforeRtdb(
            querySpec.endBefore.value as never,
            querySpec.endBefore.key,
          ),
        );
      }
      if (querySpec?.equalTo) {
        constraints.push(
          equalToRtdb(querySpec.equalTo.value as never, querySpec.equalTo.key),
        );
      }
      if (querySpec?.limitToFirst !== undefined) {
        constraints.push(limitToFirstRtdb(querySpec.limitToFirst));
      }
      if (querySpec?.limitToLast !== undefined) {
        constraints.push(limitToLastRtdb(querySpec.limitToLast));
      }
      const source =
        constraints.length > 0 ? queryRtdb(target, ...constraints) : target;
      return (await getRtdb(source)).val();
    }
    case "set":
      await setRtdb(target, operation.data);
      return null;
    case "update":
      if (
        !operation.data ||
        typeof operation.data !== "object" ||
        Array.isArray(operation.data)
      ) {
        throw new Error("RTDB update data must be an object.");
      }
      await updateRtdb(target, operation.data as Record<string, unknown>);
      return null;
    case "remove":
      await removeRtdb(target);
      return null;
  }
}

async function executeStorage(
  operation: StorageOperation,
  storage: FirebaseStorage,
): Promise<unknown> {
  const target = storageRef(storage, operation.path);
  switch (operation.method) {
    case "get": {
      const [blob, metadata] = await Promise.all([
        getBlob(target),
        getMetadata(target),
      ]);
      return {
        text: await blob.text(),
        contentType: metadata.contentType,
        customMetadata: metadata.customMetadata ?? {},
      };
    }
    case "list": {
      const result = await listAll(target);
      return {
        items: result.items.map((item) => item.fullPath),
        prefixes: result.prefixes.map((item) => item.fullPath),
      };
    }
    case "upload": {
      if (!operation.dataBase64)
        throw new Error("Storage upload requires dataBase64.");
      const result = await uploadBytes(
        target,
        decodeBase64(operation.dataBase64),
        {
          ...(operation.contentType
            ? { contentType: operation.contentType }
            : {}),
          ...(operation.customMetadata
            ? { customMetadata: operation.customMetadata }
            : {}),
        },
      );
      return result.metadata;
    }
    case "updateMetadata":
      return updateMetadata(target, {
        ...(operation.contentType
          ? { contentType: operation.contentType }
          : {}),
        ...(operation.customMetadata
          ? { customMetadata: operation.customMetadata }
          : {}),
      });
    case "delete":
      await deleteObject(target);
      return null;
  }
}

async function readState(
  operation: FirebaseOperation,
  runtime: ServiceRuntime,
): Promise<unknown> {
  if (operation.service === "firestore") {
    const state = runtime.sandbox.snapshot().firestore;
    if (operation.method === "list") {
      const prefix = `${operation.path.replace(/\/$/, "")}/`;
      return Object.fromEntries(
        Object.entries(state).filter(([path]) => path.startsWith(prefix)),
      );
    }
    return state[operation.path] ?? null;
  }
  if (operation.service === "rtdb") {
    return (await getRtdb(rtdbRef(runtime.rtdbAdmin!, operation.path))).val();
  }
  return readStorageState(operation, runtime.storageAdmin!);
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
    return {
      text: await blob.text(),
      contentType: metadata.contentType,
      customMetadata: metadata.customMetadata ?? {},
    };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "storage/object-not-found") return null;
    throw error;
  }
}

async function executeOperation(
  campaignId: string,
  probeId: string,
  phase: "control" | "mutation",
  target: LocalFirebaseTarget,
  actorRuntime: ActorRuntime,
  operation: FirebaseOperation,
): Promise<ExecutedOperation> {
  const runtime = await createRuntime(
    campaignId,
    probeId,
    phase,
    target,
    actorRuntime,
    operation.service,
  );
  const before = await readState(operation, runtime);
  const eventOffset = runtime.sandbox.history().length;
  let decision: AssuranceDecision = "ALLOW";
  let output: unknown;
  let failure: { code?: string; message: string } | undefined;
  try {
    output =
      operation.service === "firestore"
        ? await executeFirestore(operation, runtime.firestore!)
        : operation.service === "rtdb"
          ? await executeRtdb(operation, runtime.rtdb!)
          : await executeStorage(operation, runtime.storage!);
  } catch (error) {
    const result = errorDecision(error);
    decision = result.decision;
    failure = result.error;
  }
  const events = eventEvidence(runtime.sandbox.history().slice(eventOffset));
  const after = await readState(operation, runtime);
  return {
    actorEvidence: runtime.actor.evidence,
    evidence: {
      operation,
      decision,
      ...(output !== undefined ? { output } : {}),
      ...(failure ? { error: failure } : {}),
      events,
    },
    stateDiff: {
      changed: stableStringify(before) !== stableStringify(after),
      before,
      after,
    },
  };
}

function skippedEvidence(
  operation: FirebaseOperation,
  decision: AssuranceDecision,
): OperationEvidence {
  return { operation, decision, events: [] };
}

function classify(
  actor: ActorEvidence,
  invariant: SecurityInvariant,
  control: OperationEvidence,
  mutation: OperationEvidence,
  stateDiff: StateDiff,
): ProbeClassification {
  if (actor.reachability === "unreachable") return "invalid-probe";
  if (control.decision !== "ALLOW") return "invalid-probe";
  if (mutation.decision === "ERROR" || mutation.decision === "UNSUPPORTED")
    return "invalid-probe";
  if (mutation.decision === invariant.expected) return "no-counterexample";
  if (invariant.expected === "DENY" && mutation.decision === "ALLOW") {
    const hasImpact =
      stateDiff.changed ||
      (mutation.output !== undefined && mutation.output !== null);
    return actor.reachability === "reachable" &&
      invariant.confidence !== "tentative" &&
      hasImpact
      ? "local-counterexample"
      : "candidate-signal";
  }
  return "candidate-signal";
}

async function runProbe(
  spec: AuthorizationCampaignSpec,
  probe: AssuranceProbe,
  hash: string,
): Promise<AssuranceProbeResult> {
  const actor = spec.actors.find((item) => item.id === probe.actorId)!;
  const invariant = spec.invariants.find(
    (item) => item.id === probe.invariantId,
  )!;
  const qualification = qualifyProbe(spec.target, probe);
  if (!qualification.supported) {
    return {
      campaignId: spec.id,
      probeId: probe.id,
      targetHash: hash,
      actorEvidence: {
        actorId: actor.id,
        acquisition: actor.acquisition.kind,
        reachability:
          actor.acquisition.kind === "synthetic" ? "synthetic" : "unreachable",
      },
      invariant,
      mutationSpec: probe.mutation,
      control: skippedEvidence(probe.control, "UNSUPPORTED"),
      mutation: skippedEvidence(probe.mutation.operation, "UNSUPPORTED"),
      qualification,
      classification: qualification.classification ?? "engine-gap",
    };
  }

  const actorRuntime = acquireActor(initializeSandbox(), spec.target, actor);
  if (actorRuntime.evidence.reachability === "unreachable") {
    const error = {
      message: actorRuntime.evidence.error ?? "Actor acquisition failed.",
    };
    return {
      campaignId: spec.id,
      probeId: probe.id,
      targetHash: hash,
      actorEvidence: actorRuntime.evidence,
      invariant,
      mutationSpec: probe.mutation,
      control: { ...skippedEvidence(probe.control, "ERROR"), error },
      mutation: {
        ...skippedEvidence(probe.mutation.operation, "ERROR"),
        error,
      },
      qualification,
      classification: "invalid-probe",
    };
  }

  const control = await executeOperation(
    spec.id,
    probe.id,
    "control",
    spec.target,
    actorRuntime,
    probe.control,
  );
  const mutation = await executeOperation(
    spec.id,
    probe.id,
    "mutation",
    spec.target,
    actorRuntime,
    probe.mutation.operation,
  );
  return {
    campaignId: spec.id,
    probeId: probe.id,
    targetHash: hash,
    actorEvidence: control.actorEvidence,
    invariant,
    mutationSpec: probe.mutation,
    control: control.evidence,
    mutation: mutation.evidence,
    stateDiff: mutation.stateDiff,
    qualification,
    classification: classify(
      control.actorEvidence,
      invariant,
      control.evidence,
      mutation.evidence,
      mutation.stateDiff,
    ),
  };
}

function summarize(
  results: AssuranceProbeResult[],
): AuthorizationCampaignReport["summary"] {
  return {
    probes: results.length,
    controlsPassed: results.filter(
      (result) => result.control.decision === "ALLOW",
    ).length,
    localCounterexamples: results.filter(
      (result) => result.classification === "local-counterexample",
    ).length,
    candidateSignals: results.filter(
      (result) => result.classification === "candidate-signal",
    ).length,
    noCounterexamples: results.filter(
      (result) => result.classification === "no-counterexample",
    ).length,
    engineGaps: results.filter(
      (result) => result.classification === "engine-gap",
    ).length,
    invalidProbes: results.filter(
      (result) => result.classification === "invalid-probe",
    ).length,
  };
}

export async function runAuthorizationCampaign(
  spec: AuthorizationCampaignSpec,
): Promise<AuthorizationCampaignReport> {
  assertCampaign(spec);
  if (
    typeof globalThis.indexedDB === "undefined" &&
    spec.probes.some((probe) => probe.control.service === "storage")
  ) {
    const fake = await import("fake-indexeddb");
    Object.assign(globalThis, {
      indexedDB: fake.indexedDB,
      IDBKeyRange: fake.IDBKeyRange,
    });
  }
  const hash = targetHash(spec.target);
  const results: AssuranceProbeResult[] = [];
  for (const probe of spec.probes) {
    results.push(await runProbe(spec, probe, hash));
  }
  return {
    schema: ASSURANCE_REPORT_SCHEMA,
    campaignId: spec.id,
    targetHash: hash,
    localOnly: { network: "forbid", engine: "pyric-local-sandboxes" },
    results,
    summary: summarize(results),
  };
}
