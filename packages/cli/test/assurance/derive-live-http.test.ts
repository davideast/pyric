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
    const validSha = "a".repeat(64);
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
        return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
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
});
