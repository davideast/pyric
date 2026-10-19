import "fake-indexeddb/auto";
import { describe, expect, it } from "bun:test";
import { initializeSandbox } from "pyric/sandbox";
import {
  createOwnedSandboxAttachmentProvider,
  createSandboxAttachmentProvider,
} from "../../src/assurance/attachment.js";
import { createAuthorizationCampaign } from "../../src/assurance/campaign.js";
import { AssuranceInputError } from "../../src/assurance/types.js";
import {
  assertObservation,
  assertProbe,
  assertTarget,
} from "../../src/assurance/validation.js";

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{id} { allow read, write: if true; }
  }
}`;

describe("Storage attachment rules and coverage gap accuracy (AV-CON-5b/c)", () => {
  it("preserves storageRules from /__pyric/init.json and reports object-enumeration-only gap when Storage rules are present", async () => {
    const sandbox = initializeSandbox();
    const served = createSandboxAttachmentProvider(sandbox, {
      origin: "http://127.0.0.1:4400",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            bridgeUrl: "http://127.0.0.1:4400/__pyric/bridge",
            storageRules: STORAGE_RULES,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const servedAttached = await served({ url: "http://127.0.0.1:4400" });
    expect(servedAttached.target.rules.storage).toBe(STORAGE_RULES);
    expect(servedAttached.coverageGaps).toContainEqual({
      service: "storage",
      code: "storage-attachment-unavailable",
      reason:
        "Storage object enumeration is not yet exposed by attachment; provide explicit Storage objects in target.state.storage.",
    });

    const owned = createOwnedSandboxAttachmentProvider(
      sandbox,
      { storage: STORAGE_RULES },
      "pyric:in-process-sandbox",
    );
    const ownedAttached = await owned({ url: "pyric:in-process-sandbox" });
    expect(ownedAttached.target.rules.storage).toBe(STORAGE_RULES);
    const storageGap = ownedAttached.coverageGaps.find(
      (gap) => gap.service === "storage",
    );
    expect(storageGap?.reason).not.toMatch(/expose Storage rules/i);
  });
});

describe("target.state.firestore document record validation (AV-CON-7)", () => {
  it("rejects null, primitive, and array values in target.state.firestore", () => {
    for (const invalidDoc of [null, "not-an-object", 42, ["a"]]) {
      expect(() =>
        assertTarget({
          schema: "pyric.assurance.target.v1",
          network: "forbid",
          rules: { firestore: FIRESTORE_RULES },
          state: {
            firestore: {
              "rooms/r1": invalidDoc as unknown as Record<string, unknown>,
            },
          },
        }),
      ).toThrow(AssuranceInputError);
    }
  });
});

describe("operation.query validation (AV-CON-8)", () => {
  it("rejects malformed Firestore query.where, query.orderBy, and query.limit at map() time", () => {
    const campaign = createAuthorizationCampaign({
      id: "query-validation",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: { firestore: FIRESTORE_RULES },
        state: { firestore: {} },
      },
    });
    campaign.addInvariant({
      id: "inv-1",
      statement: "Unconstrained list is denied",
      service: "firestore",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });

    expect(() =>
      campaign.map({
        actors: [{ id: "anon", acquisition: { kind: "anonymous-request" } }],
        probes: [
          {
            id: "p-bad-where",
            actorId: "anon",
            invariantId: "inv-1",
            control: {
              service: "firestore",
              method: "list",
              path: "rooms",
              query: { limit: 1 },
            },
            mutation: {
              dimension: "query",
              description: "Malformed query.where object instead of array",
              operation: {
                service: "firestore",
                method: "list",
                path: "rooms",
                query: {
                  where: {
                    field: "public",
                    op: "==",
                    value: true,
                  } as unknown as [],
                },
              },
            },
          },
        ],
      }),
    ).toThrow(/probes\[0\]\.mutation\.operation\.query\.where/);

    expect(() =>
      assertObservation({
        id: "obs-bad-limit",
        actorId: "anon",
        result: "ALLOW",
        source: "authored",
        operation: {
          service: "firestore",
          method: "list",
          path: "rooms",
          query: { limit: 0 },
        },
      }),
    ).toThrow(/observation\.operation\.query\.limit/);

    expect(() =>
      assertObservation({
        id: "obs-bad-rtdb-order",
        actorId: "anon",
        result: "ALLOW",
        source: "authored",
        operation: {
          service: "rtdb",
          method: "get",
          path: "/rooms",
          query: { orderBy: { kind: "child" } },
        },
      }),
    ).toThrow(/observation\.operation\.query\.orderBy\.path/);
  });
});

describe("RTDB update data, Storage upload dataBase64, and base64 validation (AV-CON-9a/b/c)", () => {
  it("rejects non-record data on RTDB update, missing dataBase64 on Storage upload, and invalid base64 strings", () => {
    expect(() =>
      assertObservation({
        id: "obs-rtdb-update",
        actorId: "anon",
        result: "ALLOW",
        source: "authored",
        operation: {
          service: "rtdb",
          method: "update",
          path: "/rooms/r1",
          data: "hi",
        },
      }),
    ).toThrow(/observation\.operation\.data must be an object/);

    expect(() =>
      assertObservation({
        id: "obs-storage-upload-missing",
        actorId: "anon",
        result: "ALLOW",
        source: "authored",
        operation: {
          service: "storage",
          method: "upload",
          path: "/avatars/u1.png",
        },
      }),
    ).toThrow(/observation\.operation\.dataBase64 is required/);

    expect(() =>
      assertObservation({
        id: "obs-storage-upload-bad-b64",
        actorId: "anon",
        result: "ALLOW",
        source: "authored",
        operation: {
          service: "storage",
          method: "upload",
          path: "/avatars/u1.png",
          dataBase64: "%%%not-valid-base64%%%",
        },
      }),
    ).toThrow(/observation\.operation\.dataBase64 must be valid base64/);

    expect(() =>
      assertTarget({
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: { storage: STORAGE_RULES },
        state: {
          storage: [
            { path: "/avatars/u1.png", dataBase64: "%%%not-valid-base64%%%" },
          ],
        },
      }),
    ).toThrow(/target\.state\.storage\[0\]\.dataBase64 must be valid base64/);
  });
});

describe("stableValue ignores undefined-valued object keys (AV-CON-10)", () => {
  it("treats objects with explicit undefined keys as identical to objects omitting those keys", () => {
    expect(() =>
      assertProbe({
        id: "p1",
        actorId: "anon",
        invariantId: "inv-1",
        control: {
          service: "firestore",
          method: "create",
          path: "rooms/r1/messages/m1",
          data: { title: "hello", extra: undefined },
        },
        mutation: {
          dimension: "path",
          description: "Write message to room r2 with identical payload",
          operation: {
            service: "firestore",
            method: "create",
            path: "rooms/r2/messages/m1",
            data: { title: "hello" },
          },
        },
      }),
    ).not.toThrow();
  });
});
