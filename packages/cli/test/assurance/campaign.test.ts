import "fake-indexeddb/auto";

import { describe, expect, it } from "bun:test";
import {
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
});
