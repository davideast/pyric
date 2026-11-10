import "fake-indexeddb/auto";
import { describe, expect, it } from "bun:test";
import { runAuthorizationCampaign } from "../../src/assurance/runner.js";
import {
  ASSURANCE_CAMPAIGN_SCHEMA,
  ASSURANCE_TARGET_SCHEMA,
  type AuthorizationCampaignSpec,
} from "../../src/assurance/types.js";

describe("runAuthorizationCampaign", () => {
  it("evaluates JSON-serialized Firestore Timestamp markers and Storage objects end-to-end", async () => {
    const rawSpec: AuthorizationCampaignSpec = {
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "runner-mirror-campaign",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          firestore: `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} {\n      allow read: if request.auth != null\n        && request.auth.uid == resource.data.ownerId\n        && resource.data.createdAt is timestamp\n        && resource.data.ownerRef is reference\n        && resource.data.ownerRef.path == 'users/' + request.auth.uid\n        && resource.data.literalMap.type == 'firestore/timestamp/1.0';\n    }\n  }\n}`,
          storage: `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /files/{uid}/{name} {\n      allow read: if request.auth != null && request.auth.uid == uid;\n    }\n  }\n}`,
        },
        state: {
          firestore: {
            "items/u1-item": {
              ownerId: "u1",
              createdAt: {
                type: "firestore/timestamp/1.0",
                seconds: 1_700_000_000,
                nanoseconds: 0,
              },
              ownerRef: {
                __type: "reference",
                path: "users/u1",
              },
              literalMap: {
                type: "pyric/map/1.0",
                fields: {
                  type: "firestore/timestamp/1.0",
                  note: "user-map",
                },
              },
            },
            "items/u2-item": {
              ownerId: "u2",
              createdAt: {
                type: "firestore/timestamp/1.0",
                seconds: 1_700_000_000,
                nanoseconds: 0,
              },
              ownerRef: {
                __type: "reference",
                path: "users/u2",
              },
              literalMap: {
                type: "pyric/map/1.0",
                fields: {
                  type: "firestore/timestamp/1.0",
                  note: "user-map",
                },
              },
            },
          },
          storage: [
            {
              path: "files/u1/own.txt",
              dataBase64: btoa("u1-secret"),
              contentType: "text/plain",
            },
            {
              path: "files/u2/other.txt",
              dataBase64: btoa("u2-secret"),
              contentType: "text/plain",
            },
          ],
          auth: {
            users: [
              { uid: "u1", providerId: "anonymous" },
              { uid: "u2", email: "u2@example.test", password: "pw-2" },
            ],
          },
        },
      },
      actors: [
        { id: "anon-owner", acquisition: { kind: "fixture-user", uid: "u1" } },
      ],
      invariants: [
        {
          id: "inv-fs",
          statement: "Only owner reads items/{id}",
          service: "firestore",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
        {
          id: "inv-st",
          statement: "Only owner reads files/{uid}/{name}",
          service: "storage",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "probe-fs",
          actorId: "anon-owner",
          invariantId: "inv-fs",
          control: { service: "firestore", method: "get", path: "items/u1-item" },
          mutation: {
            dimension: "path",
            description: "Read another owner's item",
            operation: { service: "firestore", method: "get", path: "items/u2-item" },
          },
        },
        {
          id: "probe-st",
          actorId: "anon-owner",
          invariantId: "inv-st",
          control: { service: "storage", method: "get", path: "files/u1/own.txt" },
          mutation: {
            dimension: "path",
            description: "Read another owner's file",
            operation: { service: "storage", method: "get", path: "files/u2/other.txt" },
          },
        },
      ],
    };

    const spec = JSON.parse(JSON.stringify(rawSpec)) as AuthorizationCampaignSpec;
    const report = await runAuthorizationCampaign(spec);
    expect(report.summary.controlsPassed).toBe(2);
    expect(report.summary.noCounterexamples).toBe(2);
  });

  it("forwards undeployedBucketPolicy='allow' and normalizes gs:// Storage bucket instances", async () => {
    const ownerRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/files/{fileId} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;
    const readOnlyBucketRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/files/{fileId} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if false;
    }
  }
}`;

    const openPolicyNoDefaultRules = await runAuthorizationCampaign({
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "camp-open-bucket-policy",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          storageBuckets: {
            "ruled-bucket": ownerRules,
          },
        },
        state: {
          auth: { users: [{ uid: "u1" }] },
          storageConfig: { undeployedBucketPolicy: "allow" },
        },
      },
      actors: [
        { id: "owner", label: "Owner", acquisition: { kind: "fixture-user", uid: "u1" } },
      ],
      invariants: [
        {
          id: "inv-secondary-denied",
          statement: "Writes to unruled buckets must be denied",
          service: "storage",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "p-open-undeployed",
          actorId: "owner",
          invariantId: "inv-secondary-denied",
          control: {
            service: "storage",
            instance: "ruled-bucket",
            method: "upload",
            path: "users/u1/files/f1",
            dataBase64: "YQ==",
          },
          mutation: {
            dimension: "path",
            description: "Upload into open undeployed bucket",
            operation: {
              service: "storage",
              instance: "open-secondary-bucket",
              method: "upload",
              path: "users/u1/files/f1",
              dataBase64: "YQ==",
            },
          },
        },
      ],
    });
    expect(openPolicyNoDefaultRules.results[0]?.classification).toBe("local-counterexample");

    const gsUrlReport = await runAuthorizationCampaign({
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "camp-gs-url-bucket",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          storage: ownerRules,
          storageBuckets: {
            "media-bucket": readOnlyBucketRules,
          },
        },
        state: {
          auth: { users: [{ uid: "u1" }] },
          storageBuckets: {
            "media-bucket": [
              {
                path: "users/u1/files/seed.txt",
                dataBase64: btoa("seed"),
                contentType: "text/plain",
              },
            ],
          },
        },
      },
      actors: [
        { id: "owner", label: "Owner", acquisition: { kind: "fixture-user", uid: "u1" } },
      ],
      invariants: [
        {
          id: "inv-media-readonly",
          statement: "Media bucket denies writes",
          service: "storage",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "p-gs-url",
          actorId: "owner",
          invariantId: "inv-media-readonly",
          control: {
            service: "storage",
            instance: "gs://media-bucket/",
            method: "get",
            path: "users/u1/files/seed.txt",
          },
          mutation: {
            dimension: "operation",
            description: "Attempt delete via gs:// URL instance",
            operation: {
              service: "storage",
              instance: "gs://media-bucket/",
              method: "delete",
              path: "users/u1/files/seed.txt",
            },
          },
        },
      ],
    });
    expect(gsUrlReport.results[0]?.control.decision).toBe("ALLOW");
    expect(gsUrlReport.results[0]?.mutation.decision).toBe("DENY");
    expect(gsUrlReport.results[0]?.classification).toBe("no-counterexample");
  });

  it("formats non-Error Firestore create denial objects cleanly without '[object Object]'", async () => {
    const report = await runAuthorizationCampaign({
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: "camp-create-denial-msg",
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules: {
          firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow create: if request.auth != null && request.resource.data.ownerId == request.auth.uid;
    }
  }
}`,
        },
        state: { auth: { users: [{ uid: "u1" }] } },
      },
      actors: [{ id: "owner", acquisition: { kind: "fixture-user", uid: "u1" } }],
      invariants: [
        {
          id: "inv-create",
          statement: "Forged ownerId denied",
          service: "firestore",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "p-create",
          actorId: "owner",
          invariantId: "inv-create",
          control: {
            service: "firestore",
            method: "create",
            path: "items/i1",
            data: { ownerId: "u1" },
          },
          mutation: {
            dimension: "payload",
            description: "Forged ownerId",
            operation: {
              service: "firestore",
              method: "create",
              path: "items/i1",
              data: { ownerId: "u2" },
            },
          },
        },
      ],
    });
    expect(report.results[0]?.mutation.decision).toBe("DENY");
    expect(report.results[0]?.mutation.error?.message).toBeDefined();
    expect(report.results[0]?.mutation.error?.message).not.toBe("[object Object]");
  });
});
