import "fake-indexeddb/auto";
import { describe, expect, it } from "bun:test";
import { getAuth, sandbox as authSandbox, signInAnonymously } from "pyric/auth";
import {
  getAdminDatabase,
  getDatabase,
  sandbox as rtdbSandbox,
} from "pyric/database";
import { Timestamp, getFirestore } from "pyric/firestore";
import { initializeSandbox } from "pyric/sandbox";
import { seedDocuments, setRules } from "pyric/sandbox/firestore";
import { ref as storageRef, uploadBytes } from "pyric/storage";
import { getAdminStorageSandbox } from "pyric/storage/internal";
import {
  createOwnedSandboxAttachmentProvider,
  createSandboxAttachmentProvider,
} from "../../src/assurance/attachment.js";
import { createAuthorizationCampaign } from "../../src/assurance/campaign.js";
import { AssuranceInputError } from "../../src/assurance/types.js";

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow read: if request.auth != null; }
  }
}`;

const RTDB_RULES = {
  rules: {
    rooms: {
      ".read": "auth != null",
    },
  },
};

function seededSandbox() {
  const sandbox = initializeSandbox();
  const firestore = getFirestore(sandbox);
  setRules(sandbox, FIRESTORE_RULES);
  seedDocuments(sandbox, {
    "rooms/r1": { ownerId: "alice", title: "Room" },
  });

  const auth = getAuth(sandbox);
  authSandbox.seedUsers(auth, [
    {
      uid: "alice",
      email: "alice@example.test",
      password: "password-123",
      customClaims: { tenant: "t1" },
    },
  ]);

  const rtdb = getDatabase(sandbox);
  rtdbSandbox.setRules(rtdb, RTDB_RULES);
  rtdbSandbox.setData(getAdminDatabase(sandbox), {
    "/": { rooms: { r1: { ownerId: "alice" } } },
  });
  return sandbox;
}

describe("createSandboxAttachmentProvider", () => {
  it("normalizes a Studio URL and clones the current local sandbox into an isolated target", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const attach = createSandboxAttachmentProvider(seededSandbox(), {
      origin: "http://localhost:5210",
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            rules: FIRESTORE_RULES,
            databaseRules: RTDB_RULES,
            bridgeUrl: "ws://localhost:5210/__pyric/sandbox",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const attached = await attach({
      url: "http://localhost:5210/__pyric/ui/",
    });

    expect(requests).toEqual([
      {
        url: "http://localhost:5210/__pyric/init.json",
        init: { redirect: "error" },
      },
    ]);
    expect(attached.source).toMatchObject({
      origin: "http://localhost:5210",
      requestedUrl: "http://localhost:5210/__pyric/ui/",
      transport: "same-origin-shared-worker",
      readOnly: true,
      studioUrl: "http://localhost:5210/__pyric/ui/assurance",
    });
    expect(attached.target).toEqual({
      schema: "pyric.assurance.target.v1",
      network: "forbid",
      rules: {
        firestore: FIRESTORE_RULES,
        rtdb: RTDB_RULES,
      },
      state: {
        firestore: {
          "rooms/r1": { ownerId: "alice", title: "Room" },
        },
        rtdb: { rooms: { r1: { ownerId: "alice" } } },
        auth: {
          users: [
            expect.objectContaining({
              uid: "alice",
              email: "alice@example.test",
              password: "password-123",
              customClaims: { tenant: "t1" },
            }),
          ],
        },
      },
    });
    expect(attached.inventory).toEqual({
      firestoreDocuments: 1,
      rtdbPresent: true,
      authUsers: 1,
      storageObjects: 0,
    });
    expect(attached.coverageGaps).toEqual([]);
  });

  it("clones live Storage objects, metadata, active Storage rules, and rich Firestore types into an executable campaign target", async () => {
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null
        && request.auth.uid == resource.data.ownerId
        && resource.data.createdAt is timestamp;
    }
  }
}`;
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;
    const sandbox = seededSandbox();
    authSandbox.seedUsers(getAuth(sandbox), [
      {
        uid: "alice",
        email: "alice@example.test",
        password: "password-123",
        displayName: "Alice Example",
        photoUrl: "https://example.test/alice.png",
        phoneNumber: "+15550101",
        tenantId: "t1",
        customClaims: { tenant: "t1" },
      },
    ]);
    const anonCred = await signInAnonymously(getAuth(sandbox));
    const anonUid = anonCred.user.uid;
    setRules(sandbox, firestoreRules);
    seedDocuments(sandbox, {
      "items/item-1": {
        ownerId: "alice",
        createdAt: new Timestamp(1_700_000_000, 0),
        nanScore: Number.NaN,
        negZeroOffset: -0,
      },
    });
    const adminStorage = getAdminStorageSandbox(sandbox, {
      dbName: "pyric-attach-live-storage-1",
      rules: storageRules,
    });
    await uploadBytes(
      storageRef(adminStorage, "files/alice/note.txt"),
      new TextEncoder().encode("confidential"),
      {
        contentType: "text/plain",
        customMetadata: { owner: "alice" },
      },
    );
    await uploadBytes(
      storageRef(adminStorage, "files/u2/own.txt"),
      new TextEncoder().encode("u2-note"),
      {
        contentType: "text/plain",
      },
    );

    const attach = createOwnedSandboxAttachmentProvider(
      sandbox,
      { firestore: firestoreRules, rtdb: RTDB_RULES },
      "http://localhost:5210/__pyric/ui/assurance",
    );
    const attached = await attach({ url: "http://localhost:5210" });

    expect(attached.inventory.storageObjects).toBe(2);
    expect(attached.target.rules.storage).toBe(storageRules);
    expect(attached.target.state.storage).toEqual([
      {
        path: "files/alice/note.txt",
        dataBase64: btoa("confidential"),
        contentType: "text/plain",
        customMetadata: { owner: "alice" },
      },
      {
        path: "files/u2/own.txt",
        dataBase64: btoa("u2-note"),
        contentType: "text/plain",
      },
    ]);
    expect(attached.coverageGaps).toEqual([]);
    const attachedAlice = attached.target.state.auth?.users.find((u) => u.uid === "alice");
    expect(attachedAlice).toMatchObject({
      uid: "alice",
      displayName: "Alice Example",
      photoUrl: "https://example.test/alice.png",
      phoneNumber: "+15550101",
      tenantId: "t1",
    });
    const attachedAnon = attached.target.state.auth?.users.find((u) => u.uid === anonUid);
    expect(attachedAnon).toMatchObject({
      uid: anonUid,
      providerId: "anonymous",
    });
    expect(attachedAnon?.email).toBeUndefined();

    const roundTrippedTarget = JSON.parse(
      JSON.stringify(attached.target),
    ) as typeof attached.target;

    const directCampaign = createAuthorizationCampaign({
      id: "attach-direct-campaign",
      target: attached.target,
    });
    const campaign = createAuthorizationCampaign({
      id: "attach-live-campaign",
      target: roundTrippedTarget,
    });
    const invariants = [
      {
        id: "inv-storage",
        statement: "Only the owner can read files/{uid}/{name}",
        service: "storage" as const,
        expected: "DENY" as const,
        source: "declared" as const,
        confidence: "authoritative" as const,
      },
      {
        id: "inv-firestore-ts",
        statement: "Only the owner can read items/{id} when createdAt is a Timestamp",
        service: "firestore" as const,
        expected: "DENY" as const,
        source: "declared" as const,
        confidence: "authoritative" as const,
      },
    ];
    for (const inv of invariants) {
      directCampaign.addInvariant(inv);
      campaign.addInvariant(inv);
    }
    const mapping = {
      actors: [
        { id: "owner", acquisition: { kind: "fixture-user" as const, uid: "alice" } },
        { id: "other", acquisition: { kind: "fixture-user" as const, uid: anonUid } },
      ],
      probes: [
        {
          id: "probe-storage-read",
          actorId: "other",
          invariantId: "inv-storage",
          control: { service: "storage" as const, method: "get" as const, path: `files/${anonUid}/own.txt` },
          mutation: {
            dimension: "path" as const,
            description: "Read another user's stored file",
            operation: { service: "storage" as const, method: "get" as const, path: "files/alice/note.txt" },
          },
        },
        {
          id: "probe-firestore-ts",
          actorId: "owner",
          invariantId: "inv-firestore-ts",
          control: { service: "firestore" as const, method: "get" as const, path: "items/item-1" },
          mutation: {
            dimension: "path" as const,
            description: "Read non-existent item",
            operation: { service: "firestore" as const, method: "get", path: "items/item-2" },
          },
        },
      ],
    };
    await uploadBytes(
      storageRef(adminStorage, `files/${anonUid}/own.txt`),
      new TextEncoder().encode("anon-note"),
      { contentType: "text/plain" },
    );
    const refreshed = await attach({ url: "http://localhost:5210" });
    const refreshedRoundTrip = JSON.parse(
      JSON.stringify(refreshed.target),
    ) as typeof refreshed.target;
    const directRefreshed = createAuthorizationCampaign({
      id: "attach-direct-refreshed",
      target: refreshed.target,
    });
    const roundTripRefreshed = createAuthorizationCampaign({
      id: "attach-roundtrip-refreshed",
      target: refreshedRoundTrip,
    });
    for (const inv of invariants) {
      directRefreshed.addInvariant(inv);
      roundTripRefreshed.addInvariant(inv);
    }
    directRefreshed.map(mapping);
    roundTripRefreshed.map(mapping);

    const directReport = await directRefreshed.run();
    const report = await roundTripRefreshed.run();
    expect(report.targetHash).toBe(directReport.targetHash);
    const storageResult = report.results.find((r) => r.probeId === "probe-storage-read");
    const fsResult = report.results.find((r) => r.probeId === "probe-firestore-ts");
    expect(storageResult?.control.decision).toBe("ALLOW");
    expect(storageResult?.mutation?.decision).toBe("DENY");
    expect(fsResult?.control.decision).toBe("ALLOW");
  });

  it("rejects non-loopback and cross-origin URLs before any request", async () => {
    let requests = 0;
    const attach = createSandboxAttachmentProvider(seededSandbox(), {
      origin: "http://localhost:5210",
      fetchImpl: async () => {
        requests++;
        return new Response("{}");
      },
    });

    await expect(
      attach({ url: "https://example.com/__pyric/ui/" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AssuranceInputError>>({
        code: "ASSURANCE_INVALID_INPUT",
      }),
    );
    await expect(
      attach({ url: "http://localhost:5211/__pyric/ui/" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AssuranceInputError>>({
        code: "ASSURANCE_INVALID_INPUT",
      }),
    );
    await expect(
      attach({ url: "http://127.256.0.1:5210/__pyric/ui/" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AssuranceInputError>>({
        code: "ASSURANCE_INVALID_INPUT",
      }),
    );
    expect(requests).toBe(0);
  });

  it("preserves linked providerUserInfo across sandbox attachment into campaign replay", async () => {
    const sandbox = initializeSandbox({ projectId: "demo-proj" });
    authSandbox.seedUsers(getAuth(sandbox), [
      {
        uid: "u-linked",
        email: "linked@example.test",
        emailVerified: true,
        providerId: "google.com",
        providerUserInfo: [
          { providerId: "google.com", rawId: "g-100", email: "linked@example.test" },
          { providerId: "github.com", rawId: "gh-200", email: "linked@example.test" },
        ],
      },
    ]);
    setRules(
      sandbox,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/docs/{docId} {
      allow read: if request.auth != null
        && request.auth.uid == uid
        && 'github.com' in request.auth.token.firebase.identities;
    }
  }
}`,
    );
    seedDocuments(sandbox, {
      "users/u-linked/docs/d1": { ok: true },
      "users/other/docs/d1": { ok: true },
    });

    const attach = createSandboxAttachmentProvider(sandbox, {
      origin: "http://127.0.0.1:4173",
      fetchImpl: async () =>
        new Response(JSON.stringify({ bridgeUrl: "ws://127.0.0.1:4173/b" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const attached = await attach({ url: "http://127.0.0.1:4173/" });
    const campaign = createAuthorizationCampaign({
      id: "camp-linked-identities",
      target: attached.target,
    });
    campaign.addInvariant({
      id: "inv-linked",
      statement: "Foreign slot denied",
      service: "firestore",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });
    campaign.map({
      actors: [{ id: "linked", acquisition: { kind: "fixture-user", uid: "u-linked" } }],
      probes: [
        {
          id: "p-linked",
          actorId: "linked",
          invariantId: "inv-linked",
          control: { service: "firestore", method: "get", path: "users/u-linked/docs/d1" },
          mutation: {
            dimension: "path",
            description: "Foreign slot",
            operation: { service: "firestore", method: "get", path: "users/other/docs/d1" },
          },
        },
      ],
    });
    const report = await campaign.run();
    expect(report.results[0]?.control.decision).toBe("ALLOW");
    expect(report.results[0]?.classification).toBe("no-counterexample");
  });

  it("ingests databaseInstances.rules and storageBucketRules from init.json in createSandboxAttachmentProvider", async () => {
    const sandbox = initializeSandbox({ projectId: "demo-proj" });
    const bucketRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read: if request.auth != null;
    }
  }
}`;
    const attach = createSandboxAttachmentProvider(sandbox, {
      origin: "http://127.0.0.1:4200",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            bridgeUrl: "ws://127.0.0.1:4200/__pyric/bridge",
            databaseInstances: {
              defaultInstance: "demo-proj-default-rtdb",
              rules: {
                "demo-proj-default-rtdb": {
                  rules: { defaults: { ".read": "auth != null" } },
                },
                "inst-secondary": {
                  rules: { orgs: { ".read": "auth != null" } },
                },
              },
            },
            storageBucketRules: {
              "bucket-secondary": bucketRules,
              "gs://bucket-tertiary/": { rules: bucketRules },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    const attached = await attach({ url: "http://127.0.0.1:4200" });
    expect(attached.target.rules.rtdb).toEqual({
      rules: { defaults: { ".read": "auth != null" } },
    });
    expect(attached.target.rules.rtdbInstances?.["inst-secondary"]).toEqual({
      rules: { orgs: { ".read": "auth != null" } },
    });
    expect(attached.target.rules.storageBuckets?.["bucket-secondary"]).toBe(
      bucketRules,
    );
    expect(attached.target.rules.storageBuckets?.["bucket-tertiary"]).toBe(
      bucketRules,
    );
  });
});
