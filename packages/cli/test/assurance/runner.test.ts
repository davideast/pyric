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
});
