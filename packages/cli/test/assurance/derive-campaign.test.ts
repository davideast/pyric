import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inferOwnerBindings,
  ownerConditionsFrom,
  runProbes,
} from "pyric/rules/internal/usage";
import { qualifyProbe } from "../../src/assurance/capabilities.js";
import {
  buildCounterexampleDiagnostics,
  populateDerivedCampaign,
} from "../../src/assurance/derive-campaign.js";
import { deriveAssurance } from "../../src/assurance/derive.js";
import { loadAssuranceProject } from "../../src/assurance/derive-project.js";
import { AssuranceCampaignStore } from "../../src/assurance/tools.js";

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

describe("derive-campaign", () => {
  test("translates runProbes counterexamples into proven-counterexample diagnostics and inspect/minimize/verify-ready AuthorizationCampaign", async () => {
    const root = makeTempDir("derive-camp-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "firebase.json"),
      JSON.stringify({ firestore: { rules: "firestore.rules" } }),
    );
    writeFileSync(
      join(root, "firestore.rules"),
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /items/{itemId} {
             allow read, create, update, delete: if request.auth != null;
           }
         }
       }`,
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `
        import { getAuth } from 'firebase/auth';
        import { getFirestore, doc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
        export async function workflow(id: string) {
          const uid = getAuth().currentUser!.uid;
          const db = getFirestore();
          await setDoc(doc(db, 'items', id), { ownerId: uid, title: 'draft', note: 'extra' });
          await updateDoc(doc(db, 'items', id), { title: 'published' });
          await deleteDoc(doc(db, 'items', id));
        }
      `,
    );

    const project = loadAssuranceProject(root);
    const conditions = ownerConditionsFrom(project.sources);
    const ownerBindings = inferOwnerBindings(conditions, project.usage.operations);
    const probeReport = await runProbes({
      accessSites: project.usage.operations,
      ownerBindings,
      conditions,
      sources: project.sources,
      users: [
        { uid: "u-alice", email: "alice@example.test", displayName: "Alice" },
        { uid: "u-bob", email: "bob@example.test", displayName: "Bob" },
      ],
    });

    expect(probeReport.findings.length).toBeGreaterThan(0);

    const store = new AssuranceCampaignStore();
    const { campaign, registeredProbeIds } = await populateDerivedCampaign({
      campaignId: "derived-test",
      store,
      project,
      runtime: { history: [] },
      probeReport,
    });

    const diagnostics = buildCounterexampleDiagnostics(
      probeReport,
      campaign.id,
      registeredProbeIds,
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.certainty === "proven-counterexample")).toBe(true);
    expect(registeredProbeIds.size).toBeGreaterThan(0);

    const firstProbeId = [...registeredProbeIds][0]!;
    const inspected = campaign.inspect(firstProbeId);
    expect(inspected.classification).toBe("local-counterexample");

    const minimized = await campaign.minimize(firstProbeId);
    expect(minimized.result.classification).toBe("local-counterexample");

    const verified = await campaign.verifyRules({
      rules: {
        firestore: `rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /items/{itemId} {
                allow read: if request.auth != null;
                allow create: if request.auth != null && request.resource.data.ownerId == request.auth.uid;
                allow update: if request.auth != null
                  && resource.data.ownerId == request.auth.uid
                  && request.resource.data.ownerId == resource.data.ownerId;
                allow delete: if request.auth != null && resource.data.ownerId == request.auth.uid;
              }
            }
          }`,
      },
    });
    expect(verified.summary.localCounterexamples).toBe(0);
    expect(verified.summary.controlsPassed).toBe(verified.summary.probes);
    expect(verified.summary.noCounterexamples).toBe(verified.summary.probes);
  });

  test("bundles 2+modules stdlib and relative .rules imports for conventional rules and derived campaign targets", async () => {
    const root = makeTempDir("derive-camp-modules-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "helpers"), { recursive: true });
    writeFileSync(
      join(root, "helpers/auth.rules"),
      `export function isAuthed() {
  return request.auth != null;
}
`,
    );
    writeFileSync(
      join(root, "firestore.rules"),
      `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
import { isAuthed } from './helpers/auth.rules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow get, list: if isAuthenticated() && resource.data.ownerId == request.auth.uid;
      allow create, update, delete: if isAuthed();
    }
  }
}
`,
    );
    writeFileSync(
      join(root, "storage.rules"),
      `rules_version = '2+modules';
