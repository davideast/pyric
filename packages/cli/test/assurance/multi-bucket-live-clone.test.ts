import "fake-indexeddb/auto";
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeApp as initializeAdminApp } from "pyric-admin/app";
import { getStorage as getAdminStorage } from "pyric-admin/storage";
import { initializeSandbox } from "pyric/sandbox";
import {
  createOwnedSandboxAttachmentProvider,
  createSandboxAttachmentProvider,
} from "../../src/assurance/attachment.js";
import { cloneLoopbackSandboxHttp } from "../../src/assurance/derive-live-http.js";
import { deriveAssurance } from "../../src/assurance/derive.js";
import { AssuranceCampaignStore } from "../../src/assurance/tools.js";
import { runAssuranceDerive } from "../../src/cli/assurance.js";
import { parseArgs } from "../../src/cli/parse-args.js";

const WILDCARD_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
    }
  }
}`;

function asFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

function makeInlineStorageObject(bucket: string, fullPath: string, base64: string) {
  const byteLen = Buffer.from(base64, "base64").byteLength;
  return {
    dataBase64: base64,
    blobType: "text/plain",
    metadata: {
      bucket,
      fullPath,
      name: fullPath.split("/").pop() ?? "item.txt",
      size: byteLen,
      generation: "1",
      metageneration: "1",
      contentType: "text/plain",
      timeCreated: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("multi-bucket live Storage state cloning and coverage gaps", () => {
  it("preserves secondary .appspot.com and .firebasestorage.app buckets under target.state.storageBuckets during loopback deriveAssurance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyric-multi-bucket-derive-"));
    try {
      writeFileSync(
        join(dir, ".firebaserc"),
        JSON.stringify({ projects: { default: "demo-proj" } }),
      );
      writeFileSync(join(dir, "firebase.json"), JSON.stringify({}));
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src/app.ts"),
        [
          "import { getStorage, ref, getBytes } from 'firebase/storage';",
          "export async function readItem() {",
          "  return getBytes(ref(getStorage(), 'docs/item.txt'));",
          "}",
        ].join("\n"),
      );

      const mockFetch = asFetch(async (input) => {
        const u = new URL(String(input));
        if (u.pathname === "/__pyric/init.json") {
          return new Response(
            JSON.stringify({ storageRules: WILDCARD_STORAGE_RULES }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.pathname === "/__pyric/state") {
          return new Response(
            JSON.stringify({
              version: 1,
              firestore: null,
              auth: null,
              storage: [
                makeInlineStorageObject(
                  "demo-proj.firebasestorage.app",
                  "docs/item.txt",
                  "ZGVmYXVsdA==",
                ),
                makeInlineStorageObject(
                  "secondary-archive.appspot.com",
                  "docs/item.txt",
                  "c2Vjb25kYXJ5",
                ),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      });

      const store = new AssuranceCampaignStore();
      const derived = await deriveAssurance(
        { root: dir, url: "http://127.0.0.1:4400" },
        { store, fetchImpl: mockFetch, projectDir: dir },
      );

      const exportedBundle = store.get(derived.campaignId).export();
      const exported = exportedBundle.campaign;
      expect(exported.target.state.storage).toHaveLength(1);
      expect(exported.target.state.storage?.[0]?.dataBase64).toBe("ZGVmYXVsdA==");
      expect(
        exported.target.state.storageBuckets?.["secondary-archive.appspot.com"],
      ).toHaveLength(1);
      expect(
        exported.target.state.storageBuckets?.["secondary-archive.appspot.com"]?.[0]
          ?.dataBase64,
      ).toBe("c2Vjb25kYXJ5");
      expect(exportedBundle.context?.coverageGaps ?? []).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps multiple unconfigured Firebase buckets distinct while mapping a sole unconfigured Firebase bucket to (default)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyric-multi-bucket-noproj-"));
    try {
      const multiFetch = asFetch(async (input) => {
        const u = new URL(String(input));
        if (u.pathname === "/__pyric/init.json") {
          return new Response(
            JSON.stringify({ storageRules: WILDCARD_STORAGE_RULES }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.pathname === "/__pyric/state") {
          return new Response(
            JSON.stringify({
              version: 1,
              firestore: null,
              auth: null,
              storage: [
                makeInlineStorageObject(
                  "alpha-store.firebasestorage.app",
                  "docs/item.txt",
                  "YWxwaGE=",
                ),
                makeInlineStorageObject(
                  "beta-archive.appspot.com",
                  "docs/item.txt",
                  "YmV0YQ==",
                ),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      });

      const multiCloned = await cloneLoopbackSandboxHttp("http://127.0.0.1:4401", {
        fetchImpl: multiFetch,
        projectDir: dir,
      });
      expect(
        multiCloned.target.state.storageBuckets?.["alpha-store.firebasestorage.app"],
      ).toHaveLength(1);
      expect(
        multiCloned.target.state.storageBuckets?.["beta-archive.appspot.com"],
      ).toHaveLength(1);
      expect(multiCloned.target.state.storage ?? []).toHaveLength(0);

      const singleFetch = asFetch(async (input) => {
        const u = new URL(String(input));
        if (u.pathname === "/__pyric/init.json") {
          return new Response(
            JSON.stringify({ storageRules: WILDCARD_STORAGE_RULES }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.pathname === "/__pyric/state") {
          return new Response(
            JSON.stringify({
              version: 1,
              firestore: null,
              auth: null,
              storage: [
                makeInlineStorageObject(
                  "sole-project.appspot.com",
                  "docs/item.txt",
                  "c29sZQ==",
                ),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      });

      const singleCloned = await cloneLoopbackSandboxHttp("http://127.0.0.1:4402", {
        fetchImpl: singleFetch,
        projectDir: dir,
      });
      expect(singleCloned.target.state.storage).toHaveLength(1);
      expect(singleCloned.target.state.storageBuckets).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits storage-rules-unavailable when a named Storage bucket holds objects without governing Storage rules", async () => {
    const mockBridgeFetch = asFetch(async () =>
      new Response(
        JSON.stringify({ bridgeUrl: "ws://127.0.0.1:5000/__pyric/bridge" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const sbNamed = initializeSandbox();
    const adminNamed = initializeAdminApp({ sandbox: sbNamed }, "named-unruled-app");
    await getAdminStorage(adminNamed)
      .bucket("secondary-media")
      .file("docs/a.txt")
      .save(new Uint8Array([1, 2]), { contentType: "text/plain" });

    const attachedServed = await createSandboxAttachmentProvider(sbNamed, {
      origin: "http://127.0.0.1:5000",
      fetchImpl: mockBridgeFetch,
    })({ url: "http://127.0.0.1:5000" });
    expect(attachedServed.inventory.storageObjects).toBe(1);
    expect(
      attachedServed.coverageGaps.some((g) => g.code === "storage-rules-unavailable"),
    ).toBe(true);

    const attachedPerBucketGap = await createOwnedSandboxAttachmentProvider(
      sbNamed,
      { storageBuckets: { "governed-only": WILDCARD_STORAGE_RULES } },
      "pyric:in-process-sandbox",
    )({ url: "pyric:in-process-sandbox" });
    expect(
      attachedPerBucketGap.coverageGaps.some(
        (g) => g.code === "storage-rules-unavailable",
      ),
    ).toBe(true);

    const attachedGoverned = await createOwnedSandboxAttachmentProvider(
      sbNamed,
      { storageBuckets: { "secondary-media": WILDCARD_STORAGE_RULES } },
      "pyric:in-process-sandbox",
    )({ url: "pyric:in-process-sandbox" });
    expect(attachedGoverned.coverageGaps).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "pyric-unruled-live-derive-"));
    try {
      writeFileSync(
        join(dir, ".firebaserc"),
        JSON.stringify({ projects: { default: "demo-proj" } }),
      );
      writeFileSync(join(dir, "firebase.json"), JSON.stringify({}));
      const store = new AssuranceCampaignStore();
      const derived = await deriveAssurance(
        { root: dir },
        { store, sandbox: sbNamed, projectDir: dir },
      );
      const gaps =
        store.get(derived.campaignId).export().context?.coverageGaps ?? [];
      expect(gaps.some((g) => g.code === "storage-rules-unavailable")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps <projectId>.firebasestorage.app and <projectId>.appspot.com in init.json storageBucketRules to default rules.storage in createSandboxAttachmentProvider", async () => {
    for (const defaultBucketKey of [
      "demo-proj.firebasestorage.app",
      "demo-proj.appspot.com",
    ]) {
      const sb = initializeSandbox();
      const admin = initializeAdminApp(
        { sandbox: sb },
        `default-bucket-attach-${defaultBucketKey}`,
      );
      await getAdminStorage(admin)
        .bucket()
        .file("docs/a.txt")
        .save(new Uint8Array([1, 2, 3]), { contentType: "text/plain" });

      const attachFetch = asFetch(async () =>
        new Response(
          JSON.stringify({
            bridgeUrl: "ws://127.0.0.1:5000/__pyric/bridge",
            databaseInstances: { projectId: "demo-proj" },
            storageBucketRules: {
              [defaultBucketKey]: WILDCARD_STORAGE_RULES,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const attached = await createSandboxAttachmentProvider(sb, {
        origin: "http://127.0.0.1:5000",
        fetchImpl: attachFetch,
      })({ url: "http://127.0.0.1:5000" });

      expect(attached.inventory.storageObjects).toBe(1);
      expect(attached.target.rules.storage).toBe(WILDCARD_STORAGE_RULES);
      expect(attached.target.rules.storageBuckets).toBeUndefined();
      expect(attached.coverageGaps).toEqual([]);
    }
  });

  it("preserves secondary buckets and surfaces unruled bucket coverage gaps side-by-side across assurance derive CLI and deriveAssurance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyric-parity-live-buckets-"));
    try {
      writeFileSync(
        join(dir, ".firebaserc"),
        JSON.stringify({ projects: { default: "demo-proj" } }),
      );
      writeFileSync(join(dir, "firebase.json"), JSON.stringify({}));

      const mockFetch = asFetch(async (input) => {
        const u = new URL(String(input));
        if (u.pathname === "/__pyric/init.json") {
          return new Response(
            JSON.stringify({
              storageBucketRules: {
                "demo-proj.firebasestorage.app":
                  "rules_version = '2'; service firebase.storage { match /b/demo-proj.firebasestorage.app/o { match /{p=**} { allow read: if true; } } }",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.pathname === "/__pyric/state") {
          return new Response(
            JSON.stringify({
              version: 1,
              firestore: null,
              auth: null,
              storage: [
                makeInlineStorageObject(
                  "demo-proj.firebasestorage.app",
                  "docs/item.txt",
                  "ZGVmYXVsdA==",
                ),
                makeInlineStorageObject(
                  "secondary-archive.appspot.com",
                  "docs/item.txt",
                  "c2Vjb25kYXJ5",
                ),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      });

      const cliStore = new AssuranceCampaignStore();
      let cliOut = "";
      let cliErr = "";
      const cliCode = await runAssuranceDerive(
        parseArgs([
          "assurance",
          "derive",
          "--root",
          dir,
          "--url",
          "http://127.0.0.1:4410",
          "--campaign-id",
          "cli-multi-bucket",
          "--json",
        ]),
        {
          cwd: dir,
          stdout: { write: (s) => { cliOut += s; } },
          stderr: { write: (s) => { cliErr += s; } },
          store: cliStore,
          fetchImpl: mockFetch,
        },
      );
      expect(cliCode).toBe(0);
      expect(cliErr).toBe("");
      expect(cliOut.length).toBeGreaterThan(0);

      const progStore = new AssuranceCampaignStore();
      await deriveAssurance(
        { root: dir, url: "http://127.0.0.1:4410", campaignId: "prog-multi-bucket" },
        { store: progStore, fetchImpl: mockFetch, projectDir: dir },
      );

      for (const exported of [
        cliStore.get("cli-multi-bucket").export(),
        progStore.get("prog-multi-bucket").export(),
      ]) {
        expect(exported.campaign.target.state.storage).toHaveLength(1);
        expect(
          exported.campaign.target.state.storageBuckets?.[
            "secondary-archive.appspot.com"
          ],
        ).toHaveLength(1);
        expect(
          (exported.context?.coverageGaps ?? []).some(
            (g) => g.code === "storage-rules-unavailable",
          ),
        ).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
