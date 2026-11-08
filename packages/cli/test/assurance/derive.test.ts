import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "pyric/sandbox/internal";
import { deriveAssurance } from "../../src/assurance/derive.js";
import {
  AssuranceCampaignStore,
  createAssuranceTools,
} from "../../src/assurance/tools.js";

const toolContext: ToolContext = { signal: new AbortController().signal };
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

describe("deriveAssurance and firebase_assurance_derive", () => {
  test("emits static-proof and proven-counterexample diagnostics across Firestore, RTDB, and Storage and supports follow-up campaign tools", async () => {
    const root = makeTempDir("derive-tri-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "firebase.json"),
      JSON.stringify({
        firestore: { rules: "firestore.rules" },
        database: { rules: "database.rules.json" },
        storage: { rules: "storage.rules" },
      }),
    );
    writeFileSync(
      join(root, "firestore.rules"),
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /orgs/{orgId}/members/{uid} {
             allow read: if request.auth != null && request.auth.uid == uid;
           }
           match /orgs/{orgId}/items/{itemId} {
             allow read: if request.auth != null && resource.data.ownerId == request.auth.uid;
             allow create, update, delete: if request.auth != null;
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
              tasks: {
                ".read": "auth != null",
                $taskId: {
                  ".write": "auth != null",
                },
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
           match /orgs/{orgId}/avatars/{uid}/{fileName} {
             allow read: if request.auth != null;
             allow create: if request.auth != null
               && request.auth.uid == uid
               && request.resource.contentType.matches('image/.*');
             allow delete: if request.auth != null;
           }
         }
       }`,
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `
        import { getAuth } from 'firebase/auth';
        import { getFirestore, collection, doc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
        import { getDatabase, ref as dbRef, query as dbQuery, orderByChild, equalTo, get as dbGet } from 'firebase/database';
        import { getStorage, ref as stRef, uploadString, deleteObject } from 'firebase/storage';

        export async function appFlow() {
          const uid = getAuth().currentUser!.uid;
          const db = getFirestore();
          await getDocs(collection(db, 'orgs', 'acme', 'items'));
          await setDoc(doc(db, 'orgs', 'acme', 'items', 'item-1'), { ownerId: uid, title: 'hello' });
          await updateDoc(doc(db, 'orgs', 'acme', 'items', 'item-1'), { title: 'updated' });

          const rtdb = getDatabase();
          await dbGet(dbQuery(dbRef(rtdb, 'orgs/acme/tasks'), orderByChild('assignee'), equalTo(uid)));

          const storage = getStorage();
          await uploadString(stRef(storage, 'orgs/acme/avatars/' + uid + '/avatar.txt'), 'plain', 'raw', {
            contentType: 'text/plain',
          });
          await deleteObject(stRef(storage, 'orgs/acme/avatars/' + uid + '/avatar.txt'));
        }
      `,
    );

    const store = new AssuranceCampaignStore();
    const tools = createAssuranceTools({ store });
    const deriveTool = tools.find((t) => t.name === "firebase_assurance_derive");
    expect(deriveTool).toBeDefined();

    const response = await deriveTool!.execute(
      { root, campaignId: "tri-audit" },
      toolContext,
    );
    expect(response.ok).toBe(true);
    const data = response.data as {
      campaignId: string;
      counts: {
        total: number;
        byCertainty: {
          "proven-counterexample": number;
          "static-proof": number;
          heuristic: number;
        };
      };
      diagnostics: Array<{ code: string; certainty: string; service: string }>;
    };

    expect(data.campaignId).toBe("tri-audit");
    expect(data.counts.byCertainty["static-proof"]).toBeGreaterThanOrEqual(3);
    expect(data.counts.byCertainty["proven-counterexample"]).toBeGreaterThanOrEqual(1);

    const codes = data.diagnostics.map((d) => d.code);
    expect(codes).toContain("firestore-unprovable-list-query");
    expect(codes).toContain("storage-content-type-mismatch");
    expect(codes).toContain("rtdb-missing-index-on");

    const exportTool = tools.find((t) => t.name === "firebase_assurance_export")!;
    const exported = await exportTool.execute({ campaignId: "tri-audit" }, toolContext);
    expect(exported.ok).toBe(true);

    const filtered = await deriveAssurance(
      { root, includeStaticChecks: false, includeHeuristic: false },
      { store: new AssuranceCampaignStore() },
    );
    expect(filtered.diagnostics.every((d) => d.certainty === "proven-counterexample")).toBe(true);
  });

  test("routes multi-database Firestore and named RTDB instances without duplicating named RTDB rules onto (default)", async () => {
    const root = makeTempDir("derive-multi-resource-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "firebase.json"),
      JSON.stringify({
        firestore: [
          { rules: "firestore.rules" },
          { database: "analytics", rules: "analytics.firestore.rules" },
        ],
        database: [
          { instance: "shard-a", rules: "shard-a.rules.json" },
        ],
      }),
    );
    writeFileSync(
      join(root, "firestore.rules"),
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /profiles/{uid} {
             allow read, write: if request.auth != null && request.auth.uid == uid;
           }
         }
       }`,
    );
    writeFileSync(
      join(root, "analytics.firestore.rules"),
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /events/{eventId} {
             allow read: if request.auth != null && resource.data.tenantId == 'acme';
           }
         }
       }`,
    );
    writeFileSync(
      join(root, "shard-a.rules.json"),
      JSON.stringify({
        rules: {
          metrics: {
            ".read": "auth != null",
          },
        },
      }),
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `
        import { getAuth } from 'pyric/auth';
        import { getFirestore, collection, doc, getDocs, setDoc } from 'pyric/firestore';
        import { getDatabase, ref as dbRef, query as dbQuery, orderByChild, equalTo, get as dbGet } from 'pyric/database';
        declare const app: unknown;

        export async function runMulti() {
          const uid = getAuth().currentUser!.uid;
          await setDoc(doc(getFirestore(), 'profiles', uid), { active: true });

          const analyticsDb = getFirestore(app, 'analytics');
          await getDocs(collection(analyticsDb, 'events'));

          const shardDb = getDatabase(app, 'https://shard-a.firebaseio.com');
          await dbGet(dbQuery(dbRef(shardDb, 'metrics'), orderByChild('score'), equalTo(10)));
        }
      `,
    );

    const derived = await deriveAssurance(
      { root, campaignId: "multi-resource" },
      { store: new AssuranceCampaignStore() },
    );

    expect(
      derived.diagnostics.map((d) => ({
        code: d.code,
        service: d.service,
        resourceId: d.resourceId,
      })),
    ).toEqual([
      {
        code: "firestore-unprovable-list-query",
        service: "firestore",
        resourceId: "analytics",
      },
      {
        code: "rtdb-missing-index-on",
        service: "rtdb",
        resourceId: "shard-a",
      },
    ]);
  });
});