import { isAuthenticated, isOwner } from 'auth';
import { contentTypeMatches } from 'storage/uploads';
import { isAuthed } from './helpers/auth.rules';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{fileName} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated() && isOwner(uid) && contentTypeMatches('image/.*');
      allow delete: if isAuthed();
    }
  }
}
`,
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `
        import { getAuth } from 'firebase/auth';
        import { getFirestore, collection, doc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
        import { getStorage, ref, uploadBytes, deleteObject } from 'firebase/storage';
        export async function run(id: string) {
          const uid = getAuth().currentUser!.uid;
          const db = getFirestore();
          await getDocs(collection(db, 'items'));
          await setDoc(doc(db, 'items', id), { ownerId: uid, title: 'draft' });
          await updateDoc(doc(db, 'items', id), { title: 'edited' });

          const storage = getStorage();
          await uploadBytes(ref(storage, 'users/' + uid + '/doc.txt'), new Uint8Array([1, 2]), {
            contentType: 'text/plain',
          });
          await deleteObject(ref(storage, 'users/' + uid + '/doc.txt'));
        }
      `,
    );

    const store = new AssuranceCampaignStore();
    const derived = await deriveAssurance({ root, campaignId: "modular-derived" }, { store });
    const codes = derived.diagnostics.map((d) => d.code);
    expect(codes).toContain("firestore-unprovable-list-query");
    expect(codes).toContain("storage-content-type-mismatch");

    const campaign = store.get("modular-derived")!;
    const spec = campaign.spec();
    expect(spec.target.rules.firestore).toContain("rules_version = '2';");
    expect(spec.target.rules.storage).toContain("rules_version = '2';");
    expect(spec.probes.length).toBeGreaterThan(0);
    for (const probe of spec.probes) {
      const qual = qualifyProbe(spec.target, probe);
      expect(qual.supported).toBe(true);
      const inspected = campaign.inspect(probe.id);
      expect(inspected.control.decision).toBe("ALLOW");
      expect(inspected.mutation.decision).toBe("ALLOW");
      expect(inspected.classification).toBe("candidate-signal");
    }
  });

  test("preserves distinct custom-claim actor profiles across multi-collection campaign probes without invalid-probe collisions", async () => {
    const root = makeTempDir("pyric-multi-claim-campaign-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "firebase.json"),
      JSON.stringify({ firestore: { rules: "firestore.rules" } }),
    );
    writeFileSync(
      join(root, "firestore.rules"),
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/adminDocs/{docId} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.token.role == 'admin';
    }
    match /users/{uid}/editorDocs/{docId} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.token.role == 'editor';
    }
  }
}
`,
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `import { getAuth } from "firebase/auth";
import { doc, getFirestore, setDoc } from "firebase/firestore";
export async function saveBoth(docId: string) {
  const uid = getAuth().currentUser!.uid;
  await setDoc(doc(getFirestore(), \`users/\${uid}/adminDocs/\${docId}\`), { ownerId: uid });
  await setDoc(doc(getFirestore(), \`users/\${uid}/editorDocs/\${docId}\`), { ownerId: uid });
}
`,
    );

    const store = new AssuranceCampaignStore();
    const derived = await deriveAssurance(
      { root, campaignId: "multi-claim", includeStaticChecks: false },
      { store },
    );
    expect(derived.diagnostics.some((d) => d.message.includes("adminDocs"))).toBe(true);
    expect(derived.diagnostics.some((d) => d.message.includes("editorDocs"))).toBe(true);

    const campaign = store.get("multi-claim")!;
    const report = campaign.report ?? (await campaign.run());
    expect(report.summary.invalidProbes).toBe(0);
  });

  test("isolates named-only Storage buckets without leaking rules or false counterexamples onto the undeployed default bucket", async () => {
    const root = makeTempDir("derive-named-only-storage-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, ".firebaserc"),
      JSON.stringify({ projects: { default: "demo-app" } }),
    );
    writeFileSync(
      join(root, "firebase.json"),
      JSON.stringify({
        storage: [{ bucket: "archive-bucket", rules: "archive.rules" }],
      }),
    );
    writeFileSync(
      join(root, "archive.rules"),
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/files/{name} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
`,
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `import { getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getStorage, ref, uploadBytes } from 'firebase/storage';

export async function uploadArchiveAndUnconfiguredDefault() {
  const uid = getAuth().currentUser!.uid;
  const archive = getStorage(getApp(), 'gs://archive-bucket');
  await uploadBytes(ref(archive, \`users/\${uid}/files/doc.txt\`), new Uint8Array([1, 2]), {
    contentType: 'text/plain',
  });
  const unconfiguredDefault = getStorage();
  await uploadBytes(ref(unconfiguredDefault, \`users/\${uid}/files/leak.txt\`), new Uint8Array([1, 2]), {
    contentType: 'text/plain',
  });
}
`,
    );

    const store = new AssuranceCampaignStore();
    const derived = await deriveAssurance(
      { root, campaignId: "named-only-bucket" },
      { store },
    );

    const codes = derived.diagnostics.map((d) => d.code);
    expect(codes).toContain("storage-unconfigured-bucket");
    expect(
      derived.diagnostics.filter((d) => d.certainty === "proven-counterexample" && d.code !== "assurance-must-allow-denied"),
    ).toEqual([]);

    const campaign = store.get("named-only-bucket")!;
    const spec = campaign.spec();
    expect(spec.target.rules.storage).toBeUndefined();
    expect(spec.target.rules.storageBuckets?.["archive-bucket"]).toContain(
      "service firebase.storage",
    );

    campaign.addActor({
      id: "owner-check",
      label: "Owner",
      acquisition: { kind: "synthetic", uid: "u-alice", token: {} },
    });
    campaign.addInvariant({
      id: "inv-undeployed-default-denied",
      statement: "Undeployed default bucket denies writes",
      service: "storage",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });
    campaign.addProbe({
      id: "probe-undeployed-default",
      actorId: "owner-check",
      invariantId: "inv-undeployed-default-denied",
      control: {
        service: "storage",
        instance: "archive-bucket",
        method: "upload",
        path: "users/u-alice/files/ok.txt",
        dataBase64: "YWJj",
        contentType: "text/plain",
      },
      mutation: {
        dimension: "path",
        description: "Write to undeployed default bucket",
        operation: {
          service: "storage",
          method: "upload",
          path: "users/u-alice/files/ok.txt",
          dataBase64: "YWJj",
          contentType: "text/plain",
        },
      },
    });
    const report = await campaign.run();
    const checkResult = report.results.find((r) => r.probeId === "probe-undeployed-default");
    expect(checkResult?.control.decision).toBe("ALLOW");
    expect(checkResult?.mutation.decision).toBe("DENY");
  });
});
