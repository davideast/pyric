import "fake-indexeddb/auto";
import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deriveAssurance } from "../../src/assurance/derive.js";
import { AssuranceCampaignStore } from "../../src/assurance/tools.js";
import { runAssuranceDerive } from "../../src/cli/assurance.js";
import { parseArgs } from "../../src/cli/parse-args.js";
import { runVerify } from "../../src/cli/verify.js";
import { runVerifyStatic } from "../../src/cli/verify-static.js";
import { resolveStorageCandidateRules } from "../../src/cli/verify-storage-rules.js";

function asFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

function bufferIo(cwd?: string) {
  let out = "";
  let err = "";
  const env: {
    cwd?: string;
    stdout: { write(chunk: string): void };
    stderr: { write(chunk: string): void };
    getOut: () => string;
    getErr: () => string;
  } = {
    stdout: {
      write(chunk: string): void {
        out += chunk;
      },
    },
    stderr: {
      write(chunk: string): void {
        err += chunk;
      },
    },
    getOut: () => out,
    getErr: () => err,
  };
  if (cwd !== undefined) {
    env.cwd = cwd;
  }
  return env;
}

describe("assurance entrypoint parity, fail-closed, and containment matrix", () => {
  it("fails closed across verify --static, --rules overrides, assurance derive, and deriveAssurance on syntax-broken or unknown-directive RTDB rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyric-parity-broken-rtdb-"));
    try {
      const brokenRtdbRules = {
        rules: {
          items: {
            $uid: {
              ".read": "auth != null && auth.uid ===",
              ".write": "auth.uid === $uid && (",
              ".unknownDirective": true,
            },
          },
        },
      };
      writeFileSync(
        join(dir, "firebase.json"),
        JSON.stringify({
          database: [
            { rules: "database.rules.json" },
            { instance: "shard-a", rules: "shard-a.rules.json" },
          ],
        }),
      );
      writeFileSync(
        join(dir, "database.rules.json"),
        JSON.stringify(brokenRtdbRules, null, 2),
      );
      writeFileSync(
        join(dir, "shard-a.rules.json"),
        JSON.stringify(brokenRtdbRules, null, 2),
      );
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src/app.ts"),
        [
          "import { getAuth } from 'firebase/auth';",
          "import { getDatabase, ref, set } from 'firebase/database';",
          "export async function saveItem() {",
          "  const uid = getAuth().currentUser!.uid;",
          "  await set(ref(getDatabase(), 'items/' + uid), { ok: true });",
          "}",
        ].join("\n"),
      );

      const staticIo = bufferIo(dir);
      const staticCode = await runVerifyStatic(
        parseArgs(["verify", "--static", "--root", dir, "--json"]),
        staticIo,
      );
      expect(staticCode).toBe(1);
      const staticJson = JSON.parse(staticIo.getOut()) as {
        ok: boolean;
        diagnostics: Array<{ code: string; resourceId: string }>;
      };
      expect(staticJson.ok).toBe(false);
      expect(
        staticJson.diagnostics.some(
          (d) =>
            d.code === "invalid-rules-configuration" &&
            d.resourceId === "(default)",
        ),
      ).toBe(true);
      expect(
        staticJson.diagnostics.some(
          (d) =>
            d.code === "invalid-rules-configuration" &&
            d.resourceId === "shard-a",
        ),
      ).toBe(true);

      const overrideIo = bufferIo(dir);
      const overrideCode = await runVerifyStatic(
        parseArgs([
          "verify",
          "--static",
          "--root",
          dir,
          "--rules",
          "rtdb=database.rules.json",
          "--json",
        ]),
        overrideIo,
      );
      expect(overrideCode).toBe(2);
      expect(overrideIo.getErr()).toContain("invalid RTDB rules");

      const deriveCliIo = bufferIo(dir);
      const deriveCliCode = await runAssuranceDerive(
        parseArgs(["assurance", "derive", "--root", dir, "--json"]),
        deriveCliIo,
      );
      expect(deriveCliCode).toBe(1);
      const deriveCliJson = JSON.parse(deriveCliIo.getOut()) as {
        ok: boolean;
        diagnostics: Array<{ code: string }>;
      };
      expect(deriveCliJson.ok).toBe(false);
      expect(
        deriveCliJson.diagnostics.some(
          (d) => d.code === "invalid-rules-configuration",
        ),
      ).toBe(true);

      const derived = await deriveAssurance(
        { root: dir },
        { store: new AssuranceCampaignStore() },
      );
      expect(
        derived.diagnostics.some((d) => d.code === "invalid-rules-configuration"),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evicts concrete default Storage bucket rules under --rules storage=... and --rules storage:<defaultBucket>=... across verify --static and verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyric-parity-default-bucket-"));
    try {
      const permissiveStorage = [
        "rules_version = '2';",
        "service firebase.storage {",
        "  match /b/{bucket}/o {",
        "    match /{allPaths=**} { allow read, write: if true; }",
        "  }",
        "}",
      ].join("\n");
      const strictStorage = [
        "rules_version = '2';",
        "service firebase.storage {",
        "  match /b/{bucket}/o {",
        "    match /{allPaths=**} { allow read, write: if false; }",
        "  }",
        "}",
      ].join("\n");

      writeFileSync(
        join(dir, ".firebaserc"),
        JSON.stringify({ projects: { default: "demo-proj" } }),
      );
      writeFileSync(
        join(dir, "firebase.json"),
        JSON.stringify({
          storage: [
            { bucket: "demo-proj.firebasestorage.app", rules: "permissive.rules" },
          ],
        }),
      );
      writeFileSync(join(dir, "permissive.rules"), permissiveStorage);
      writeFileSync(join(dir, "strict.rules"), strictStorage);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src/app.ts"),
        [
          "import { getStorage, ref, uploadBytes } from 'firebase/storage';",
          "export async function uploadItem() {",
          "  await uploadBytes(ref(getStorage(), 'items/i1.png'), new Uint8Array([1]), { contentType: 'image/png' });",
          "}",
        ].join("\n"),
      );

      const defaultOverrideIo = bufferIo(dir);
      const defaultOverrideCode = await runVerifyStatic(
        parseArgs(["verify", "--static", "--rules", "storage=strict.rules", "--json"]),
        defaultOverrideIo,
      );
      expect(defaultOverrideCode).toBe(1);

      const candidate = await resolveStorageCandidateRules({
        cwd: dir,
        fixtures: [
          {
            schema: "pyric.verify.fixture.v1",
            events: [
              {
                kind: "operation",
                id: "op-1",
                at: 1000,
                service: "storage",
                method: "upload",
                path: "items/i1.png",
                auth: { uid: "alice" },
                result: "allow",
                origin: "user",
                detail: { bucket: "pyric-default.appspot.com" },
              },
            ],
            services: {},
          },
        ],
        overrides: { default: "strict.rules", buckets: [] },
        readFirebaseJson: async () => ({
          storage: [
            { bucket: "demo-proj.firebasestorage.app", rules: "permissive.rules" },
          ],
        }),
      });
      expect(candidate.rules.storage).toContain("allow read, write: if false;");
      expect(candidate.rules.storageBuckets).toBeUndefined();

      writeFileSync(
        join(dir, "firebase.json"),
        JSON.stringify({ storage: { rules: "permissive.rules" } }),
      );
      const reverseOverrideIo = bufferIo(dir);
      const reverseOverrideCode = await runVerifyStatic(
        parseArgs([
          "verify",
          "--static",
          "--rules",
          "storage:demo-proj.firebasestorage.app=strict.rules",
          "--json",
        ]),
        reverseOverrideIo,
      );
      expect(reverseOverrideCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on unmapped .firebaserc targets across verify --static, assurance derive, and deriveAssurance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyric-parity-unmapped-target-"));
    try {
      const strictFirestore = [
        "rules_version = '2';",
        "service cloud.firestore {",
        "  match /databases/{database}/documents {",
        "    match /{doc=**} { allow read, write: if false; }",
        "  }",
        "}",
      ].join("\n");
      writeFileSync(
        join(dir, ".firebaserc"),
        JSON.stringify({
          projects: { default: "demo-proj" },
          targets: { "demo-proj": {} },
        }),
      );
      writeFileSync(
        join(dir, "firebase.json"),
        JSON.stringify({
          firestore: [{ target: "unmapped-db", rules: "firestore.rules" }],
        }),
      );
      writeFileSync(join(dir, "firestore.rules"), strictFirestore);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src/app.ts"),
        [
          "import { getFirestore, collection, getDocs } from 'firebase/firestore';",
          "export async function listItems() {",
          "  return getDocs(collection(getFirestore(), 'items'));",
          "}",
        ].join("\n"),
      );

      const staticIo = bufferIo(dir);
      const staticCode = await runVerifyStatic(
        parseArgs(["verify", "--static", "--json"]),
        staticIo,
      );
      expect(staticCode).toBe(1);
      const staticJson = JSON.parse(staticIo.getOut()) as {
        ok: boolean;
        diagnostics: Array<{ code: string }>;
      };
      expect(
        staticJson.diagnostics.some(
          (d) => d.code === "invalid-rules-configuration",
        ),
      ).toBe(true);

      const deriveCliIo = bufferIo(dir);
      const deriveCliCode = await runAssuranceDerive(
        parseArgs(["assurance", "derive", "--root", dir, "--json"]),
        deriveCliIo,
      );
      expect(deriveCliCode).toBe(1);

      const derived = await deriveAssurance(
        { root: dir },
        { store: new AssuranceCampaignStore() },
      );
      expect(
        derived.diagnostics.some((d) => d.code === "invalid-rules-configuration"),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces project-root containment on --rules symlinked ancestors, lexical escapes, and 2+modules parent traversal across verify --static, assurance derive, and deriveAssurance", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "pyric-parity-outside-"));
    const projectDir = mkdtempSync(join(tmpdir(), "pyric-parity-proj-"));
    try {
      writeFileSync(
        join(outsideDir, "helper.rules"),
        "export function canReadItem() { return true; }\n",
      );
      writeFileSync(
        join(outsideDir, "outside.rules"),
        [
          "rules_version = '2';",
          "service cloud.firestore {",
          "  match /databases/{database}/documents {",
          "    match /{doc=**} { allow read, write: if true; }",
          "  }",
          "}",
        ].join("\n"),
      );
      const escapingModularRules = [
        "rules_version = '2+modules';",
        `import { canReadItem } from '../${basename(outsideDir)}/helper.rules';`,
        "service cloud.firestore {",
        "  match /databases/{database}/documents {",
        "    match /items/{id} { allow read: if canReadItem(); }",
        "  }",
        "}",
      ].join("\n");
      const escapingStorageRules = [
        "rules_version = '2+modules';",
        `import { canReadItem } from '../${basename(outsideDir)}/helper.rules';`,
        "service firebase.storage {",
        "  match /b/{bucket}/o {",
        "    match /items/{id} { allow read: if canReadItem(); }",
        "  }",
        "}",
      ].join("\n");

      writeFileSync(
        join(projectDir, "firebase.json"),
        JSON.stringify({ firestore: { rules: "firestore.rules" } }),
      );
      writeFileSync(join(projectDir, "firestore.rules"), escapingModularRules);
      writeFileSync(join(projectDir, "storage.rules"), escapingStorageRules);
      mkdirSync(join(projectDir, "src"), { recursive: true });
      writeFileSync(
        join(projectDir, "src/app.ts"),
        [
          "import { getFirestore, doc, getDoc } from 'firebase/firestore';",
          "export async function loadItem() {",
          "  return getDoc(doc(getFirestore(), 'items', 'i1'));",
          "}",
        ].join("\n"),
      );
      mkdirSync(join(projectDir, "sub"), { recursive: true });
      writeFileSync(
        join(projectDir, "sub/inside.rules"),
        "rules_version = '2'; service cloud.firestore {}",
      );
      symlinkSync(outsideDir, join(projectDir, "linked"));
      symlinkSync(join(projectDir, "sub"), join(projectDir, "inner-linked"));

      const baseStaticIo = bufferIo(projectDir);
      expect(
        await runVerifyStatic(parseArgs(["verify", "--static", "--json"]), baseStaticIo),
      ).toBe(1);

      const baseDeriveIo = bufferIo(projectDir);
      expect(
        await runAssuranceDerive(
          parseArgs(["assurance", "derive", "--root", projectDir, "--json"]),
          baseDeriveIo,
        ),
      ).toBe(1);

      const programmaticDerived = await deriveAssurance(
        { root: projectDir },
        { store: new AssuranceCampaignStore() },
      );
      expect(
        programmaticDerived.diagnostics.some(
          (d) => d.code === "invalid-rules-configuration",
        ),
      ).toBe(true);

      for (const badRulesSpec of [
        "firestore=firestore.rules",
        "storage=storage.rules",
        "firestore=linked/outside.rules",
        "firestore=linked/missing.rules",
        "firestore=inner-linked/inside.rules",
        `firestore=../${basename(outsideDir)}/outside.rules`,
        `firestore=${join(outsideDir, "outside.rules")}`,
      ]) {
        const io = bufferIo(projectDir);
        const code = await runVerifyStatic(
          parseArgs(["verify", "--static", "--rules", badRulesSpec, "--json"]),
          io,
        );
        expect(code).toBe(2);
        expect(io.getErr().length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown CLI flags with exit 2 across verify --static, assurance derive, and verify subcommands", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "pyric-parity-flags-"));
    try {
      for (const argv of [
        ["verify", "--static", "--project", "demo-proj", "--json"],
        ["verify", "--static", "--unknown-flag", "--json"],
        ["verify", "--static", "-x"],
      ]) {
        const io = bufferIo(emptyDir);
        const code = await runVerifyStatic(parseArgs(argv), io);
        expect(code).toBe(2);
        expect(io.getErr()).toContain("unknown option");
      }

      for (const argv of [
        ["assurance", "derive", "--project", "demo-proj", "--json"],
        ["assurance", "derive", "--rules", "firestore=firestore.rules", "--json"],
        ["assurance", "derive", "--statc"],
      ]) {
        const io = bufferIo(emptyDir);
        const code = await runAssuranceDerive(parseArgs(argv), io);
        expect(code).toBe(2);
        expect(io.getErr()).toContain("unknown option");
      }

      const prevCwd = process.cwd();
      const errChunks: string[] = [];
      const errSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        errChunks.push(String(chunk));
        return true;
      });
      process.chdir(emptyDir);
      try {
        for (const argv of [
          ["verify", "--statc"],
          ["verify", "cases", "--unknown"],
          ["verify", "staging", "init", "--force"],
          ["verify", "staging", "restore", "--unknown"],
        ]) {
          errChunks.length = 0;
          const code = await runVerify(parseArgs(argv));
          expect(code).toBe(2);
          expect(errChunks.join("")).toContain("unknown option");
        }
      } finally {
        process.chdir(prevCwd);
        errSpy.mockRestore();
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
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

      const mkObj = (bucket: string, dataBase64: string, size: number) => ({
        dataBase64,
        blobType: "text/plain",
        metadata: {
          bucket,
          fullPath: "docs/item.txt",
          name: "item.txt",
          size,
          generation: "1",
          metageneration: "1",
          contentType: "text/plain",
          timeCreated: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-01T00:00:00.000Z",
        },
      });
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
                mkObj("demo-proj.firebasestorage.app", "ZGVmYXVsdA==", 7),
                mkObj("secondary-archive.appspot.com", "c2Vjb25kYXJ5", 9),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      });

      const cliStore = new AssuranceCampaignStore();
      const cliIo = bufferIo(dir);
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
        { ...cliIo, store: cliStore, fetchImpl: mockFetch },
      );
      expect(cliCode).toBe(0);

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
