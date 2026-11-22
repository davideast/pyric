import "fake-indexeddb/auto";
import { describe, expect, it } from "bun:test";
import { getAuth, sandbox as authSandbox } from "pyric/auth";
import { Reference as RulesReference, Timestamp as RulesTimestamp } from "pyric/rules/internal";
import { initializeSandbox } from "pyric/sandbox";
import { getBytes, ref as storageRef } from "pyric/storage";
import { ASSURANCE_TARGET_SCHEMA, type LocalFirebaseTarget } from "../../src/assurance/types.js";
import {
  acquireActor,
  createRuntime,
  normalizeFirestoreDocuments,
  seedAuth,
  targetHash,
} from "../../src/assurance/runner-runtime.js";

describe("assurance runner-runtime", () => {
  it("keeps targetHash identical across JSON round-trips on ValueCodec-encoded targets", () => {
    const target: LocalFirebaseTarget = {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules: {
        firestore: `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} { allow read: if true; }\n  }\n}`,
      },
      state: {
        firestore: {
          "items/item-1": {
            title: "Widget",
            createdAt: {
              type: "firestore/timestamp/1.0",
              seconds: 1_700_000_000,
              nanoseconds: 500_000_000,
            },
            nanScore: {
              type: "pyric/number/1.0",
              value: "NaN",
            },
            ownerRef: {
              __type: "reference",
              path: "users/u1",
              databaseId: "analytics",
            },
          },
        },
        auth: {
          users: [
            {
              uid: "u1",
              email: "u1@example.test",
              displayName: "Alice Example",
              photoUrl: "https://example.test/u1.png",
              phoneNumber: "+15550101",
              tenantId: "org-1",
            },
            {
              uid: "anon-1",
              providerId: "anonymous",
            },
          ],
        },
      },
    };

    const roundTripped = JSON.parse(JSON.stringify(target)) as LocalFirebaseTarget;
    expect(targetHash(roundTripped)).toBe(targetHash(target));

    const docs = normalizeFirestoreDocuments(roundTripped.state.firestore);
    const docData = docs["items/item-1"]!;
    expect(docData.title).toBe("Widget");
    expect(docData.createdAt).toBeInstanceOf(RulesTimestamp);
    expect(Number.isNaN(docData.nanScore)).toBe(true);
    expect(docData.ownerRef).toBeInstanceOf(RulesReference);
    expect((docData.ownerRef as RulesReference).databaseId).toBe("analytics");
  });

  it("seeds Auth profile metadata and anonymous accounts and acquires fixture-user actors", () => {
    const sandbox = initializeSandbox();
    const target: LocalFirebaseTarget = {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules: {},
      state: {
        auth: {
          users: [
            {
              uid: "u1",
              email: "u1@example.test",
              password: "pw-1",
              displayName: "Alice Example",
              photoUrl: "https://example.test/u1.png",
              phoneNumber: "+15550101",
              tenantId: "org-1",
              emailVerified: true,
              customClaims: { role: "member" },
            },
            {
              uid: "anon-1",
              providerId: "anonymous",
              displayName: "Guest",
            },
          ],
        },
      },
    };

    seedAuth(sandbox, target);
    const listed = authSandbox.listUsers(getAuth(sandbox));
    expect(listed.find((u) => u.uid === "u1")).toMatchObject({
      uid: "u1",
      email: "u1@example.test",
      displayName: "Alice Example",
      photoUrl: "https://example.test/u1.png",
      phoneNumber: "+15550101",
      tenantId: "org-1",
      emailVerified: true,
      isAnonymous: false,
    });
    expect(listed.find((u) => u.uid === "anon-1")).toMatchObject({
      uid: "anon-1",
      email: null,
      displayName: "Guest",
      isAnonymous: true,
    });

    const anonActor = acquireActor(initializeSandbox(), target, {
      id: "guest",
      acquisition: { kind: "fixture-user", uid: "anon-1" },
    });
    expect(anonActor.evidence.reachability).toBe("reachable");
    expect(anonActor.auth?.uid).toBe("anon-1");
  });

  it("matches password tenantId case-insensitively and preserves linked providerUserInfo identities", () => {
    const target: LocalFirebaseTarget = {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules: {},
      state: {
        auth: {
          users: [
            {
              uid: "u-tenant",
              email: "UserOne@Example.Test",
              password: "secret-password-123",
              tenantId: "tenant-alpha",
              providerUserInfo: [
                { providerId: "password", email: "UserOne@Example.Test" },
                { providerId: "github.com", rawId: "gh-200", email: "UserOne@Example.Test" },
              ],
            },
          ],
        },
      },
    };

    const lowerActor = acquireActor(initializeSandbox(), target, {
      id: "tenant-member",
      acquisition: {
        kind: "password",
        email: "userone@example.test",
        password: "secret-password-123",
      },
    });
    expect(lowerActor.evidence.reachability).toBe("reachable");
    expect(
      (lowerActor.auth?.token.firebase as { tenant?: string } | undefined)?.tenant,
    ).toBe("tenant-alpha");

    const linkedActor = acquireActor(initializeSandbox(), target, {
      id: "linked-member",
      acquisition: { kind: "fixture-user", uid: "u-tenant" },
    });
    const identities = (
      linkedActor.auth?.token.firebase as
        | { identities?: Record<string, unknown> }
        | undefined
    )?.identities;
    expect(identities?.["github.com"]).toBeDefined();
  });

  it("populates md5Hash, crc32c, and etag on rich-metadata seeded Storage objects (#1342)", async () => {
    const target: LocalFirebaseTarget = {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules: {
        storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /rich/six.bin {
      allow get: if resource.md5Hash == 'asHla8ePAxBZvnvoVFIsTA=='
        && resource.crc32c == 'T037qw=='
        && resource.etag is string
        && resource.etag != ''
        && resource.cacheControl == 'no-cache'
        && resource.contentDisposition == 'inline'
        && resource.contentEncoding == 'gzip'
        && resource.contentLanguage == 'en';
    }
  }
}`,
      },
      state: {
        storage: [
          {
            path: "rich/six.bin",
            dataBase64: "AQIDBAUG",
            contentType: "application/octet-stream",
            cacheControl: "no-cache",
            contentDisposition: "inline",
            contentEncoding: "gzip",
            contentLanguage: "en",
          },
        ],
      },
    };
    const actor = acquireActor(initializeSandbox(), target, {
      id: "anon",
      acquisition: { kind: "anonymous-request" },
    });
    const runtime = await createRuntime("camp-1342", "probe-1342", "control", target, actor, "storage");
    if (!runtime.storage) {
      throw new Error("Expected storage runtime");
    }
    const bytes = new Uint8Array(await getBytes(storageRef(runtime.storage, "rich/six.bin")));
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
