import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Bytes, Timestamp } from "pyric/firestore";
import { bundleRecords, serializeToBuckets } from "pyric/sandbox";
import {
  cloneLoopbackSandboxHttp,
  isLoopbackHost,
  parseLoopbackOrigin,
} from "../../src/assurance/derive-live-http.js";
import { AssuranceInputError } from "../../src/assurance/types.js";
import { HOSTED_METHOD_PATH } from "../../src/serve/hosted/method-protocol.js";

describe("derive-live-http", () => {
  test("accepts loopback hosts and rejects external or credentialed URLs", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);

    expect(() => parseLoopbackOrigin("https://example.com")).toThrow(
      AssuranceInputError,
    );
    expect(() => parseLoopbackOrigin("http://user:pw@127.0.0.1:3473")).toThrow(
      AssuranceInputError,
    );
  });

  test("decodes real pyric-v3-records state bundles, Storage object hashes, and hosted sandbox.events", async () => {
    const projectDir = join(tmpdir(), "proj");
    const records = serializeToBuckets(
      {
        "orgs/acme": {
          name: "Acme",
          createdAt: Timestamp.fromMillis(1_700_000_000_000),
          sig: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])),
        },
        "/databases/analytics/documents/metrics/m1": {
          total: 42,
        },
      },
      {
        rtdb: {
          ".pyricRtdbPersistence": 1,
          data: { rooms: { r1: { host: "u-alice" } } },
          priorities: { "rooms/r1": 10 },
          instances: {
            "shard-a": {
              ".pyricRtdbPersistence": 1,
              data: { queues: { q1: "active" } },
              priorities: {},
              rules: { rules: { queues: { ".read": true } } },
            },
          },
        },
        auth: {
          users: [
            {
              uid: "u-alice",
              email: "alice@example.test",
              displayName: "Alice",
              emailVerified: true,
              customClaims: { role: "owner" },
            },
          ],
          providers: {},
        },
      },
      1_700_000_000_000,
    );
    const v3FirestoreSection = JSON.parse(bundleRecords(records)) as unknown;
    const objectBytes = new Uint8Array([9, 8, 7]);
    const validSha = createHash("sha256").update(objectBytes).digest("hex");
    const calls: string[] = [];
    let postedMethodBody: Record<string, unknown> | undefined;

    const mockFetch: typeof fetch = (async (
      rawUrl: string | URL | Request,
      init?: RequestInit,
    ) => {
      const urlStr = String(rawUrl);
      calls.push(urlStr);
      expect(init?.redirect).toBe("error");
      if (urlStr.endsWith("/__pyric/init.json")) {
        return new Response(
          JSON.stringify({
            rules: "rules_version = '2'; service cloud.firestore {}",
            sessionToken: "tok-1",
            instanceId: "inst-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/__pyric/state")) {
        return new Response(
          JSON.stringify({
            version: 1,
            firestore: v3FirestoreSection,
            auth: null,
            storage: [
              {
                path: "uploads/u-alice/avatar.png",
                sha256: validSha,
                size: 3,
                blobType: "image/png",
                metadata: {
                  bucket: "pyric-sandbox.appspot.com",
                  fullPath: "uploads/u-alice/avatar.png",
                  name: "avatar.png",
                  size: 3,
                  generation: "1",
                  metageneration: "1",
                  timeCreated: "2026-01-01T00:00:00.000Z",
                  updated: "2026-01-01T00:00:00.000Z",
                  md5Hash: "ICy5YqxZB1uWSwcVLSNLcA==",
                  contentType: "image/png",
                  customMetadata: { ownerUid: "u-alice" },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith(`/__pyric/state/objects/${validSha}`)) {
        return new Response(objectBytes, { status: 200 });
      }
      if (urlStr.endsWith(HOSTED_METHOD_PATH)) {
        postedMethodBody = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            ok: true,
            summary: "events",
            data: {
              events: [
                {
                  kind: "request",
                  service: "firestore",
                  path: "orgs/acme",
                  op: "get",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const cloned = await cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
      fetchImpl: mockFetch,
      projectDir,
    });

    expect(cloned.origin).toBe("http://127.0.0.1:3473");
    expect(cloned.studioUrl).toBe("http://127.0.0.1:3473/__pyric/ui/assurance");
    expect(cloned.snapshot.firestore["(default)"]?.["orgs/acme"]?.name).toBe(
      "Acme",
    );
    expect(
      cloned.snapshot.firestore["(default)"]?.["orgs/acme"]?.createdAt,
    ).toEqual({
      type: "firestore/timestamp/1.0",
      seconds: 1_700_000_000,
      nanoseconds: 0,
    });
    expect(cloned.snapshot.firestore.analytics?.["metrics/m1"]).toEqual({
      total: 42,
    });
    expect(cloned.snapshot.rtdb["(default)"]).toEqual({
      rooms: {
        r1: {
          ".priority": 10,
          host: "u-alice",
        },
      },
    });
    expect(cloned.snapshot.rtdb["shard-a"]).toEqual({
      queues: { q1: "active" },
    });
    expect(cloned.target.rules.rtdbInstances?.["shard-a"]).toEqual({
      rules: { queues: { ".read": true } },
    });
    expect(cloned.snapshot.auth.users).toEqual([
      {
        uid: "u-alice",
        email: "alice@example.test",
        displayName: "Alice",
        emailVerified: true,
        customClaims: { role: "owner" },
      },
    ]);
    expect(cloned.snapshot.storage["(default)"]?.[0]?.size).toBe(3);
    expect(cloned.history).toHaveLength(1);
    expect(postedMethodBody?.projectDir).toBe(projectDir);
    expect(calls.length).toBe(4);
  });

  test("fails fast with AssuranceInputError when /__pyric/init.json returns non-200", async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    await expect(
      cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(AssuranceInputError);
  });

  test("rejects invalid Storage sha256 digests before constructing object URLs", async () => {
    const seenUrls: string[] = [];
    const mockFetch: typeof fetch = (async (rawUrl: string | URL | Request) => {
      const urlStr = String(rawUrl);
      seenUrls.push(urlStr);
      if (urlStr.endsWith("/__pyric/init.json")) {
        return new Response(
          JSON.stringify({ sessionToken: "tok-1", instanceId: "inst-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          version: 1,
          firestore: null,
          auth: null,
          storage: [
            {
              path: "uploads/bad.bin",
              sha256: "../../etc/passwd",
              size: 3,
              blobType: "application/octet-stream",
              metadata: {
                bucket: "pyric-sandbox.appspot.com",
                fullPath: "uploads/bad.bin",
                name: "bad.bin",
                size: 3,
                generation: "1",
                metageneration: "1",
                timeCreated: "2026-01-01T00:00:00.000Z",
                updated: "2026-01-01T00:00:00.000Z",
                md5Hash: "ICy5YqxZB1uWSwcVLSNLcA==",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(AssuranceInputError);
    expect(seenUrls.some((u) => u.includes("passwd"))).toBe(false);
  });

  test("preserves persisted default RTDB rules, auth.providers, and <projectId>.firebasestorage.app default bucket fixtures", async () => {
    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/__pyric/init.json")) {
        return new Response(
          JSON.stringify({
            sessionToken: "tok-1",
            instanceId: "inst-1",
            storageRules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /docs/{id} { allow read: if true; } } }",
            storageBucketRules: {
              "demo-proj.firebasestorage.app": {
                rules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /docs/{id} { allow read: if true; } } }",
              },
              "secondary-bucket": {
                rules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /docs/{id} { allow read: if false; } } }",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/__pyric/state")) {
        return new Response(
          JSON.stringify({
            version: 1,
            firestore: {
              firestore: {},
              services: {
                rtdb: {
                  ".pyricRtdbPersistence": 1,
                  data: { items: { i1: { rank: 1 } } },
                  priorities: {},
                  rules: { items: { ".read": "auth != null" } },
                  instances: {
                    "inst-sec": {
                      ".pyricRtdbPersistence": 1,
                      data: { items: { i2: { rank: 2 } } },
                      priorities: {},
                      rules: { items: { ".read": "auth != null" } },
                    },
                  },
                },
                auth: {
                  users: [{ uid: "u-1", email: "u1@example.test" }],
                  providers: { anonymous: false },
                },
              },
            },
            auth: {
              users: [{ uid: "u-1", email: "u1@example.test" }],
              providers: { anonymous: false },
            },
            storage: [
              {
                path: "docs/doc-1",
                dataBase64: Buffer.alloc(32, 7).toString("base64"),
                size: 32,
                blobType: "application/octet-stream",
                metadata: {
                  bucket: "demo-proj.firebasestorage.app",
                  fullPath: "docs/doc-1",
                  name: "doc-1",
                  size: 32,
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
      if (url.endsWith(HOSTED_METHOD_PATH)) {
        return new Response(JSON.stringify({ ok: true, data: { events: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const cloned = await cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
      fetchImpl: mockFetch,
      configuredBuckets: ["demo-proj.firebasestorage.app", "secondary-bucket"],
      defaultBucket: "demo-proj.firebasestorage.app",
    });

    expect(cloned.target.rules.rtdb).toEqual({
      rules: { items: { ".read": "auth != null" } },
    });
    expect(cloned.snapshot.rules.rtdb?.["(default)"]).toBeDefined();
    expect(cloned.target.state.auth?.providers?.anonymous).toBe(false);
    expect(cloned.snapshot.auth.providers?.anonymous).toBe(false);
    expect(cloned.target.state.storage?.some((o) => o.path === "docs/doc-1")).toBe(true);
    expect(cloned.target.rules.storageBuckets?.["demo-proj.firebasestorage.app"]).toBeUndefined();
  });

  test("preserves Storage HTTP metadata and Auth providerUserInfo across both snapshot and target on loopback HTTP clone", async () => {
    const records = serializeToBuckets(
      {},
      {
        auth: {
          users: [
            {
              uid: "u-alice",
              email: "alice@example.test",
              emailVerified: true,
              providerUserInfo: [
                {
                  providerId: "google.com",
                  rawId: "goog-sub-99",
                  uid: "goog-sub-99",
                  email: "alice@example.test",
                  displayName: "Alice",
                },
              ],
            },
          ],
          providers: { "google.com": true, password: false },
        },
      },
      1_700_000_000_000,
    );
    const v3FirestoreSection = JSON.parse(bundleRecords(records)) as unknown;
    const mockFetch: typeof fetch = (async (rawUrl: string | URL | Request) => {
      const url = String(rawUrl);
      if (url.endsWith("/__pyric/init.json")) {
        return new Response(
          JSON.stringify({ sessionToken: "tok-rich", instanceId: "inst-rich" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/__pyric/state")) {
        return new Response(
          JSON.stringify({
            version: 1,
            firestore: v3FirestoreSection,
            auth: null,
            storage: [
              {
                dataBase64: "AQID",
                blobType: "image/svg+xml",
                metadata: {
                  bucket: "demo-proj.firebasestorage.app",
                  fullPath: "assets/logo.svg",
                  name: "logo.svg",
                  size: 3,
                  generation: "7",
                  metageneration: "2",
                  timeCreated: "2026-01-01T00:00:00.000Z",
                  updated: "2026-01-03T00:00:00.000Z",
                  md5Hash: "ICy5YqxZB1uWSwcVLSNLcA==",
                  contentType: "image/svg+xml",
                  cacheControl: "public, max-age=86400",
                  contentDisposition: "inline",
                  contentEncoding: "br",
                  contentLanguage: "en",
                  downloadTokens: "tok-dl-1",
                  customMetadata: { ownerId: "u-alice" },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith(HOSTED_METHOD_PATH)) {
        return new Response(JSON.stringify({ ok: true, data: { events: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const cloned = await cloneLoopbackSandboxHttp("http://127.0.0.1:3473", {
      fetchImpl: mockFetch,
      defaultBucket: "demo-proj.firebasestorage.app",
    });

    expect(cloned.snapshot.storage["(default)"]?.[0]).toMatchObject({
      path: "assets/logo.svg",
      size: 3,
      contentType: "image/svg+xml",
      cacheControl: "public, max-age=86400",
      contentDisposition: "inline",
      contentEncoding: "br",
      contentLanguage: "en",
      timeCreated: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-03T00:00:00.000Z",
      generation: "7",
      metageneration: "2",
      md5Hash: "ICy5YqxZB1uWSwcVLSNLcA==",
      downloadTokens: "tok-dl-1",
      customMetadata: { ownerId: "u-alice" },
    });
    expect(cloned.target.state.storage?.[0]).toMatchObject({
      path: "assets/logo.svg",
      contentType: "image/svg+xml",
      cacheControl: "public, max-age=86400",
      contentDisposition: "inline",
      contentEncoding: "br",
      contentLanguage: "en",
      timeCreated: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-03T00:00:00.000Z",
      customMetadata: { ownerId: "u-alice" },
    });
    expect(cloned.snapshot.auth.users[0]?.providerUserInfo).toEqual([
      {
        providerId: "google.com",
        rawId: "goog-sub-99",
        uid: "goog-sub-99",
        email: "alice@example.test",
        displayName: "Alice",
      },
    ]);
    expect(cloned.target.state.auth?.users?.[0]?.providerUserInfo).toEqual([
      {
        providerId: "google.com",
        rawId: "goog-sub-99",
        uid: "goog-sub-99",
        email: "alice@example.test",
        displayName: "Alice",
      },
    ]);
  });

  test("resolves session token from process.cwd() when options.projectDir is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyric-derive-cwd-"));
    const prevCwd = process.cwd();
    try {
      mkdirSync(join(dir, ".pyric"), { recursive: true });
      writeFileSync(join(dir, "firebase.json"), "{}");
      writeFileSync(
        join(dir, ".pyric", "serve.json"),
        JSON.stringify({
          pid: process.pid,
          port: 43199,
          url: "http://127.0.0.1:43199",
          token: "tok-from-cwd",
        }),
      );

      const seenTokens: Array<string | undefined> = [];
      const mockFetch: typeof fetch = (async (
        rawUrl: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = String(rawUrl);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const tok = headers["x-pyric-session-token"];
        seenTokens.push(tok);
        if (tok !== "tok-from-cwd") {
          return new Response("unauthorized", { status: 401 });
        }
        if (url.endsWith("/__pyric/init.json")) {
          return new Response(
            JSON.stringify({
              rules: "rules_version = '2'; service cloud.firestore {}",
              instanceId: "inst-cwd",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/__pyric/state")) {
          return new Response(
            JSON.stringify({
              version: 1,
              firestore: null,
              auth: { users: [{ uid: "u-cwd" }], providers: {} },
              storage: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      process.chdir(dir);
      const cloned = await cloneLoopbackSandboxHttp("http://127.0.0.1:43199", {
        fetchImpl: mockFetch,
      });

      expect(cloned.snapshot.auth.users.map((u) => u.uid)).toEqual(["u-cwd"]);
      expect(seenTokens).toEqual(["tok-from-cwd", "tok-from-cwd"]);
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pins self-signed HTTPS loopback certificates from .pyric/serve.json under Node and rejects unpinned impostors", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyric-derive-https-"));
    try {
      for (const name of ["own", "impostor"]) {
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-keyout",
            join(dir, `${name}.key`),
            "-out",
            join(dir, `${name}.pem`),
          ],
          { stdio: "ignore" },
        );
      }
      const run = spawnSync(
        process.env.PYRIC_TEST_NODE ?? "node",
        [join(import.meta.dir, "fixtures", "derive-live-https-node.mjs"), dir],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(run.status, run.stderr).toBe(0);
      const parsed = JSON.parse(run.stdout.trim()) as {
        ownClone: { ok: boolean; value?: { origin: string; users: string[] }; message?: string };
        impostorClone: { ok: boolean; message?: string };
      };
      expect(parsed.ownClone).toEqual({
        ok: true,
        value: {
          origin: expect.stringMatching(/^https:\/\/127\.0\.0\.1:\d+$/),
          users: ["u-https"],
        },
      });
      expect(parsed.impostorClone.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
