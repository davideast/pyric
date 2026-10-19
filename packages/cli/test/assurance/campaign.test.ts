import "fake-indexeddb/auto";

import { describe, expect, it } from "bun:test";
import {
  createAuthorizationCampaign,
  runAuthorizationCampaign,
  type AuthorizationCampaignSpec,
} from "../../src/assurance/index.js";

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, update: if request.auth != null
        && exists(/databases/$(database)/documents/rooms/$(roomId)/members/$(request.auth.uid));
    }
  }
}`;

const RTDB_RULES = {
  rules: {
    rooms: {
      $roomId: {
        members: {
          $uid: {
            ".read":
              'auth != null && root.child("rooms").child($roomId).child("members").child(auth.uid).exists()',
            ".write":
              'auth != null && root.child("rooms").child($roomId).child("members").child(auth.uid).exists()',
          },
        },
      },
    },
  },
};

const STORAGE_RULES = `service firebase.storage {
  match /b/{bucket}/o {
    match /rooms/{roomId}/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

function collaborationCampaign(): AuthorizationCampaignSpec {
  return {
    schema: "pyric.assurance.campaign.v1",
    id: "collaboration-local-v1",
    target: {
      schema: "pyric.assurance.target.v1",
      network: "forbid",
      rules: {
        firestore: FIRESTORE_RULES,
        rtdb: RTDB_RULES,
        storage: STORAGE_RULES,
      },
      state: {
        firestore: {
          "rooms/r1": { ownerId: "alice", title: "Original title" },
          "rooms/r1/members/alice": { role: "owner" },
          "rooms/r1/members/mallory": { role: "member" },
        },
        rtdb: {
          rooms: {
            r1: {
              members: {
                alice: { role: "owner", status: "online" },
                mallory: { role: "member", status: "offline" },
              },
            },
          },
        },
        storage: [
          {
            path: "rooms/r1/alice/private.json",
            dataBase64: "YWxpY2Utc2VjcmV0",
            contentType: "application/json",
            customMetadata: { owner: "alice" },
          },
        ],
        auth: {
          users: [
            {
              uid: "mallory",
              email: "mallory@example.test",
              password: "correct-horse-battery-staple",
            },
          ],
        },
      },
    },
    actors: [
      {
        id: "member-b",
        acquisition: {
          kind: "password",
          email: "mallory@example.test",
          password: "correct-horse-battery-staple",
        },
      },
    ],
    invariants: [
      {
        id: "room-owner-immutable",
        service: "firestore",
        statement: "A non-owner room member must not change ownerId.",
        expected: "DENY",
        source: "declared",
        confidence: "authoritative",
      },
      {
        id: "other-role-immutable",
        service: "rtdb",
        statement: "A member must not change another member's role.",
        expected: "DENY",
        source: "declared",
        confidence: "authoritative",
      },
      {
        id: "other-object-immutable",
        service: "storage",
        statement:
          "A member must not overwrite an object owned by another actor.",
        expected: "DENY",
        source: "declared",
        confidence: "authoritative",
      },
    ],
    probes: [
      {
        id: "firestore-owner-transfer",
        actorId: "member-b",
        invariantId: "room-owner-immutable",
        control: {
          service: "firestore",
          method: "update",
          path: "rooms/r1",
          data: { title: "Edited by member" },
        },
        mutation: {
          dimension: "payload",
          description: "Change only the updated field from title to ownerId.",
          operation: {
            service: "firestore",
            method: "update",
            path: "rooms/r1",
            data: { ownerId: "mallory" },
          },
        },
      },
      {
        id: "rtdb-other-role",
        actorId: "member-b",
        invariantId: "other-role-immutable",
        control: {
          service: "rtdb",
          method: "set",
          path: "/rooms/r1/members/mallory/status",
          data: "online",
        },
        mutation: {
          dimension: "path",
          description:
            "Change only the target path from own status to another member role.",
          operation: {
            service: "rtdb",
            method: "set",
            path: "/rooms/r1/members/alice/role",
            data: "online",
          },
        },
      },
      {
        id: "storage-overwrite-owner",
        actorId: "member-b",
        invariantId: "other-object-immutable",
        control: {
          service: "storage",
          method: "upload",
          path: "rooms/r1/mallory/note.json",
          dataBase64: "bWFsbG9yeS1ub3Rl",
          contentType: "application/json",
          customMetadata: { owner: "mallory" },
        },
        mutation: {
          dimension: "path",
          description:
            "Change only the target from a new own object to an existing other-owned object.",
          operation: {
            service: "storage",
            method: "upload",
            path: "rooms/r1/alice/private.json",
            dataBase64: "bWFsbG9yeS1ub3Rl",
            contentType: "application/json",
            customMetadata: { owner: "mallory" },
          },
        },
      },
    ],
  };
}

describe("runAuthorizationCampaign", () => {
  it("proves reachable controls and state-changing local counterexamples across every rules service", async () => {
    const report = await runAuthorizationCampaign(collaborationCampaign());

    expect(report.schema).toBe("pyric.assurance.report.v1");
    expect(report.localOnly).toEqual({
      network: "forbid",
      engine: "pyric-local-sandboxes",
    });
    expect(report.summary).toEqual({
      probes: 3,
      controlsPassed: 3,
      localCounterexamples: 3,
      candidateSignals: 0,
      noCounterexamples: 0,
      engineGaps: 0,
      invalidProbes: 0,
    });

    for (const result of report.results) {
      expect(result.actorEvidence).toMatchObject({
        actorId: "member-b",
        acquisition: "password",
        reachability: "reachable",
        uid: "mallory",
      });
      expect(result.control.decision).toBe("ALLOW");
      expect(result.mutation.decision).toBe("ALLOW");
      expect(result.classification).toBe("local-counterexample");
      expect(result.qualification.supported).toBe(true);
      expect(result.stateDiff?.changed).toBe(true);
    }

    expect(
      report.results.find(
        (result) => result.probeId === "firestore-owner-transfer",
      )?.stateDiff,
    ).toMatchObject({
      before: { ownerId: "alice", title: "Original title" },
      after: { ownerId: "mallory", title: "Original title" },
    });
    expect(
      report.results.find((result) => result.probeId === "rtdb-other-role")
        ?.stateDiff,
    ).toMatchObject({ before: "owner", after: "online" });
    expect(
      report.results.find(
        (result) => result.probeId === "storage-overwrite-owner",
      )?.stateDiff,
    ).toMatchObject({
      before: { text: "alice-secret", customMetadata: { owner: "alice" } },
      after: {
        text: "mallory-note",
        customMetadata: { owner: "mallory" },
      },
    });
  });

  it("classifies Storage get on a missing object as ALLOW when rules permit read and minimizes Storage customMetadata payloads (ST-CON-6)", async () => {
    const campaign = createAuthorizationCampaign({
      id: "st-con-6-test",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {
          storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{id} {
      allow get, create: if true;
    }
  }
}`,
        },
        state: {
          storage: [
            {
              path: "docs/seeded.txt",
              dataBase64: "c2VlZGVk",
              contentType: "text/plain",
            },
          ],
        },
      },
    });

    campaign.addActor({
      id: "anon",
      acquisition: { kind: "anonymous-request" },
    });
    campaign.addInvariant({
      id: "inv-st",
      service: "storage",
      statement: "Missing object read is allowed and payload customMetadata is minimized",
      expected: "DENY",
      source: "agent",
      confidence: "authoritative",
    });
    campaign.addProbe({
      id: "probe-st-missing-get",
      actorId: "anon",
      invariantId: "inv-st",
      control: { service: "storage", method: "get", path: "docs/seeded.txt" },
      mutation: {
        dimension: "path",
        description: "read missing object",
        operation: { service: "storage", method: "get", path: "docs/missing.txt" },
      },
    });
    campaign.addProbe({
      id: "probe-st-payload",
      actorId: "anon",
      invariantId: "inv-st",
      control: {
        service: "storage",
        method: "upload",
        path: "docs/out.txt",
        dataBase64: "aGk=",
        contentType: "text/plain",
        customMetadata: {},
      },
      mutation: {
        dimension: "payload",
        description: "upload with extra metadata keys",
        operation: {
          service: "storage",
          method: "upload",
          path: "docs/out.txt",
          dataBase64: "aGk=",
          contentType: "text/plain",
          customMetadata: {
            escalatedRole: "admin",
            extraNoise1: "x",
            extraNoise2: "y",
          },
        },
      },
    });

    await campaign.run();
    const missingGet = campaign.inspect("probe-st-missing-get");
    expect(missingGet.control.decision).toBe("ALLOW");
    expect(missingGet.mutation.decision).toBe("ALLOW");

    const minimized = await campaign.minimize("probe-st-payload");
    expect(minimized.changed).toBe(true);
    expect(minimized.removedPayloadFields).toEqual([
      "escalatedRole",
      "extraNoise1",
    ]);
  });

  it("seeds target.state.firestore into Storage runtime for cross-service firestore.get/exists lookups (AV-RUN-5)", async () => {
    const report = await runAuthorizationCampaign({
      schema: "pyric.assurance.campaign.v1",
      id: "av-run-5-cross-service",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {
          storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /rooms/{roomId}/{fileName} {
      allow read: if request.auth != null &&
        firestore.get(/databases/(default)/documents/rooms/$(roomId)).data.owner == request.auth.uid;
    }
  }
}`,
        },
        state: {
          auth: { users: [{ uid: "alice", email: "alice@example.com" }] },
          firestore: {
            "rooms/r-alice": { owner: "alice" },
            "rooms/r-bob": { owner: "bob" },
          },
          storage: [
            {
              path: "rooms/r-alice/doc.txt",
              dataBase64: Buffer.from("alice-doc", "utf8").toString("base64"),
              contentType: "text/plain",
            },
            {
              path: "rooms/r-bob/doc.txt",
              dataBase64: Buffer.from("bob-doc", "utf8").toString("base64"),
              contentType: "text/plain",
            },
          ],
        },
      },
      actors: [{ id: "alice", acquisition: { kind: "fixture-user", uid: "alice" } }],
      invariants: [
        {
          id: "inv-room-storage",
          service: "storage",
          statement: "Only the room owner in Firestore may read room files.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "probe-room-file",
          actorId: "alice",
          invariantId: "inv-room-storage",
          control: { service: "storage", method: "get", path: "rooms/r-alice/doc.txt" },
          mutation: {
            dimension: "path",
            description: "Read Bob's room file.",
            operation: { service: "storage", method: "get", path: "rooms/r-bob/doc.txt" },
          },
        },
      ],
    });

    expect(report.results[0]!.control.decision).toBe("ALLOW");
    expect(report.results[0]!.mutation.decision).toBe("DENY");
    expect(report.results[0]!.classification).toBe("no-counterexample");
  });

  it("normalizes leading/trailing slashes on Firestore paths and compares raw bytes on Storage binary stateDiffs (AV-RUN-7)", async () => {
    const report = await runAuthorizationCampaign({
      schema: "pyric.assurance.campaign.v1",
      id: "av-run-7-state-diff",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {
          firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if request.auth != null && resource.data.owner == request.auth.uid;
    }
  }
}`,
          storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /blobs/{file} { allow read, write: if request.auth != null; }
  }
}`,
        },
        state: {
          auth: { users: [{ uid: "alice", email: "alice@example.com" }] },
          firestore: { "/rooms/r1": { owner: "alice" }, "rooms/r2": { owner: "bob" } },
          storage: [
            {
              path: "blobs/key.bin",
              dataBase64: Buffer.from([0xff, 0xfe]).toString("base64"),
              contentType: "application/octet-stream",
            },
          ],
        },
      },
      actors: [{ id: "alice", acquisition: { kind: "fixture-user", uid: "alice" } }],
      invariants: [
        {
          id: "fs-inv",
          service: "firestore",
          statement: "Users cannot read another user's room.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
        {
          id: "st-inv",
          service: "storage",
          statement: "Binary key cannot be overwritten.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "fs-slash-probe",
          actorId: "alice",
          invariantId: "fs-inv",
          control: { service: "firestore", method: "get", path: "/rooms/r1" },
          mutation: {
            dimension: "path",
            description: "Read /rooms/r2 with leading slash.",
            operation: { service: "firestore", method: "get", path: "/rooms/r2" },
          },
        },
        {
          id: "st-binary-probe",
          actorId: "alice",
          invariantId: "st-inv",
          control: {
            service: "storage",
            method: "upload",
            path: "blobs/key.bin",
            dataBase64: Buffer.from([0xff, 0xfe]).toString("base64"),
            contentType: "application/octet-stream",
          },
          mutation: {
            dimension: "payload",
            description: "Overwrite with distinct invalid-UTF8 bytes.",
            operation: {
              service: "storage",
              method: "upload",
              path: "blobs/key.bin",
              dataBase64: Buffer.from([0xff, 0xfd]).toString("base64"),
              contentType: "application/octet-stream",
            },
          },
        },
      ],
    });

    expect(report.results[0]!.control.decision).toBe("ALLOW");
    expect(report.results[0]!.mutation.decision).toBe("DENY");
    expect(report.results[0]!.stateDiff).toEqual({
      changed: false,
      before: { owner: "bob" },
      after: { owner: "bob" },
    });

    expect(report.results[1]!.stateDiff?.changed).toBe(true);
    expect(report.results[1]!.classification).toBe("local-counterexample");
  });

  it("does not fabricate email claims or default passwords for AuthFixtureUsers (AV-RUN-8)", async () => {
    const report = await runAuthorizationCampaign({
      schema: "pyric.assurance.campaign.v1",
      id: "av-run-8-auth-fixtures",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {
          firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /public/{docId} { allow read: if request.auth != null; }
    match /emailOnly/{docId} {
      allow read: if request.auth != null && request.auth.token.email is string;
    }
  }
}`,
        },
        state: {
          auth: {
            users: [
              { uid: "phone-user", email: null },
              { uid: "oauth-user", email: "oauth@example.com" },
            ],
          },
          firestore: {
            "public/p1": { ok: true },
            "emailOnly/e1": { secret: "only-for-users-with-email" },
          },
        },
      },
      actors: [
        { id: "phone-actor", acquisition: { kind: "fixture-user", uid: "phone-user" } },
        {
          id: "forged-password-actor",
          acquisition: {
            kind: "password",
            email: "oauth@example.com",
            password: "__pyric_fixture_password__",
          },
        },
      ],
      invariants: [
        {
          id: "inv-email-claim",
          service: "firestore",
          statement: "Users without an email cannot access emailOnly docs.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "probe-email-claim",
          actorId: "phone-actor",
          invariantId: "inv-email-claim",
          control: { service: "firestore", method: "get", path: "public/p1" },
          mutation: {
            dimension: "path",
            description: "Read emailOnly/e1 as email-less user.",
            operation: { service: "firestore", method: "get", path: "emailOnly/e1" },
          },
        },
        {
          id: "probe-passwordless-login",
          actorId: "forged-password-actor",
          invariantId: "inv-email-claim",
          control: { service: "firestore", method: "get", path: "public/p1" },
          mutation: {
            dimension: "path",
            description: "Read emailOnly/e1 as forged password actor.",
            operation: { service: "firestore", method: "get", path: "emailOnly/e1" },
          },
        },
      ],
    });

    expect(report.results[0]!.mutation.decision).toBe("DENY");
    expect(report.results[0]!.classification).toBe("no-counterexample");
    expect(report.results[1]!.actorEvidence.reachability).toBe("unreachable");
    expect(report.results[1]!.classification).toBe("invalid-probe");
  });

  it("dispatches Firestore create operations as create rather than set/update on existing documents (AV-RUN-11)", async () => {
    const report = await runAuthorizationCampaign({
      schema: "pyric.assurance.campaign.v1",
      id: "av-run-11-firestore-create",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {
          firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /drafts/{draftId} {
      allow create: if request.auth != null;
    }
    match /rooms/{roomId} {
      allow create: if false;
      allow update: if request.auth != null;
    }
  }
}`,
        },
        state: {
          auth: { users: [{ uid: "alice", email: "alice@example.com" }] },
          firestore: { "rooms/existing": { owner: "bob" } },
        },
      },
      actors: [{ id: "alice", acquisition: { kind: "fixture-user", uid: "alice" } }],
      invariants: [
        {
          id: "inv-no-room-create",
          service: "firestore",
          statement: "Room creation is forbidden.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "probe-create-existing-room",
          actorId: "alice",
          invariantId: "inv-no-room-create",
          control: {
            service: "firestore",
            method: "create",
            path: "drafts/new-draft",
            data: { owner: "alice" },
          },
          mutation: {
            dimension: "path",
            description: "Attempt create on an existing room.",
            operation: {
              service: "firestore",
              method: "create",
              path: "rooms/existing",
              data: { owner: "alice" },
            },
          },
        },
      ],
    });

    const [result] = report.results;
    expect(result!.control.decision).toBe("ALLOW");
    expect(result!.mutation.decision).toBe("DENY");
    expect(result!.mutation.events[0]?.method).toBe("create");
    expect(result!.stateDiff?.changed).toBe(false);
    expect(result!.classification).toBe("no-counterexample");
  });
});
