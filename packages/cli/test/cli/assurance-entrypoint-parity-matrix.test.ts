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

      const sessionFixture = {
        schema: "pyric.verify.fixture.v1" as const,
        events: [
          {
            kind: "operation" as const,
            id: "op-1",
            at: 1000,
            service: "storage" as const,
            method: "get",
            path: "items/i1.png",
            auth: { uid: "alice" },
            result: "allow" as const,
            origin: "user" as const,
            detail: { bucket: "pyric-default.appspot.com" },
          },
        ],
        services: {
          storage: {
            rules: { format: "storage.rules" as const, source: permissiveStorage },
            state: null,
          },
        },
      };
      writeFileSync(join(dir, "session.json"), JSON.stringify(sessionFixture));

      const candidate = await resolveStorageCandidateRules({
        cwd: dir,
        fixtures: [sessionFixture],
        overrides: { default: "strict.rules", buckets: [] },
        readFirebaseJson: async () => ({
          storage: [
            { bucket: "demo-proj.firebasestorage.app", rules: "permissive.rules" },
          ],
        }),
      });
      expect(candidate.rules.storage).toContain("allow read, write: if false;");
      expect(candidate.rules.storageBuckets).toBeUndefined();

      const runVerifyInDir = async (extraArgs: string[]): Promise<number> => {
        const prevCwd = process.cwd();
        const outSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
        const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
        process.chdir(dir);
        try {
          return await runVerify(parseArgs(["verify", "session.json", "--json", ...extraArgs]));
        } finally {
          process.chdir(prevCwd);
          outSpy.mockRestore();
          errSpy.mockRestore();
        }
      };

      for (const alias of [
        "demo-proj.firebasestorage.app",
        "demo-proj.appspot.com",
      ]) {
        writeFileSync(
          join(dir, "firebase.json"),
          JSON.stringify({ storage: { rules: "strict.rules" } }),
        );
        expect(
          await runVerifyStatic(
            parseArgs(["verify", "--static", "--rules", `storage:${alias}=permissive.rules`, "--json"]),
            bufferIo(dir),
          ),
        ).toBe(0);
        expect(await runVerifyInDir(["--rules", `storage:${alias}=permissive.rules`])).toBe(0);

        writeFileSync(
          join(dir, "firebase.json"),
          JSON.stringify({ storage: { rules: "permissive.rules" } }),
        );
        expect(
          await runVerifyStatic(
            parseArgs(["verify", "--static", "--rules", `storage:${alias}=strict.rules`, "--json"]),
            bufferIo(dir),
          ),
        ).toBe(1);
        expect(await runVerifyInDir(["--rules", `storage:${alias}=strict.rules`])).toBe(1);
      }

      writeFileSync(
        join(dir, "firebase.json"),
        JSON.stringify({
          storage: [{ bucket: "demo-proj.appspot.com", rules: "strict.rules" }],
        }),
      );
      expect(
        await runVerifyStatic(
          parseArgs([
            "verify",
            "--static",
            "--rules",
            "storage:demo-proj.firebasestorage.app=permissive.rules",
            "--json",
          ]),
          bufferIo(dir),
        ),
      ).toBe(0);
      expect(
        await runVerifyInDir([
          "--rules",
          "storage:demo-proj.firebasestorage.app=permissive.rules",
        ]),
      ).toBe(0);
      writeFileSync(
        join(dir, "firebase.json"),
        JSON.stringify({
          storage: [{ bucket: "demo-proj.appspot.com", rules: "permissive.rules" }],
        }),
      );
      expect(
        await runVerifyStatic(
          parseArgs([
            "verify",
            "--static",
            "--rules",
            "storage:demo-proj.firebasestorage.app=strict.rules",
            "--json",
          ]),
          bufferIo(dir),
        ),
      ).toBe(1);
      expect(
        await runVerifyInDir([
          "--rules",
          "storage:demo-proj.firebasestorage.app=strict.rules",
        ]),
      ).toBe(1);
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
});
