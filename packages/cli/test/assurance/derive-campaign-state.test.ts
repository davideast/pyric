import { describe, expect, test } from "bun:test";
import {
  applyStepToTargetState,
  initializeTargetState,
  materializeDataValue,
  replaceIdentityDeep,
  stepToFirebaseOperation,
} from "../../src/assurance/derive-campaign-state.js";
import type { LocalFirebaseTarget } from "../../src/assurance/types.js";

describe("derive-campaign-state", () => {
  test("materializes sentinels and omits deleteField keys", () => {
    const out = materializeDataValue(
      {
        updatedAt: { __sentinel: "serverTimestamp" },
        count: { __sentinel: "increment", by: 3 },
        removed: { __sentinel: "deleteField" },
      },
      { count: 10 },
    );
    expect(out).toEqual({
      updatedAt: 1_700_000_000_000,
      count: 13,
    });
  });

  test("replaces actor identities across strings, arrays, and object keys/values", () => {
    const replaced = replaceIdentityDeep(
      {
        "users/u-alice/status": { ownerId: "u-alice", tags: ["u-alice"] },
      },
      [["u-alice", "u-bob"]],
    );
    expect(replaced).toEqual({
      "users/u-bob/status": { ownerId: "u-bob", tags: ["u-bob"] },
    });
  });

  test("converts ProbeStep across services and applies steps to target state", () => {
    const state: LocalFirebaseTarget["state"] = {};
    applyStepToTargetState(state, {
      actor: "owner",
      service: "firestore",
      method: "create",
      path: "orgs/acme/items/i1",
      data: { ownerId: "u-alice" },
    });
    expect(state.firestore?.["orgs/acme/items/i1"]).toEqual({
      ownerId: "u-alice",
    });

    const storageOp = stepToFirebaseOperation({
      actor: "peer",
      service: "storage",
      method: "create",
      path: "orgs/acme/files/f1.png",
      sizeBytes: 16,
      contentType: "image/png",
      cacheControl: "public, max-age=3600",
      contentDisposition: "inline",
      contentEncoding: "gzip",
      contentLanguage: "en",
      customMetadata: { ownerId: "u-alice" },
    });
    expect(storageOp.service).toBe("storage");
    if (storageOp.service === "storage") {
      expect(storageOp.method).toBe("upload");
      expect(storageOp.cacheControl).toBe("public, max-age=3600");
      expect(storageOp.contentDisposition).toBe("inline");
      expect(storageOp.contentEncoding).toBe("gzip");
      expect(storageOp.contentLanguage).toBe("en");
    }

    applyStepToTargetState(state, {
      actor: "owner",
      service: "storage",
      method: "create",
      path: "orgs/acme/files/f1.png",
      sizeBytes: 16,
      contentType: "image/png",
      cacheControl: "public, max-age=3600",
      contentDisposition: "inline",
      contentEncoding: "gzip",
      contentLanguage: "en",
    });
    expect(state.storage?.[0]).toMatchObject({
      path: "orgs/acme/files/f1.png",
      contentType: "image/png",
      cacheControl: "public, max-age=3600",
      contentDisposition: "inline",
      contentEncoding: "gzip",
      contentLanguage: "en",
    });

    // Subsequent synthetic admin seed steps do not wipe existing HTTP metadata
    applyStepToTargetState(state, {
      actor: "admin",
      service: "storage",
      method: "set",
      path: "orgs/acme/files/f1.png",
      sizeBytes: 16,
      contentType: "image/png",
    });
    expect(state.storage?.[0]).toMatchObject({
      path: "orgs/acme/files/f1.png",
      contentType: "image/png",
      cacheControl: "public, max-age=3600",
      contentDisposition: "inline",
      contentEncoding: "gzip",
      contentLanguage: "en",
    });
  });

  test("guards against __proto__, constructor, and prototype pollution in RTDB paths and document payloads", () => {
    const state: LocalFirebaseTarget["state"] = {};
    try {
      applyStepToTargetState(state, {
        actor: "peer",
        service: "rtdb",
        method: "update",
        path: "__proto__",
        data: { pollutedFlag: "compromised" },
      });
      applyStepToTargetState(state, {
        actor: "peer",
        service: "rtdb",
        method: "set",
        path: "constructor/prototype/pollutedFlag",
        data: "compromised",
      });

      const rawDoc = JSON.parse(
        '{"__proto__":{"pollutedNested":true},"safeKey":"u-alice"}',
      ) as Record<string, unknown>;
      applyStepToTargetState(state, {
        actor: "owner",
        service: "firestore",
        method: "create",
        path: "__proto__",
        data: rawDoc,
      });

      const replaced = replaceIdentityDeep(rawDoc, [["u-alice", "u-bob"]]);
      expect(Object.getPrototypeOf(replaced)).toBe(Object.prototype);
      expect(replaced.safeKey).toBe("u-bob");
      expect(Object.hasOwn({}, "pollutedFlag")).toBe(false);
      expect(({} as Record<string, unknown>).pollutedFlag).toBeUndefined();
      expect(({} as Record<string, unknown>).pollutedNested).toBeUndefined();
      expect(Object.getPrototypeOf(state.firestore)).toBe(Object.prototype);
    } finally {
      Reflect.deleteProperty(Object.prototype, "pollutedFlag");
      Reflect.deleteProperty(Object.prototype, "pollutedNested");
    }
  });

  test("initializeTargetState preserves auth.providers and storageConfig", () => {
    const out = initializeTargetState(
      undefined,
      {
        auth: {
          users: [{ uid: "u-1", email: "u1@example.test" }],
          providers: { anonymous: false },
        },
        storageConfig: {
          crossServiceIam: "denied",
          undeployedBucketPolicy: "allow",
        },
      },
      [],
    );
    expect(out.auth?.providers).toEqual({ anonymous: false });
    expect(out.storageConfig).toEqual({
      crossServiceIam: "denied",
      undeployedBucketPolicy: "allow",
    });
  });

  test("initializeTargetState never injects synthesized actor token claims onto existing seeded Auth users", () => {
    const out = initializeTargetState(
      undefined,
      {
        auth: {
          users: [
            { uid: "u-1", email: "u1@example.test", emailVerified: false },
            { uid: "u-2", email: "u2@example.test", emailVerified: true, customClaims: { tier: "free" } },
          ],
        },
      },
      [
        {
          role: "owner",
          uid: "u-1",
          email: "u1@example.test",
          displayName: "U1",
          token: { role: "staff", email_verified: true },
          synthetic: false,
        },
        {
          role: "peer",
          uid: "u-2",
          email: "u2@example.test",
          displayName: "U2",
          token: { role: "staff", email_verified: true },
          synthetic: false,
        },
      ],
    );
    const u1 = out.auth?.users.find((u) => u.uid === "u-1");
    const u2 = out.auth?.users.find((u) => u.uid === "u-2");
    expect(u1?.emailVerified).toBe(false);
    expect(u1?.customClaims).toBeUndefined();
    expect(u2?.customClaims).toEqual({ tier: "free" });
  });
});
