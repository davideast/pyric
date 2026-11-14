import "fake-indexeddb/auto";
import { describe, expect, it, spyOn } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getDatabase, ref as rtdbRef, set, sandbox as rtdbSandbox } from "pyric/database";
import { initializeSandbox } from "pyric/sandbox";
import { getFirestore } from "pyric/sandbox/admin-firestore";
import { getStorageSandbox, ref as storageRef, uploadBytes } from "pyric/storage";
import { nameStorageBucket, replaceStorageRules } from "pyric/storage/internal";
import { parseArgs } from "../../src/cli/parse-args.js";
import { runVerify } from "../../src/cli/verify.js";
import { buildVerifyFixture } from "../../src/verify/index.js";
import { captureRtdbInstances } from "../../src/verify/rtdb-instance-capture.js";

const OPEN_FS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{doc=**} { allow read, write: if true; }
  }
}`;

const DENY_FS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{doc=**} { allow read, write: if false; }
  }
}`;

const OPEN_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`;

const DENY_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if false; }
  }
}`;

const OPEN_RTDB_RULES = { rules: { ".read": true, ".write": true } };
const DENY_RTDB_RULES = { rules: { ".read": false, ".write": false } };

async function runVerifyIn(
  dir: string,
  extraArgs: string[],
): Promise<{ code: number; err: string }> {
  const errChunks: string[] = [];
  const outSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  const errSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errChunks.push(String(chunk));
    return true;
  });
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const code = await runVerify(
      parseArgs(["verify", "session.json", "--json", ...extraArgs]),
    );
    return { code, err: errChunks.join("") };
  } finally {
    process.chdir(prevCwd);
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("pyric verify unified --rules project-root and symlink containment", () => {
  it("rejects outside paths, ancestor symlinks, leaf symlinks, and 2+modules escapes with exit 2 across firestore, rtdb, and storage", async () => {
    const outsideDir = realpathSync(
      mkdtempSync(join(tmpdir(), "pyric-verify-contain-out-")),
    );
    const projectDir = realpathSync(
      mkdtempSync(join(tmpdir(), "pyric-verify-contain-proj-")),
    );
    try {
      writeFileSync(join(outsideDir, "open.rules"), OPEN_FS_RULES);
      writeFileSync(join(outsideDir, "open.storage.rules"), OPEN_STORAGE_RULES);
      writeFileSync(
        join(outsideDir, "open.rtdb.json"),
        JSON.stringify(OPEN_RTDB_RULES),
      );
      writeFileSync(
        join(outsideDir, "helper.rules"),
        "export function allowAll() { return true; }\n",
      );

      mkdirSync(join(projectDir, "inner"), { recursive: true });
      writeFileSync(join(projectDir, "inner/open.rules"), OPEN_FS_RULES);
      writeFileSync(
        join(projectDir, "inner/open.storage.rules"),
        OPEN_STORAGE_RULES,
      );
      writeFileSync(
        join(projectDir, "inner/open.rtdb.json"),
        JSON.stringify(OPEN_RTDB_RULES),
      );

      writeFileSync(join(projectDir, "firestore.rules"), DENY_FS_RULES);
      writeFileSync(join(projectDir, "storage.rules"), DENY_STORAGE_RULES);
      writeFileSync(
        join(projectDir, "database.rules.json"),
        JSON.stringify(DENY_RTDB_RULES),
      );
      writeFileSync(
        join(projectDir, "escape.firestore.rules"),
        [
          "rules_version = '2+modules';",
          `import { allowAll } from '../${basename(outsideDir)}/helper.rules';`,
          "service cloud.firestore {",
          "  match /databases/{database}/documents {",
          "    match /{doc=**} { allow read, write: if allowAll(); }",
          "  }",
          "}",
        ].join("\n"),
      );
      writeFileSync(
        join(projectDir, "escape.storage.rules"),
        [
          "rules_version = '2+modules';",
          `import { allowAll } from '../${basename(outsideDir)}/helper.rules';`,
          "service firebase.storage {",
          "  match /b/{bucket}/o {",
          "    match /{p=**} { allow read, write: if allowAll(); }",
          "  }",
          "}",
        ].join("\n"),
      );
      writeFileSync(
        join(projectDir, ".firebaserc"),
        JSON.stringify({ projects: { default: "demo-proj" } }),
      );
      writeFileSync(
        join(projectDir, "firebase.json"),
        JSON.stringify({
          firestore: { rules: "firestore.rules" },
          database: [
            { instance: "demo-proj-default-rtdb", rules: "database.rules.json" },
            { instance: "shard-a", rules: "database.rules.json" },
          ],
          storage: [
            { bucket: "demo-proj.firebasestorage.app", rules: "storage.rules" },
            { bucket: "media-bucket", rules: "storage.rules" },
          ],
        }),
      );

      symlinkSync(outsideDir, join(projectDir, "linked"));
      symlinkSync(join(projectDir, "inner"), join(projectDir, "inner-linked"));
      symlinkSync(
        join(projectDir, "inner/open.rules"),
        join(projectDir, "leaf-fs.rules"),
      );
      symlinkSync(
        join(projectDir, "inner/open.storage.rules"),
        join(projectDir, "leaf-st.rules"),
      );
      symlinkSync(
        join(projectDir, "inner/open.rtdb.json"),
        join(projectDir, "leaf-rtdb.json"),
      );

      const sandbox = initializeSandbox();
      const alice = sandbox.withAuth({ uid: "alice" });
      const fsDb = getFirestore(alice);
      fsDb.setRules(OPEN_FS_RULES);
      await fsDb.doc("items/i1").set({ title: "alpha" });

      const mainRtdb = getDatabase(sandbox);
      const shardRtdb = getDatabase(sandbox, "https://shard-a.firebaseio.com");
      rtdbSandbox.setRules(mainRtdb, OPEN_RTDB_RULES);
      rtdbSandbox.setRules(shardRtdb, OPEN_RTDB_RULES);
      await set(rtdbRef(getDatabase(alice), "items/i1"), { ok: true });
      await set(
        rtdbRef(getDatabase(alice, "https://shard-a.firebaseio.com"), "items/i1"),
        { ok: true },
      );

      getStorageSandbox(sandbox, { dbName: "verify-contain-db" });
      await replaceStorageRules(sandbox, OPEN_STORAGE_RULES, {
        bucket: "demo-proj.firebasestorage.app",
      });
      await replaceStorageRules(sandbox, OPEN_STORAGE_RULES, {
        bucket: "media-bucket",
      });
      await uploadBytes(
        storageRef(
          nameStorageBucket(getStorageSandbox(alice), "demo-proj.firebasestorage.app"),
          "items/i1.txt",
        ),
        new Uint8Array([1]),
      );
      await uploadBytes(
        storageRef(
          getStorageSandbox(alice, { bucket: "media-bucket" }),
          "items/i2.txt",
        ),
        new Uint8Array([2]),
      );

      const fixture = buildVerifyFixture({
        sandbox,
        firestoreRules: OPEN_FS_RULES,
        rtdbRules: OPEN_RTDB_RULES,
        rtdbState: rtdbSandbox.snapshotState(mainRtdb),
        rtdbInstances: captureRtdbInstances(sandbox, "demo-proj-default-rtdb"),
        storageRules: OPEN_STORAGE_RULES,
      });
      writeFileSync(join(projectDir, "session.json"), JSON.stringify(fixture));

      expect((await runVerifyIn(projectDir, [])).code).toBe(1);

      const outName = basename(outsideDir);
      const invalidSpecs: Array<[string, string]> = [
        ["firestore", `--rules=firestore=../${outName}/open.rules`],
        ["firestore", `--rules=firestore=${join(outsideDir, "open.rules")}`],
        ["firestore", "--rules=firestore=linked/open.rules"],
        ["firestore", "--rules=firestore=inner-linked/open.rules"],
        ["firestore", "--rules=firestore=leaf-fs.rules"],
        ["firestore", "--rules=firestore=escape.firestore.rules"],
        ["rtdb", `--rules=rtdb=../${outName}/open.rtdb.json`],
        ["rtdb", `--rules=rtdb=${join(outsideDir, "open.rtdb.json")}`],
        ["rtdb", "--rules=rtdb=linked/open.rtdb.json"],
        ["rtdb", "--rules=rtdb=inner-linked/open.rtdb.json"],
        ["rtdb", "--rules=rtdb=leaf-rtdb.json"],
        ["rtdb", `--rules=rtdb:shard-a=../${outName}/open.rtdb.json`],
        ["rtdb", "--rules=rtdb:shard-a=inner-linked/open.rtdb.json"],
        ["storage", `--rules=storage=../${outName}/open.storage.rules`],
        ["storage", `--rules=storage=${join(outsideDir, "open.storage.rules")}`],
        ["storage", "--rules=storage=linked/open.storage.rules"],
        ["storage", "--rules=storage=inner-linked/open.storage.rules"],
        ["storage", "--rules=storage=leaf-st.rules"],
        ["storage", "--rules=storage=escape.storage.rules"],
        ["storage", "--rules=storage:media-bucket=inner-linked/open.storage.rules"],
      ];

      for (const [service, rulesArg] of invalidSpecs) {
        const res = await runVerifyIn(projectDir, ["--service", service, rulesArg]);
        expect(res.code).toBe(2);
        expect(res.err.length).toBeGreaterThan(0);
      }

      for (const [service, missingOutsideArg] of [
        ["firestore", `--rules=firestore=../${outName}/does-not-exist.rules`],
        ["rtdb", `--rules=rtdb=../${outName}/does-not-exist.json`],
        ["storage", `--rules=storage=../${outName}/does-not-exist.rules`],
      ] as const) {
        const res = await runVerifyIn(projectDir, [
          "--service",
          service,
          missingOutsideArg,
        ]);
        expect(res.code).toBe(2);
        expect(res.err).toContain("escapes project root");
        expect(res.err).not.toContain("does not exist");
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
