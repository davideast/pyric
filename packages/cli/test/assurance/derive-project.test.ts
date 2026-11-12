import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAuth, sandbox as authSandbox } from "pyric/auth";
import { doc, getFirestore, setDoc } from "pyric/firestore";
import { initializeSandbox } from "pyric/sandbox";
import { setRules } from "pyric/sandbox/firestore";
import {
  cloneLiveRuntime,
  loadAssuranceProject,
  resolveDeriveRoot,
} from "../../src/assurance/derive-project.js";
import { AssuranceCampaignStore } from "../../src/assurance/tools.js";
import { AssuranceInputError } from "../../src/assurance/types.js";

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

describe("derive-project", () => {
  test("resolveDeriveRoot rejects symlink escape outside projectDir", () => {
    const projectDir = makeTempDir("derive-proj-");
    const outsideDir = makeTempDir("derive-outside-");
    const escapeLink = join(projectDir, "linked-sub");
    symlinkSync(outsideDir, escapeLink);

    expect(() => resolveDeriveRoot("linked-sub", projectDir)).toThrow(
      AssuranceInputError,
    );
    expect(() => resolveDeriveRoot("../" + outsideDir.split("/").pop(), projectDir)).toThrow(
      AssuranceInputError,
    );
  });

  test("loadAssuranceProject extracts SdkUsageIndex, RuleSources, and projected RuleSurface", () => {
    const root = makeTempDir("derive-load-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "firebase.json"),
      JSON.stringify({
        firestore: { rules: "firestore.rules" },
        database: { rules: "database.rules.json" },
        storage: [{ bucket: "media-bucket", rules: "storage.rules" }],
      }),
    );
    writeFileSync(
      join(root, "firestore.rules"),
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /orgs/{orgId}/items/{itemId} {
             allow read, write: if request.auth != null;
           }
         }
       }`,
    );
    writeFileSync(
      join(root, "database.rules.json"),
      JSON.stringify({
        rules: {
          orgs: {
            $orgId: {
              presence: {
                $uid: { ".read": "auth != null", ".write": "auth.uid === $uid" },
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(root, "storage.rules"),
      `rules_version = '2';
       service firebase.storage {
         match /b/{bucket}/o {
           match /orgs/{orgId}/files/{fileName} {
             allow create: if request.auth != null && request.resource.contentType.matches('image/.*');
           }
         }
       }`,
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `
        import { getFirestore, doc, setDoc } from 'firebase/firestore';
        export async function saveItem(uid: string) {
          const db = getFirestore();
          await setDoc(doc(db, 'orgs', 'acme', 'items', 'i1'), { ownerId: uid });
        }
      `,
    );

    const loaded = loadAssuranceProject(root);
    expect(loaded.usage.operations.length).toBeGreaterThan(0);
    expect(loaded.sources.firestore).toHaveLength(1);
    expect(loaded.sources.rtdb).toHaveLength(1);
    expect(loaded.sources.storage).toHaveLength(1);
    expect(loaded.configuredBuckets).toEqual(["media-bucket"]);
    expect(loaded.ruleSurface.entries.length).toBeGreaterThanOrEqual(3);
  });

  test("cloneLiveRuntime captures SandboxSnapshot and history without mutating live sandbox", async () => {
    const sandbox = initializeSandbox();
    setRules(
      sandbox,
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /orgs/{orgId}/items/{itemId} {
             allow read, write: if request.auth != null;
           }
         }
       }`,
    );
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [{ uid: "u-alice", email: "alice@example.test" }]);
    const session = authSandbox.mintSession(auth, { kind: "uid", uid: "u-alice" });
    const ctx = sandbox.withAuth(session.state);
    await setDoc(doc(getFirestore(ctx), "orgs/acme/items/item-1"), {
      ownerId: "u-alice",
      title: "Original",
    });

    const historyBefore = sandbox.history().length;
    const store = new AssuranceCampaignStore();
    const cloned = await cloneLiveRuntime({ store, sandbox });

    expect(cloned.snapshot?.firestore["(default)"]?.["orgs/acme/items/item-1"]).toBeDefined();
    expect(cloned.history.length).toBeGreaterThan(0);
    expect(sandbox.history().length).toBe(historyBefore);
  });

  test("snapshotFromTarget computes decoded byte size rather than base64 character length", async () => {
    const store = new AssuranceCampaignStore();
    const cloned = await cloneLiveRuntime({
      url: "http://127.0.0.1:3473",
      store,
      attachmentProvider: async ({ url }) => ({
        target: {
          schema: "firebase-assurance-target/v1",
          network: "forbid",
          rules: {},
          state: {
            storage: [
              {
                path: "docs/three-bytes.bin",
                dataBase64: "AQID",
                contentType: "application/octet-stream",
              },
            ],
          },
        },
        source: {
          requestedUrl: url,
          origin: url,
          transport: "same-origin-shared-worker",
          readOnly: true,
          studioUrl: `${url}/__pyric/ui/assurance`,
        },
        inventory: {
          rules: { firestore: false, rtdb: false, storage: false },
          authUsers: 0,
          firestoreDocuments: 0,
          rtdbPopulated: false,
          storageObjects: 1,
        },
        coverageGaps: [],
      }),
    });

    expect(cloned.snapshot?.storage["(default)"]?.[0]?.size).toBe(3);
  });

  test("snapshotFromTarget round-trips Storage HTTP metadata, Auth providerUserInfo and providers, and storageConfig without field loss", async () => {
    const store = new AssuranceCampaignStore();
    const cloned = await cloneLiveRuntime({
      url: "http://127.0.0.1:3473",
      store,
      attachmentProvider: async ({ url }) => ({
        target: {
          schema: "pyric.assurance.target.v1",
          network: "forbid",
          rules: {},
          state: {
            storage: [
              {
                path: "assets/banner.svg",
                dataBase64: "AQID",
                contentType: "image/svg+xml",
                cacheControl: "public, max-age=3600",
                contentDisposition: "inline; filename=\"banner.svg\"",
                contentEncoding: "gzip",
                contentLanguage: "en-US",
                timeCreated: "2026-01-01T00:00:00.000Z",
                updated: "2026-01-02T00:00:00.000Z",
                customMetadata: { ownerId: "u-alice" },
              },
            ],
            storageBuckets: {
              "archive-bucket": [
                {
                  path: "backups/snap.tar",
                  dataBase64: "BAUG",
                  contentType: "application/x-tar",
                  cacheControl: "private, no-store",
                  timeCreated: "2026-02-01T00:00:00.000Z",
                  updated: "2026-02-01T00:00:00.000Z",
                },
              ],
            },
            storageConfig: {
              crossServiceIam: "denied",
              undeployedBucketPolicy: "deny",
            },
            auth: {
              users: [
                {
                  uid: "u-alice",
                  email: "alice@example.test",
                  emailVerified: true,
                  tenantId: "tenant-1",
                  providerId: "google.com",
                  providerUserInfo: [
                    {
                      providerId: "google.com",
                      rawId: "goog-sub-42",
                      uid: "goog-sub-42",
                      email: "alice@example.test",
                      displayName: "Alice",
                    },
                  ],
                  customClaims: { role: "owner" },
                },
              ],
              providers: {
                "google.com": true,
                password: false,
              },
            },
          },
        },
        source: {
          requestedUrl: url,
          origin: url,
          transport: "same-origin-shared-worker",
          readOnly: true,
          studioUrl: `${url}/__pyric/ui/assurance`,
        },
        inventory: {
          rules: { firestore: false, rtdb: false, storage: false },
          authUsers: 1,
          firestoreDocuments: 0,
          rtdbPopulated: false,
          storageObjects: 2,
        },
        coverageGaps: [],
      }),
    });

    const defaultObj = cloned.snapshot?.storage["(default)"]?.[0];
    expect(defaultObj).toMatchObject({
      path: "assets/banner.svg",
      size: 3,
      contentType: "image/svg+xml",
      cacheControl: "public, max-age=3600",
      contentDisposition: "inline; filename=\"banner.svg\"",
      contentEncoding: "gzip",
      contentLanguage: "en-US",
      timeCreated: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-02T00:00:00.000Z",
      customMetadata: { ownerId: "u-alice" },
    });
    const archiveObj = cloned.snapshot?.storage["archive-bucket"]?.[0];
    expect(archiveObj).toMatchObject({
      path: "backups/snap.tar",
      cacheControl: "private, no-store",
      timeCreated: "2026-02-01T00:00:00.000Z",
      updated: "2026-02-01T00:00:00.000Z",
    });
    expect(cloned.snapshot?.storageConfig).toEqual({
      crossServiceIam: "denied",
      undeployedBucketPolicy: "deny",
    });
    expect(cloned.snapshot?.auth.providers).toEqual({
      "google.com": true,
      password: false,
    });
    expect(cloned.snapshot?.auth.users[0]?.providerUserInfo).toEqual([
      {
        providerId: "google.com",
        rawId: "goog-sub-42",
        uid: "goog-sub-42",
        email: "alice@example.test",
        displayName: "Alice",
      },
    ]);
  });
});
