import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { bundleRecords, initializeSandbox, serializeToBuckets } from "pyric/sandbox";
import { setRules } from "pyric/sandbox/firestore";
import { encodeSnapshotMap, restoreSandboxSnapshot } from "pyric/sandbox/internal";
import { deriveAssurance } from "../../src/assurance/derive.js";
import { cloneLoopbackSandboxHttp } from "../../src/assurance/derive-live-http.js";
import { acquireActor } from "../../src/assurance/runner-runtime.js";
import { AssuranceCampaignStore } from "../../src/assurance/tools.js";
import { ASSURANCE_TARGET_SCHEMA, AssuranceInputError } from "../../src/assurance/types.js";
import { callAssuranceOperation } from "../../src/bridge/surface/assurance-campaigns.js";
import { createSurfaceContext } from "../../src/bridge/surface/context.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("live HTTP cloning, campaign target fidelity, and project containment", () => {
  test("treats only HTTP 404 on /__pyric/state as uninitialized and rejects 409, 500, 401, and transport errors", async () => {
    for (const status of [409, 500, 401, 403]) {
      const mockFetch: typeof fetch = (async (rawUrl: string | URL | Request) => {
        const urlStr = String(rawUrl);
        if (urlStr.endsWith("/__pyric/init.json")) {
          return new Response(
            JSON.stringify({ sessionToken: "tok-1", instanceId: "inst-1" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("state unavailable", { status });
      }) as typeof fetch;

      await expect(
        cloneLoopbackSandboxHttp("http://127.0.0.1:3473", { fetchImpl: mockFetch }),
      ).rejects.toThrow(AssuranceInputError);
    }

    const transportErrorFetch: typeof fetch = (async (rawUrl: string | URL | Request) => {
      const urlStr = String(rawUrl);
      if (urlStr.endsWith("/__pyric/init.json")) {
        return new Response(
          JSON.stringify({ sessionToken: "tok-1", instanceId: "inst-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new AssuranceInputError("Response exceeded maximum clone byte limit.");
    }) as typeof fetch;

    await expect(
      cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
        fetchImpl: transportErrorFetch,
      }),
    ).rejects.toThrow(AssuranceInputError);

    const notFoundFetch: typeof fetch = (async (rawUrl: string | URL | Request) => {
      const urlStr = String(rawUrl);
      if (urlStr.endsWith("/__pyric/init.json")) {
        return new Response(
          JSON.stringify({ sessionToken: "tok-1", instanceId: "inst-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("null", { status: 404 });
    }) as typeof fetch;

    const emptyClone = await cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
      fetchImpl: notFoundFetch,
    });
    expect(emptyClone.snapshot.firestore["(default)"]).toEqual({});
  });

  test("verifies Storage object reference HTTP status, byte length, and sha256 digest", async () => {
    const expectedBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const expectedSha = createHash("sha256").update(expectedBytes).digest("hex");

    const buildObjectFetch = (
      respondObject: () => Promise<Response>,
    ): typeof fetch =>
      (async (rawUrl: string | URL | Request) => {
        const urlStr = String(rawUrl);
        if (urlStr.endsWith("/__pyric/init.json")) {
          return new Response(
            JSON.stringify({ sessionToken: "tok-1", instanceId: "inst-1" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (urlStr.endsWith("/__pyric/state")) {
          return new Response(
            JSON.stringify({
              version: 1,
              firestore: null,
              auth: null,
              storage: [
                {
                  path: "docs/doc-1.bin",
                  sha256: expectedSha,
                  size: expectedBytes.byteLength,
                  blobType: "application/octet-stream",
                  metadata: {
                    bucket: "pyric-default",
                    fullPath: "docs/doc-1.bin",
                    name: "doc-1.bin",
                    size: expectedBytes.byteLength,
                    generation: "1",
                    metageneration: "1",
                    timeCreated: "2026-01-01T00:00:00.000Z",
                    updated: "2026-01-01T00:00:00.000Z",
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (urlStr.endsWith(`/__pyric/state/objects/${expectedSha}`)) {
          return respondObject();
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

    await expect(
      cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
        fetchImpl: buildObjectFetch(async () => new Response("missing", { status: 404 })),
      }),
    ).rejects.toThrow(AssuranceInputError);

    await expect(
      cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
        fetchImpl: buildObjectFetch(async () => new Response(new Uint8Array([1, 2]), { status: 200 })),
      }),
    ).rejects.toThrow(AssuranceInputError);

    await expect(
      cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
        fetchImpl: buildObjectFetch(
          async () => new Response(new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]), { status: 200 }),
        ),
      }),
    ).rejects.toThrow(AssuranceInputError);

    await expect(
      cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
        fetchImpl: buildObjectFetch(async () => {
          throw new TypeError("socket hang up");
        }),
      }),
    ).rejects.toThrow(AssuranceInputError);
  });

  test("partitions named Storage buckets, ingests init.json named RTDB/Storage rules, and seeds named RTDB campaign state", async () => {
    const root = makeTempDir("derive-multi-live-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src/app.ts"),
      `import { getDatabase, ref as dbRef, query as dbQuery, orderByChild, equalTo, get as dbGet } from 'pyric/database';
import { getStorage, ref as stRef, getBytes, uploadBytes } from 'pyric/storage';
declare const app: unknown;
export async function accessNamedResources() {
  const db = getDatabase(app, 'https://inst-secondary.firebaseio.com');
  await dbGet(dbQuery(dbRef(db, 'items'), orderByChild('rank'), equalTo(1)));
  const sec = getStorage(app, 'gs://bucket-secondary');
  await getBytes(stRef(sec, 'docs/doc-1'));
  await uploadBytes(stRef(sec, 'uploads/note.txt'), new Uint8Array([1]), { contentType: 'text/plain' });
}
`,
    );

    const records = serializeToBuckets(
      {},
      {
        rtdb: {
          ".pyricRtdbPersistence": 1,
          data: null,
          priorities: {},
          instances: {
            "inst-secondary": {
              ".pyricRtdbPersistence": 1,
              data: { items: { "item-1": { ownerId: "u-1", rank: 1 } } },
              priorities: {},
            },
          },
        },
        auth: {
          users: [
            { uid: "u-1", email: "u1@example.test" },
            { uid: "u-2", email: "u2@example.test" },
          ],
          providers: {},
        },
      },
      1_700_000_000_000,
    );
    const v3Firestore = JSON.parse(bundleRecords(records)) as unknown;
    const seededBytes = Buffer.alloc(32, 7).toString("base64");

    const server = createServer((req, res) => {
      if (req.url === "/__pyric/init.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionToken: "tok-1",
            instanceId: "inst-1",
            databaseInstances: {
              rules: {
                "inst-secondary": {
                  rules: {
                    items: {
                      ".read": "auth != null",
                      $id: {
                        ".read": "auth != null && data.child('ownerId').val() === auth.uid",
                      },
                    },
                  },
                },
              },
            },
            storageBucketRules: {
              "bucket-secondary": {
                rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read: if request.auth != null && resource.metadata.ownerId == request.auth.uid;
      allow delete: if request.auth != null && resource.metadata.ownerId == request.auth.uid && resource.size == 32;
    }
    match /uploads/{name} {
      allow create: if request.auth != null && request.resource.contentType.matches('image/.*');
    }
  }
}
`,
              },
            },
          }),
        );
        return;
      }
      if (req.url === "/__pyric/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            version: 1,
            firestore: v3Firestore,
            auth: null,
            storage: [
              {
                path: "docs/doc-1",
                dataBase64: seededBytes,
                size: 32,
                blobType: "application/octet-stream",
                metadata: {
                  bucket: "bucket-secondary",
                  fullPath: "docs/doc-1",
                  name: "doc-1",
                  size: 32,
                  generation: "1",
                  metageneration: "1",
                  timeCreated: "2026-01-01T00:00:00.000Z",
                  updated: "2026-01-01T00:00:00.000Z",
                  contentType: "application/octet-stream",
                  customMetadata: { ownerId: "u-1" },
                },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const store = new AssuranceCampaignStore();
      const derived = await deriveAssurance(
        { root, url: origin, includeHeuristic: false },
        { store },
      );

      const tagged = derived.diagnostics.map((d) => `${d.code}@${d.resourceId}`);
      expect(tagged).toContain("rtdb-missing-index-on@inst-secondary");
      expect(tagged).toContain("storage-content-type-mismatch@bucket-secondary");
      expect(
        derived.diagnostics.some(
          (d) =>
            d.code === "assurance-must-allow-denied" &&
            d.path === "docs/doc-1",
        ),
      ).toBe(false);

      const campaign = store.get(derived.campaignId);
      expect(campaign.target.state.rtdbInstances?.["inst-secondary"]).toBeDefined();
      expect(campaign.target.state.storage).toBeUndefined();
      const secondaryObjects = campaign.target.state.storageBuckets?.["bucket-secondary"];
      expect(secondaryObjects).toHaveLength(1);
      expect(
        Buffer.from(secondaryObjects?.[0]?.dataBase64 ?? "", "base64").byteLength,
      ).toBe(32);

      campaign.target.state.storageBuckets!["bucket-secondary"]!.push({
        path: "docs/doc-2",
        dataBase64: seededBytes,
        contentType: "application/octet-stream",
        customMetadata: { ownerId: "u-2" },
      });
      campaign.addActor({
        id: "actor-peer-check",
        acquisition: { kind: "fixture-user", uid: "u-2" },
      });
      campaign.addInvariant({
        id: "inv-named-bucket-delete",
        statement: "Only owner can delete 32-byte doc in bucket-secondary",
        service: "storage",
        expected: "DENY",
        source: "derived",
        confidence: "strong",
      });
      campaign.addProbe({
        id: "probe-named-bucket-delete",
        actorId: "actor-peer-check",
        invariantId: "inv-named-bucket-delete",
        control: {
          service: "storage",
          method: "delete",
          path: "docs/doc-2",
          instance: "bucket-secondary",
        },
        mutation: {
          dimension: "path",
          description: "Peer deletes owner 32-byte object in bucket-secondary",
          operation: {
            service: "storage",
            method: "delete",
            path: "docs/doc-1",
            instance: "bucket-secondary",
          },
        },
      });
      const report = await campaign.run();
      const bucketProbe = report.results.find((p) => p.probeId === "probe-named-bucket-delete");
      expect(bucketProbe?.classification).toBe("no-counterexample");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("preserves emailVerified, tenantId, disabled, and providerId on in-process snapshots and enforces them in acquireActor", async () => {
    const root = makeTempDir("derive-auth-fidelity-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "firestore.rules"),
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/items/{id} {
      allow read: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.email_verified == true
        && request.auth.token.firebase.tenant == 't-1';
    }
  }
}
`,
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
export async function readItem() {
  const uid = getAuth().currentUser!.uid;
  return getDoc(doc(getFirestore(), 'users', uid, 'items', 'item-1'));
}
`,
    );

    const sandbox = initializeSandbox();
    const { refusals } = await restoreSandboxSnapshot(sandbox, {
      version: 1,
      rules: {},
      auth: {
        users: [
          {
            uid: "u-owner",
            email: "owner@example.test",
            emailVerified: false,
            tenantId: "t-1",
            providerId: "password",
            disabled: false,
          },
          {
            uid: "u-disabled",
            email: "disabled@example.test",
            emailVerified: false,
            tenantId: "t-2",
            disabled: true,
          },
        ],
      },
      firestore: {
        "(default)": {
          "users/u-owner/items/item-1": encodeSnapshotMap({ value: 1 }),
        },
      },
      rtdb: {},
      storage: { "(default)": [] },
    });
    expect(refusals).toEqual([]);

    const store = new AssuranceCampaignStore();
    const derived = await deriveAssurance({ root }, { store, sandbox });
    const campaign = store.get(derived.campaignId);
    const ownerUser = campaign.target.state.auth?.users.find((u) => u.uid === "u-owner");
    const disabledUser = campaign.target.state.auth?.users.find((u) => u.uid === "u-disabled");

    expect(ownerUser?.emailVerified).toBe(false);
    expect(ownerUser?.tenantId).toBe("t-1");
    expect(ownerUser?.providerId).toBe("password");
    expect(disabledUser?.emailVerified).toBe(false);
    expect(disabledUser?.tenantId).toBe("t-2");
    expect(disabledUser?.disabled).toBe(true);

    const probeSandbox = initializeSandbox();
    const ownerActor = acquireActor(probeSandbox, campaign.target, {
      id: "owner",
      acquisition: { kind: "fixture-user", uid: "u-owner" },
    });
    expect(ownerActor.evidence.reachability).toBe("reachable");
    expect(ownerActor.auth?.token.email_verified).toBe(false);
    expect(
      (ownerActor.auth?.token.firebase as { tenant?: string } | undefined)?.tenant,
    ).toBe("t-1");

    const disabledActor = acquireActor(initializeSandbox(), campaign.target, {
      id: "disabled",
      acquisition: { kind: "fixture-user", uid: "u-disabled" },
    });
    expect(disabledActor.evidence.reachability).toBe("unreachable");
    expect(disabledActor.auth).toBeNull();
  });

  test("honors active in-process sandbox rules and preserves stored external-URL campaigns across MCP re-derivation", async () => {
    const projectDir = makeTempDir("derive-mcp-parity-");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(
      join(projectDir, "src/app.ts"),
      `import { getFirestore, collection, getDocs } from 'firebase/firestore';
export async function listItems() {
  return getDocs(collection(getFirestore(), 'items'));
}
`,
    );
    const rulesSource = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get, list: if resource.data.ownerId == request.auth.uid;
    }
  }
}
`;

    const server = createServer((req, res) => {
      if (req.url === "/__pyric/init.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionToken: "tok-1",
            instanceId: "inst-1",
            rules: rulesSource,
          }),
        );
        return;
      }
      if (req.url === "/__pyric/state") {
        res.writeHead(404).end("null");
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const emptySandbox = initializeSandbox();
      const ctx = createSurfaceContext(emptySandbox, projectDir);

      const first = await callAssuranceOperation(ctx, "firebase_assurance_derive", {
        url: origin,
        campaignId: "c-ext",
      });
      expect(first.ok).toBe(true);
      const second = await callAssuranceOperation(ctx, "firebase_assurance_derive", {
        campaignId: "c-ext",
      });
      expect(second.ok).toBe(true);
      const secondDiags = (second.data as { diagnostics: Array<{ code: string }> }).diagnostics;
      expect(secondDiags.map((d) => d.code)).toContain("firestore-unprovable-list-query");

      const activeSandbox = initializeSandbox();
      setRules(activeSandbox, rulesSource);
      const activeCtx = createSurfaceContext(activeSandbox, projectDir);
      const inProcDerived = await callAssuranceOperation(
        activeCtx,
        "firebase_assurance_derive",
        {},
      );
      expect(inProcDerived.ok).toBe(true);
      const inProcDiags = (
        inProcDerived.data as { diagnostics: Array<{ code: string }> }
      ).diagnostics;
      expect(inProcDiags.map((d) => d.code)).toContain("firestore-unprovable-list-query");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("contains firebase.json rule paths inside project root and resolves .firebaserc targets", async () => {
    const projectDir = makeTempDir("derive-containment-proj-");
    const outsideDir = makeTempDir("derive-containment-out-");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(
      join(projectDir, "local.rules.json"),
      JSON.stringify({ rules: { items: { ".read": "auth != null" } } }),
    );
    writeFileSync(
      join(outsideDir, "outside.rules.json"),
      JSON.stringify({ rules: { items: { ".read": "auth != null" } } }),
    );
    symlinkSync(outsideDir, join(projectDir, "linked-dir"));

    writeFileSync(
      join(projectDir, ".firebaserc"),
      JSON.stringify({
        projects: { default: "proj-1" },
        targets: {
          "proj-1": {
            database: { secondaryRtdb: ["inst-local"] },
          },
        },
      }),
    );
    writeFileSync(
      join(projectDir, "firebase.json"),
      JSON.stringify({
        database: [
          { target: "secondaryRtdb", rules: "local.rules.json" },
          {
            instance: "inst-rel",
            rules: relative(projectDir, join(outsideDir, "outside.rules.json")),
          },
          { instance: "inst-sym", rules: "linked-dir/outside.rules.json" },
        ],
      }),
    );
    writeFileSync(
      join(projectDir, "src/app.ts"),
      `import { getDatabase, ref, query, orderByChild, equalTo, get } from 'pyric/database';
declare const app: unknown;
export async function runSecondary() {
  const db = getDatabase(app, 'https://inst-local.firebaseio.com');
  return get(query(ref(db, 'items'), orderByChild('rank'), equalTo(1)));
}
`,
    );

    const store = new AssuranceCampaignStore();
    const derived = await deriveAssurance(
      { root: projectDir },
      { store, projectDir },
    );
    const campaign = store.get(derived.campaignId);
    expect(campaign.target.schema).toBe(ASSURANCE_TARGET_SCHEMA);
    expect(campaign.target.rules.rtdbInstances?.["inst-local"]).toBeDefined();
    expect(campaign.target.rules.rtdbInstances?.["inst-rel"]).toBeUndefined();
    expect(campaign.target.rules.rtdbInstances?.["inst-sym"]).toBeUndefined();
    expect(
      derived.diagnostics.some(
        (d) => d.code === "rtdb-missing-index-on" && d.resourceId === "inst-local",
      ),
    ).toBe(true);
  });
});
