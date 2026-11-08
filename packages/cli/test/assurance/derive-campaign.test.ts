import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inferOwnerBindings,
  ownerConditionsFrom,
  runProbes,
} from "pyric/rules/internal/usage";
import {
  buildCounterexampleDiagnostics,
  populateDerivedCampaign,
} from "../../src/assurance/derive-campaign.js";
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
});
