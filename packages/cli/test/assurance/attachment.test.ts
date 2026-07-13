import { describe, expect, it } from "bun:test";
import { getAuth, sandbox as authSandbox } from "pyric/auth";
import {
  getAdminDatabase,
  getDatabase,
  sandbox as rtdbSandbox,
} from "pyric/database";
import { getFirestore } from "pyric/firestore";
import { initializeSandbox } from "pyric/sandbox";
import { seedDocuments, setRules } from "pyric/sandbox/firestore";
import { createSandboxAttachmentProvider } from "../../src/assurance/attachment.js";
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
    expect(attached.coverageGaps).toContainEqual(
      expect.objectContaining({
        service: "storage",
        code: "storage-attachment-unavailable",
      }),
    );
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
});
