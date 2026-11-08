import "fake-indexeddb/auto";
import { describe, expect, it } from "bun:test";
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
});
