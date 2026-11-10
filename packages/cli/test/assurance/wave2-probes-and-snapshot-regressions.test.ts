import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getAuth, sandbox as authSandbox } from "pyric/auth";
import {
  getAdminDatabase,
  getDatabase,
  sandbox as rtdbSandbox,
} from "pyric/database";
import { Bytes, GeoPoint, doc, getFirestore, setDoc } from "pyric/firestore";
import { getClock, initializeSandbox } from "pyric/sandbox";
import { seedDocuments, setRules } from "pyric/sandbox/firestore";
import { getStorageSandbox, ref, uploadBytes } from "pyric/storage";
import {
  ASSURANCE_CAMPAIGN_SCHEMA,
  ASSURANCE_TARGET_SCHEMA,
  AssuranceCampaignStore,
  createAuthorizationCampaign,
  createSandboxAttachmentProvider,
  deriveAssurance,
  qualifyProbe,
  runAuthorizationCampaign,
  runSecurityCases,
} from "../../src/assurance/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyric-assurance-reg-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("assurance probes, snapshot fidelity, attachment, and campaign regressions", () => {
  it("prevents addDoc create probes from colliding onto allow update and preserves synthetic actor custom claims on replay", async () => {
    const addDocRoot = makeTempDir();
    fs.mkdirSync(path.join(addDocRoot, "src"), { recursive: true });
    const addDocRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/items/{id} {
      allow create: if request.auth != null && request.auth.uid == uid;
      allow update: if request.auth != null;
      allow read: if request.auth != null;
    }
  }
}`;
    fs.writeFileSync(
      path.join(addDocRoot, "firebase.json"),
      JSON.stringify({ firestore: { rules: "firestore.rules" } }, null, 2),
    );
    fs.writeFileSync(path.join(addDocRoot, "firestore.rules"), addDocRules);
    fs.writeFileSync(
      path.join(addDocRoot, "src/app.ts"),
      [
        "import { getAuth } from 'firebase/auth';",
        "import { addDoc, collection, getFirestore } from 'firebase/firestore';",
        "export async function createItem(title: string) {",
        "  const uid = getAuth().currentUser!.uid;",
        "  await addDoc(collection(getFirestore(), 'users', uid, 'items'), { title });",
        "}",
      ].join("\n"),
    );

    const addDocStore = new AssuranceCampaignStore();
    const addDocDerived = await deriveAssurance(
      { root: addDocRoot, includeStaticChecks: false },
      { store: addDocStore },
    );
    expect(
      addDocDerived.diagnostics.filter((d) => d.certainty === "proven-counterexample"),
    ).toHaveLength(0);

    const claimRoot = makeTempDir();
    fs.mkdirSync(path.join(claimRoot, "src"), { recursive: true });
    const claimRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.token.role == 'member';
    }
  }
}`;
    fs.writeFileSync(
      path.join(claimRoot, "firebase.json"),
      JSON.stringify({ firestore: { rules: "firestore.rules" } }, null, 2),
    );
    fs.writeFileSync(path.join(claimRoot, "firestore.rules"), claimRules);
    fs.writeFileSync(
      path.join(claimRoot, "src/app.ts"),
      [
        "import { getAuth } from 'firebase/auth';",
        "import { doc, getFirestore, setDoc } from 'firebase/firestore';",
        "export async function saveProfile(name: string) {",
        "  const uid = getAuth().currentUser!.uid;",
        "  await setDoc(doc(getFirestore(), 'users', uid), { name });",
        "}",
      ].join("\n"),
    );

    const claimStore = new AssuranceCampaignStore();
    const claimDerived = await deriveAssurance(
      { root: claimRoot, includeStaticChecks: false },
      { store: claimStore },
    );
    const campaign = claimStore.get(claimDerived.campaignId);
    const peerSpec = campaign
      .spec()
      .actors.find(
        (a) => a.acquisition.kind === "synthetic" && a.acquisition.uid === "probe-peer",
      );
    expect(peerSpec).toBeDefined();
    if (peerSpec?.acquisition.kind === "synthetic") {
      expect(peerSpec.acquisition.token?.role).toBe("member");
    }
    const replay = await campaign.run();
    expect(replay.summary.invalidProbes).toBe(0);
    expect(
      replay.summary.localCounterexamples + replay.summary.candidateSignals,
    ).toBeGreaterThanOrEqual(1);
  });

  it("preserves emailVerified false and blocks disabled accounts from acting as proven attackers", async () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.token.email_verified == true;
    }
  }
}`;
    fs.writeFileSync(
      path.join(root, "firebase.json"),
      JSON.stringify({ firestore: { rules: "firestore.rules" } }, null, 2),
    );
    fs.writeFileSync(path.join(root, "firestore.rules"), rules);
    fs.writeFileSync(
      path.join(root, "src/app.ts"),
      [
        "import { getAuth } from 'firebase/auth';",
        "import { doc, getFirestore, setDoc } from 'firebase/firestore';",
        "export async function updateUser(label: string) {",
        "  const uid = getAuth().currentUser!.uid;",
        "  await setDoc(doc(getFirestore(), 'users', uid), { label });",
        "}",
      ].join("\n"),
    );

    const sbUnverified = initializeSandbox();
    setRules(sbUnverified, rules);
    authSandbox.seedUsers(getAuth(sbUnverified), [
      { uid: "u1", email: "u1@example.test", password: "pw1", emailVerified: false },
      { uid: "u2", email: "u2@example.test", password: "pw2", emailVerified: false },
    ]);
    const derivedUnverified = await deriveAssurance(
      { root, includeStaticChecks: false },
      { store: new AssuranceCampaignStore(), sandbox: sbUnverified },
    );
    expect(
      derivedUnverified.diagnostics.filter((d) => d.certainty === "proven-counterexample"),
    ).toHaveLength(0);

    const sbDisabled = initializeSandbox();
    setRules(sbDisabled, rules);
    authSandbox.seedUsers(getAuth(sbDisabled), [
      { uid: "u1", email: "u1@example.test", password: "pw1", emailVerified: true },
      { uid: "u2", email: "u2@example.test", password: "pw2", emailVerified: true, disabled: true },
    ]);
    const derivedStore = new AssuranceCampaignStore();
    const derivedDisabled = await deriveAssurance(
      { root, includeStaticChecks: false },
      { store: derivedStore, sandbox: sbDisabled },
    );
    const disabledProven = derivedDisabled.diagnostics.filter(
      (d) => d.certainty === "proven-counterexample",
    );
    expect(disabledProven.length).toBeGreaterThanOrEqual(1);
    for (const diag of disabledProven) {
      for (const step of diag.witness ?? []) {
        expect((step as { actorUid?: string }).actorUid).not.toBe("u2");
      }
    }

    const disabledActorReport = await runAuthorizationCampaign({
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "c-disabled-peer",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: { firestore: rules },
        state: {
          auth: {
            users: [
              { uid: "u1", email: "u1@example.test", password: "pw1", emailVerified: true },
              { uid: "u2", email: "u2@example.test", password: "pw2", emailVerified: true, disabled: true },
            ],
          },
          firestore: { "users/u1": { label: "initial" } },
        },
      },
      actors: [
        { id: "owner", acquisition: { kind: "password", email: "u1@example.test", password: "pw1" } },
        { id: "peer", acquisition: { kind: "password", email: "u2@example.test", password: "pw2" } },
      ],
      invariants: [
        {
          id: "inv-disabled-peer",
          statement: "Disabled peer cannot overwrite owner user document",
          service: "firestore",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "p-disabled-peer-write",
          actorId: "peer",
          invariantId: "inv-disabled-peer",
          control: {
            service: "firestore",
            method: "set",
            path: "users/u2",
            data: { label: "tampered" },
          },
          mutation: {
            dimension: "path",
            description: "Disabled peer attempts write to users/u1",
            operation: {
              service: "firestore",
              method: "set",
              path: "users/u1",
              data: { label: "tampered" },
            },
          },
        },
      ],
    });
    expect(disabledActorReport.summary.localCounterexamples).toBe(0);
  });

  it("synthesizes bounded regex quantifiers for Storage contentType and decodes complex GeoPoint and Bytes snapshot markers", async () => {
    const stRoot = makeTempDir();
    fs.mkdirSync(path.join(stRoot, "src"), { recursive: true });
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('application/x-[a-z]{4}');
    }
  }
}`;
    fs.writeFileSync(
      path.join(stRoot, "firebase.json"),
      JSON.stringify({ storage: { rules: "storage.rules" } }, null, 2),
    );
    fs.writeFileSync(path.join(stRoot, "storage.rules"), storageRules);
    fs.writeFileSync(
      path.join(stRoot, "src/app.ts"),
      [
        "import { getAuth } from 'firebase/auth';",
        "import { getStorage, ref, uploadBytes } from 'firebase/storage';",
        "export async function uploadItem(blob: Blob) {",
        "  const uid = getAuth().currentUser!.uid;",
        "  await uploadBytes(ref(getStorage(), 'users/' + uid + '/item.bin'), blob);",
        "}",
      ].join("\n"),
    );
    const derivedStorage = await deriveAssurance(
      { root: stRoot, includeStaticChecks: false },
      { store: new AssuranceCampaignStore() },
    );
    expect(
      derivedStorage.diagnostics.filter((d) => d.certainty === "proven-counterexample"),
    ).toHaveLength(0);

    const fsRoot = makeTempDir();
    const complexRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.loc is latlng
        && request.resource.data.raw is bytes;
      allow update, delete: if request.auth != null && resource.data.ownerUid == request.auth.uid;
    }
  }
}`;
    fs.writeFileSync(
      path.join(fsRoot, "firebase.json"),
      JSON.stringify({ firestore: { rules: "firestore.rules" } }, null, 2),
    );
    fs.writeFileSync(path.join(fsRoot, "firestore.rules"), complexRules);
    const sbComplex = initializeSandbox();
    setRules(sbComplex, complexRules);
    seedDocuments(sbComplex, {
      "items/item-1": {
        ownerUid: "u1",
        loc: new GeoPoint(37.77, -122.41),
        raw: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])),
      },
    });
    const derivedComplex = await deriveAssurance(
      { root: fsRoot, includeStaticChecks: false },
      { store: new AssuranceCampaignStore(), sandbox: sbComplex },
    );
    expect(
      derivedComplex.diagnostics.some((d) => d.certainty === "proven-counterexample"),
    ).toBe(true);
  });

  it("qualifies RTDB rules on mutation.operation.instance and accepts cross-instance path mutations at identical paths", async () => {
    const malformedSecondaryTarget = {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid" as const,
      rules: {
        rtdb: { rules: { items: { ".read": "auth != null" } } },
        rtdbInstances: {
          "secondary-db": {
            rules: { items: { ".read": "auth != null &&&& root.exists()" } },
          },
        },
      },
      state: {
        auth: { users: [{ uid: "u1" }] },
        rtdb: { items: { a: { owner: "u1" } } },
        rtdbInstances: { "secondary-db": { items: { a: { owner: "u2" } } } },
      },
    };

    const crossSamePathProbe = {
      id: "p-cross-same-path",
      actorId: "a1",
      invariantId: "inv-1",
      control: { service: "rtdb" as const, method: "get" as const, path: "/items/a" },
      mutation: {
        dimension: "path" as const,
        description: "Read /items/a on secondary-db",
        operation: {
          service: "rtdb" as const,
          instance: "secondary-db",
          method: "get" as const,
          path: "/items/a",
        },
      },
    };

    const malformedQualification = qualifyProbe(malformedSecondaryTarget, crossSamePathProbe);
    expect(malformedQualification.supported).toBe(false);
    expect(malformedQualification.requirements).toContainEqual(
      expect.objectContaining({ id: "rtdb.rules-parse", supported: false }),
    );

    const validSecondaryTarget = {
      ...malformedSecondaryTarget,
      rules: {
        rtdb: { rules: { items: { ".read": "auth != null" } } },
        rtdbInstances: {
          "secondary-db": {
            rules: {
              items: {
                ".indexOn": ["owner"],
                ".read": 'query.orderByChild == "owner" && query.equalTo == auth.uid',
              },
            },
          },
        },
      },
    };

    const report = await runAuthorizationCampaign({
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "c-cross-instance",
      target: validSecondaryTarget,
      actors: [{ id: "a1", acquisition: { kind: "fixture-user", uid: "u1" } }],
      invariants: [
        {
          id: "inv-1",
          statement: "Unqueried read on secondary DB must be denied",
          service: "rtdb",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [crossSamePathProbe],
    });
    expect(report.results[0]?.classification).toBe("no-counterexample");
  });

  it("preserves crossServiceIam, Storage object metadata, disabled Auth providers, active rules, named RTDB instances, and own __proto__ keys across attachment", async () => {
    const firestoreRules =
      "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{d=**} { allow read: if true; } } }";
    const crossRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow read, write: if request.auth != null
        && firestore.exists(/databases/(default)/documents/users/$(request.auth.uid));
    }
    match /items/{id} {
      allow write: if request.auth != null;
      allow read: if resource.cacheControl == 'public, max-age=3600'
        && resource.contentDisposition == 'inline';
    }
  }
}`;

    const sb = initializeSandbox();
    getClock(sb).set(1_700_000_000_000);
    setRules(sb, firestoreRules);
    seedDocuments(sb, {
      "users/u1": JSON.parse('{"__proto__":{"role":"admin"},"active":true}') as Record<
        string,
        unknown
      >,
      "users/u2": { active: true },
    });
    const auth = getAuth(sb);
    authSandbox.seedUsers(auth, [
      { uid: "u1", email: "u1@example.test", password: "pw1", emailVerified: true },
    ]);
    authSandbox.setAuthProviderConfig(auth, "password", false);

    rtdbSandbox.setRules(getDatabase(sb), {
      rules: { users: { $uid: { ".read": "auth != null" } } },
    });
    rtdbSandbox.setData(getAdminDatabase(sb), { "/": { users: { u1: { ok: true } } } });
    const secondaryUrl = "https://secondary-db.firebaseio.com";
    rtdbSandbox.setRules(getDatabase(sb, secondaryUrl), {
      rules: { items: { ".read": "auth != null" } },
    });
    rtdbSandbox.setData(getAdminDatabase(sb, secondaryUrl), {
      "/": { items: { i1: "v" } },
    });

    const stWrite = getStorageSandbox(sb.withAuth({ uid: "u1" }), {
      rules: crossRules,
      crossServiceIam: "denied",
    });
    await uploadBytes(ref(stWrite, "items/item-1"), new Uint8Array([65, 66]), {
      contentType: "text/plain",
      cacheControl: "public, max-age=3600",
      contentDisposition: "inline",
    });
    getClock(sb).set(1_700_000_999_000);

    const attach = createSandboxAttachmentProvider(sb, {
      origin: "http://127.0.0.1:4320",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ bridgeUrl: "ws://127.0.0.1:4320/__pyric/bridge" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const attached = await attach({ url: "http://127.0.0.1:4320/" });

    expect(attached.coverageGaps).toEqual([]);
    expect(attached.target.rules.firestore).toBe(firestoreRules);
    expect(attached.target.rules.rtdb).toBeDefined();
    expect(attached.target.rules.rtdbInstances?.["secondary-db"]).toBeDefined();
    expect(attached.target.state.rtdbInstances?.["secondary-db"]).toEqual({
      items: { i1: "v" },
    });
    const clonedDoc = attached.target.state.firestore?.["users/u1"] ?? {};
    expect(
      Object.hasOwn(clonedDoc, "__proto__") ||
        Object.hasOwn((clonedDoc.fields as Record<string, unknown>) ?? {}, "__proto__"),
    ).toBe(true);

    const report = await runAuthorizationCampaign({
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "c-attached-fidelity",
      target: attached.target,
      actors: [
        { id: "owner", acquisition: { kind: "fixture-user", uid: "u1" } },
        {
          id: "pw-actor",
          acquisition: { kind: "password", email: "u1@example.test", password: "pw1" },
        },
        { id: "anon", acquisition: { kind: "anonymous-request" } },
      ],
      invariants: [
        {
          id: "inv-cross",
          statement: "crossServiceIam denied blocks upload",
          service: "storage",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
        {
          id: "inv-meta",
          statement: "cacheControl and contentDisposition preserved",
          service: "storage",
          expected: "ALLOW",
          source: "declared",
          confidence: "authoritative",
        },
        {
          id: "inv-pw",
          statement: "Disabled password provider unreachable",
          service: "firestore",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "p-cross",
          actorId: "owner",
          invariantId: "inv-cross",
          control: {
            service: "storage",
            method: "upload",
            path: "users/u1/doc.txt",
            dataBase64: "YQ==",
          },
          mutation: {
            dimension: "path",
            description: "Upload peer path",
            operation: {
              service: "storage",
              method: "upload",
              path: "users/u2/doc.txt",
              dataBase64: "YQ==",
            },
          },
        },
        {
          id: "p-meta",
          actorId: "anon",
          invariantId: "inv-meta",
          control: { service: "storage", method: "get", path: "items/item-1" },
          mutation: {
            dimension: "path",
            description: "Read missing item",
            operation: { service: "storage", method: "get", path: "items/item-2" },
          },
        },
        {
          id: "p-pw",
          actorId: "pw-actor",
          invariantId: "inv-pw",
          control: { service: "firestore", method: "get", path: "users/u1" },
          mutation: {
            dimension: "path",
            description: "Read users/u2",
            operation: { service: "firestore", method: "get", path: "users/u2" },
          },
        },
      ],
    });

    expect(report.results.find((r) => r.probeId === "p-cross")?.control.decision).toBe(
      "DENY",
    );
    expect(report.results.find((r) => r.probeId === "p-meta")?.control.decision).toBe(
      "ALLOW",
    );
    expect(
      report.results.find((r) => r.probeId === "p-pw")?.actorEvidence.reachability,
    ).toBe("unreachable");
  });

  it("detects RTDB .priority tampering and Firestore NaN/Infinity/-0 state diffs without crashing on own __proto__ target docs", async () => {
    const rtdbReport = await runAuthorizationCampaign({
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "c-rtdb-prio",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          rtdb: {
            rules: { users: { $uid: { rank: { ".write": "auth != null" } } } },
          },
        },
        state: {
          auth: { users: [{ uid: "u1" }, { uid: "u2" }] },
          rtdb: {
            users: {
              u1: { rank: { ".value": "member", ".priority": 1 } },
              u2: { rank: { ".value": "member", ".priority": 1 } },
            },
          },
        },
      },
      actors: [{ id: "peer", acquisition: { kind: "fixture-user", uid: "u2" } }],
      invariants: [
        {
          id: "inv-prio",
          statement: "Peer must not alter u1 priority",
          service: "rtdb",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "p-prio",
          actorId: "peer",
          invariantId: "inv-prio",
          control: {
            service: "rtdb",
            method: "set",
            path: "/users/u2/rank",
            data: { ".value": "member", ".priority": 999 },
          },
          mutation: {
            dimension: "path",
            description: "Overwrite u1 priority",
            operation: {
              service: "rtdb",
              method: "set",
              path: "/users/u1/rank",
              data: { ".value": "member", ".priority": 999 },
            },
          },
        },
      ],
    });
    expect(rtdbReport.results[0]?.stateDiff?.changed).toBe(true);
    expect(rtdbReport.results[0]?.classification).toBe("local-counterexample");

    const fsReport = await runAuthorizationCampaign({
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "c-fs-nan-proto",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          firestore:
            "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /users/{uid} { allow read, write: if request.auth != null; } } }",
        },
        state: {
          auth: { users: [{ uid: "u1" }, { uid: "u2" }] },
          firestore: {
            "users/u1": Object.assign(
              JSON.parse('{"__proto__":{"role":"admin"}}') as Record<string, unknown>,
              { score: null },
            ),
            "users/u2": { score: null },
          },
        },
      },
      actors: [{ id: "peer", acquisition: { kind: "fixture-user", uid: "u2" } }],
      invariants: [
        {
          id: "inv-nan",
          statement: "Peer must not overwrite score with NaN",
          service: "firestore",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "p-nan",
          actorId: "peer",
          invariantId: "inv-nan",
          control: {
            service: "firestore",
            method: "update",
            path: "users/u2",
            data: { score: Number.NaN },
          },
          mutation: {
            dimension: "path",
            description: "Overwrite u1 score to NaN",
            operation: {
              service: "firestore",
              method: "update",
              path: "users/u1",
              data: { score: Number.NaN },
            },
          },
        },
      ],
    });
    expect(fsReport.results[0]?.stateDiff?.changed).toBe(true);
    expect(fsReport.results[0]?.classification).toBe("local-counterexample");

    const camp = createAuthorizationCampaign({
      id: "c-payload-nan",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          firestore:
            "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /users/{uid} { allow write: if true; } } }",
        },
        state: { auth: { users: [{ uid: "u1" }] }, firestore: { "users/u1": { score: null } } },
      },
    });
    camp.addActor({ id: "a1", acquisition: { kind: "fixture-user", uid: "u1" } });
    camp.addInvariant({
      id: "inv-1",
      statement: "Reject NaN score",
      service: "firestore",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });
    expect(() =>
      camp.addProbe({
        id: "p-payload-nan",
        actorId: "a1",
        invariantId: "inv-1",
        control: { service: "firestore", method: "update", path: "users/u1", data: { score: null } },
        mutation: {
          dimension: "payload",
          description: "Mutate score from null to NaN",
          operation: {
            service: "firestore",
            method: "update",
            path: "users/u1",
            data: { score: Number.NaN },
          },
        },
      }),
    ).not.toThrow();
  });

  it("deep-merges sibling rtdbInstances in verifyRules and honors per-case expect and colliding invariant IDs in runSecurityCases", async () => {
    const campaign = createAuthorizationCampaign({
      id: "c-verify-merge",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          rtdbInstances: {
            "inst-a": { rules: { users: { $uid: { ".read": "auth != null" } } } },
            "inst-b": { rules: { items: { ".read": false } } },
          },
        },
        state: {
          auth: { users: [{ uid: "u1" }, { uid: "u2" }] },
          rtdbInstances: {
            "inst-a": { users: { u1: { name: "one" }, u2: { name: "two" } } },
            "inst-b": { items: { i1: "locked" } },
          },
        },
      },
    });
    campaign.addInvariant({
      id: "inv-a",
      statement: "Peer must not read u1 in inst-a",
      service: "rtdb",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });
    campaign.map({
      actors: [{ id: "peer", acquisition: { kind: "fixture-user", uid: "u2" } }],
      probes: [
        {
          id: "p-a",
          actorId: "peer",
          invariantId: "inv-a",
          control: { service: "rtdb", instance: "inst-a", method: "get", path: "/users/u2" },
          mutation: {
            dimension: "path",
            description: "Read u1 in inst-a",
            operation: { service: "rtdb", instance: "inst-a", method: "get", path: "/users/u1" },
          },
        },
      ],
    });
    await campaign.run();

    const verified = await campaign.verifyRules({
      rules: {
        rtdbInstances: {
          "inst-a": {
            rules: { users: { $uid: { ".read": "auth != null && auth.uid === $uid" } } },
          },
        },
      },
    });
    expect(verified.results[0]?.classification).toBe("no-counterexample");

    const casesReport = await runSecurityCases({
      campaignId: "c-cases-collision",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          firestore:
            "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /users/{uid} { allow read: if request.auth != null && request.auth.uid == uid; } } }",
        },
        state: {
          auth: { users: [{ uid: "u1" }, { uid: "u2" }] },
          firestore: { "users/u1": { a: 1 }, "users/u2": { a: 2 } },
        },
      },
      actors: [{ id: "peer", acquisition: { kind: "fixture-user", uid: "u2" } }],
      cases: [
        {
          schema: "pyric.assurance.case.v1",
          id: "case-deny",
          campaignId: "camp-1",
          actorId: "peer",
          invariant: {
            id: "inv-1",
            statement: "Peer cannot read u1",
            service: "firestore",
            expected: "DENY",
            source: "declared",
            confidence: "authoritative",
          },
          control: { service: "firestore", method: "get", path: "users/u2" },
          mutation: {
            dimension: "path",
            description: "Peer reads u1",
            operation: { service: "firestore", method: "get", path: "users/u1" },
          },
          expect: "DENY",
          qualification: { engine: "pyric-local-sandboxes", supported: true, requirements: [] },
        },
        {
          schema: "pyric.assurance.case.v1",
          id: "case-allow",
          campaignId: "camp-2",
          actorId: "peer",
          invariant: {
            id: "inv-1",
            statement: "Second campaign invariant sharing id inv-1",
            service: "firestore",
            expected: "ALLOW",
            source: "declared",
            confidence: "authoritative",
          },
          control: { service: "firestore", method: "get", path: "users/u2" },
          mutation: {
            dimension: "path",
            description: "Peer reads u1",
            operation: { service: "firestore", method: "get", path: "users/u1" },
          },
          expect: "ALLOW",
          qualification: { engine: "pyric-local-sandboxes", supported: true, requirements: [] },
        },
      ],
    });
    expect(casesReport.results[0]?.classification).toBe("no-counterexample");
    expect(casesReport.results[0]?.invariant.id).toBe("inv-1");
    expect(casesReport.results[1]?.invariant.id).toBe("inv-1");
  });

  it("preserves compatible seeded Storage objects on named buckets during deleteObject probes without overwriting byte size", async () => {
    const tmpDir = makeTempDir();
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    const bucketRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read: if request.auth != null && resource.metadata.ownerId == request.auth.uid;
      allow delete: if request.auth != null && resource.metadata.ownerId == request.auth.uid && resource.size == 32;
    }
  }
}`;
    fs.writeFileSync(
      path.join(tmpDir, "firebase.json"),
      JSON.stringify(
        {
          storage: [
            { bucket: "bucket-primary", rules: "primary.rules" },
            { bucket: "bucket-secondary", rules: "secondary.rules" },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(tmpDir, "primary.rules"), bucketRules);
    fs.writeFileSync(path.join(tmpDir, "secondary.rules"), bucketRules);
    fs.writeFileSync(
      path.join(tmpDir, "src/app.ts"),
      [
        "import { getStorage, ref, getBytes, deleteObject } from 'pyric/storage';",
        "declare const app: unknown;",
        "export async function manageSecondaryDoc() {",
        "  const sec = getStorage(app, 'gs://bucket-secondary');",
        "  await getBytes(ref(sec, 'docs/doc-1'));",
        "  await deleteObject(ref(sec, 'docs/doc-1'));",
        "}",
      ].join("\n"),
    );

    const payloadBytes = new Uint8Array(32).fill(7);
    let binary = "";
    for (const byte of payloadBytes) binary += String.fromCharCode(byte);
    const dataBase64 = btoa(binary);

    const server = http.createServer((req, res) => {
      if (req.url === "/__pyric/init.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionToken: "tok-1", instanceId: "inst-1" }));
        return;
      }
      if (req.url === "/__pyric/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            version: 1,
            firestore: null,
            auth: {
              users: [
                { uid: "u-1", email: "u1@example.test" },
                { uid: "u-2", email: "u2@example.test" },
              ],
            },
            storage: [
              {
                path: "docs/doc-1",
                dataBase64,
                size: 32,
                blobType: "application/octet-stream",
                metadata: {
                  bucket: "bucket-secondary",
                  fullPath: "docs/doc-1",
                  name: "doc-1",
                  size: 32,
                  generation: "1",
                  metageneration: "1",
                  timeCreated: "2026-01-01T00:00:00.000Z",
                  updated: "2026-01-01T00:00:00.000Z",
                  contentType: "application/octet-stream",
                  customMetadata: { ownerId: "u-1" },
                },
              },
            ],
          }),
        );
        return;
      }
      if (req.url === "/__pyric/method") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: { events: [] } }));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const derived = await deriveAssurance(
        { root: tmpDir, url: `http://127.0.0.1:${port}`, includeHeuristic: false },
        { store: new AssuranceCampaignStore() },
      );
      const falseDenials = derived.diagnostics.filter(
        (d) =>
          d.code === "assurance-must-allow-denied" && d.resourceId === "bucket-secondary",
      );
      expect(falseDenials).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
