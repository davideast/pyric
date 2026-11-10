import "fake-indexeddb/auto";
import { describe, expect, it } from "bun:test";
import { VectorValue } from "pyric/firestore";
import { initializeSandbox } from "pyric/sandbox";
import {
  executeFirestore,
  executeRtdb,
  executeStorage,
} from "../../src/assurance/runner-operations.js";
import {
  acquireActor,
  createRuntime,
} from "../../src/assurance/runner-runtime.js";
import {
  ASSURANCE_TARGET_SCHEMA,
  type LocalFirebaseTarget,
} from "../../src/assurance/types.js";

describe("assurance runner-operations", () => {
  it("executes Firestore, RTDB, and Storage operations against isolated service runtimes", async () => {
    const target: LocalFirebaseTarget = {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules: {
        firestore: `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} { allow read, write: if request.auth != null; }\n  }\n}`,
        rtdb: {
          rules: {
            items: {
              ".read": "auth != null",
              ".write": "auth != null",
            },
          },
        },
        storage: `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /files/{uid}/{name} { allow read, write: if request.auth != null; }\n  }\n}`,
      },
      state: {
        firestore: { "items/item-1": { title: "Alpha" } },
        rtdb: { items: { a: 1, b: 2 } },
        storage: [{ path: "files/u1/a.txt", dataBase64: btoa("hello") }],
        auth: { users: [{ uid: "u1", email: "u1@example.test", password: "pw" }] },
      },
    };
    const actor = acquireActor(initializeSandbox(), target, {
      id: "u1",
      acquisition: { kind: "fixture-user", uid: "u1" },
    });

    const fsRuntime = await createRuntime("c1", "p1", "control", target, actor, "firestore");
    const fsRead = await executeFirestore(
      { service: "firestore", method: "get", path: "items/item-1" },
      fsRuntime.firestore!,
      fsRuntime,
    );
    expect(fsRead).toEqual({ title: "Alpha" });

    const rtdbRuntime = await createRuntime("c1", "p1", "control", target, actor, "rtdb");
    const rtdbRead = await executeRtdb(
      {
        service: "rtdb",
        method: "get",
        path: "items",
        query: { orderBy: { kind: "key" }, startAt: { value: "b" } },
      },
      rtdbRuntime.rtdb!,
    );
    expect(rtdbRead).toEqual({ b: 2 });

    const stRuntime = await createRuntime("c1", "p1", "control", target, actor, "storage");
    const stRead = await executeStorage(
      { service: "storage", method: "get", path: "files/u1/a.txt" },
      stRuntime.storage!,
    );
    expect(stRead).toMatchObject({ text: "hello" });
  });

  it("decodes Firestore GeoPoint, Bytes, DocumentReference, VectorValue, and special number envelopes across create, set, merge, update, and list", async () => {
    const target: LocalFirebaseTarget = {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules: {
        firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.ownerId == request.auth.uid
        && request.resource.data.coords is latlng
        && request.resource.data.payload is bytes
        && request.resource.data.ownerRef is reference;
      allow update: if request.auth != null
        && request.resource.data.ownerId == request.auth.uid
        && request.resource.data.coords is latlng
        && request.resource.data.payload is bytes
        && request.resource.data.ownerRef is reference
        && request.resource.data.embedding == resource.data.embedding;
    }
  }
}`,
      },
      state: {
        auth: { users: [{ uid: "u1" }] },
        firestore: {
          "items/seeded": {
            ownerId: "u1",
            coords: { type: "pyric/geopoint/1.0", latitude: 37.77, longitude: -122.41 },
            payload: { type: "pyric/bytes/1.0", base64: "AQID" },
            ownerRef: { type: "pyric/ref/1.0", path: "users/u1" },
            embedding: { type: "pyric/vector/1.0", values: [1, 2] },
            nanMetric: { type: "pyric/number/1.0", value: "NaN" },
          },
        },
      },
    };
    const actor = acquireActor(initializeSandbox(), target, {
      id: "u1",
      acquisition: { kind: "fixture-user", uid: "u1" },
    });

    const typedPayload = {
      ownerId: "u1",
      coords: { type: "firestore/geoPoint/1.0", latitude: 37.77, longitude: -122.41 },
      payload: { type: "firestore/bytes/1.0", base64: "AQID" },
      ownerRef: { type: "firestore/documentReference/1.0", path: "users/u1" },
      embedding: { type: "pyric/vector/1.0", values: [0.5, 1.5] },
      score: { type: "pyric/number/1.0", value: "Infinity" },
    };

    const createRt = await createRuntime("c1", "p1", "control", target, actor, "firestore");
    await expect(
      executeFirestore(
        { service: "firestore", method: "create", path: "items/new-1", data: typedPayload },
        createRt.firestore!,
        createRt,
      ),
    ).resolves.toBeNull();

    const setRt = await createRuntime("c1", "p2", "control", target, actor, "firestore");
    await expect(
      executeFirestore(
        { service: "firestore", method: "set", path: "items/new-2", data: typedPayload },
        setRt.firestore!,
        setRt,
      ),
    ).resolves.toBeNull();

    await expect(
      executeFirestore(
        {
          service: "firestore",
          method: "update",
          path: "items/seeded",
          data: {
            coords: { type: "pyric/geopoint/1.0", latitude: 40.71, longitude: -74.0 },
            embedding: { type: "pyric/vector/1.0", values: [1, 2] },
          },
        },
        setRt.firestore!,
        setRt,
      ),
    ).resolves.toBeNull();

    const readNew2 = (await executeFirestore(
      { service: "firestore", method: "get", path: "items/new-2" },
      setRt.firestore!,
      setRt,
    )) as Record<string, unknown>;
    expect(readNew2.embedding).toBeInstanceOf(VectorValue);
    expect(readNew2.score).toBe(Number.POSITIVE_INFINITY);

    const listed = (await executeFirestore(
      {
        service: "firestore",
        method: "list",
        path: "items",
        query: {
          where: [
            {
              field: "ownerRef",
              op: "==",
              value: { type: "pyric/ref/1.0", path: "users/u1" },
            },
          ],
        },
      },
      setRt.firestore!,
      setRt,
    )) as Array<{ path: string }>;
    expect(listed.map((d) => d.path).sort()).toEqual(["items/new-2", "items/seeded"]);
  });
});
