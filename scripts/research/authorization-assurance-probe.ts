/**
 * LOCAL-ONLY DEFENSIVE AGENT RUN.
 *
 * This script drives the public assurance tools over invented fixtures. It
 * performs no network requests and never contacts Firebase or the Emulator
 * Suite. Controls, mutations, minimization, and fix verification all execute
 * in disposable Pyric sandboxes.
 */

import type { ToolHandler } from "@inbrowser/agent";
import {
  AssuranceCampaignStore,
  createAssuranceTools,
  type AssuranceProbeResult,
  type AuthorizationCampaignReport,
  type CampaignExport,
  type LocalFirebaseTarget,
  type MinimizationResult,
} from "pyric-tools/assurance";

interface ToolResult<T> {
  ok: boolean;
  summary: string;
  data?: T;
}

function handler(tools: ToolHandler[], name: string): ToolHandler {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing assurance tool '${name}'.`);
  return found;
}

async function call<T>(
  tools: ToolHandler[],
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await handler(tools, name).execute(args)) as ToolResult<T>;
  if (!result.ok || result.data === undefined) {
    throw new Error(`${name}: ${result.summary}`);
  }
  return result.data;
}

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, update: if request.auth != null
        && exists(/databases/$(database)/documents/rooms/$(roomId)/members/$(request.auth.uid));
    }
  }
}`;

const RTDB_RULES = {
  rules: {
    rooms: {
      $roomId: {
        members: {
          $uid: {
            ".read":
              'auth != null && root.child("rooms").child($roomId).child("members").child(auth.uid).exists()',
            ".write":
              'auth != null && root.child("rooms").child($roomId).child("members").child(auth.uid).exists()',
          },
        },
      },
    },
  },
};

const STORAGE_RULES = `service firebase.storage {
  match /b/{bucket}/o {
    match /rooms/{roomId}/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const target: LocalFirebaseTarget = {
  schema: "pyric.assurance.target.v1",
  network: "forbid",
  rules: {
    firestore: FIRESTORE_RULES,
    rtdb: RTDB_RULES,
    storage: STORAGE_RULES,
  },
  state: {
    firestore: {
      "rooms/r1": { ownerId: "alice", title: "Original title" },
      "rooms/r1/members/alice": { role: "owner" },
      "rooms/r1/members/mallory": { role: "member" },
    },
    rtdb: {
      rooms: {
        r1: {
          members: {
            alice: { role: "owner", status: "online" },
            mallory: { role: "member", status: "offline" },
          },
        },
      },
    },
    storage: [
      {
        path: "b/pyric-default/o/rooms/r1/alice/private.json",
        dataBase64: "YWxpY2Utc2VjcmV0",
        contentType: "application/json",
        customMetadata: { owner: "alice" },
      },
    ],
    auth: {
      users: [
        {
          uid: "mallory",
          email: "mallory@example.test",
          password: "correct-horse-battery-staple",
        },
      ],
    },
  },
};

const store = new AssuranceCampaignStore();
const visualizations: string[] = [];
const tools = createAssuranceTools({
  store,
  onCampaignUpdate: (snapshot) => {
    visualizations.push(
      `${snapshot.campaignId}:${snapshot.report?.results.length ?? 0}:${snapshot.report?.summary.localCounterexamples ?? 0}`,
    );
  },
});
const campaignId = "agent-driven-collaboration-v1";

await call(tools, "firebase_assurance_start", {
  campaignId,
  target,
  maxRuns: 50,
});

await call(tools, "firebase_assurance_map", {
  campaignId,
  actors: [
    {
      id: "member-b",
      acquisition: {
        kind: "password",
        email: "mallory@example.test",
        password: "correct-horse-battery-staple",
      },
    },
  ],
  observations: [
    {
      id: "firestore-title-update",
      actorId: "member-b",
      result: "ALLOW",
      source: "authored",
      operation: {
        service: "firestore",
        method: "update",
        path: "rooms/r1",
        data: { title: "Edited by member" },
      },
    },
    {
      id: "rtdb-own-presence",
      actorId: "member-b",
      result: "ALLOW",
      source: "authored",
      operation: {
        service: "rtdb",
        method: "set",
        path: "/rooms/r1/members/mallory/status",
        data: "online",
      },
    },
    {
      id: "storage-own-upload",
      actorId: "member-b",
      result: "ALLOW",
      source: "authored",
      operation: {
        service: "storage",
        method: "upload",
        path: "b/pyric-default/o/rooms/r1/mallory/note.json",
        dataBase64: "bWFsbG9yeS1ub3Rl",
        contentType: "application/json",
        customMetadata: { owner: "mallory" },
      },
    },
  ],
});

await call(tools, "firebase_assurance_define", {
  campaignId,
  invariants: [
    {
      id: "room-owner-immutable",
      service: "firestore",
      statement: "A non-owner room member must not change ownerId.",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    },
    {
      id: "other-role-immutable",
      service: "rtdb",
      statement: "A member must not change another member's role.",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    },
    {
      id: "other-object-immutable",
      service: "storage",
      statement:
        "A member must not overwrite an object owned by another actor.",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    },
  ],
});

await call(tools, "firebase_assurance_propose", {
  campaignId,
  observationId: "firestore-title-update",
  invariantId: "room-owner-immutable",
  mutations: [
    {
      id: "firestore-owner-transfer",
      dimension: "payload",
      description: "Add ownerId to the known-good title update.",
      operation: {
        service: "firestore",
        method: "update",
        path: "rooms/r1",
        data: { ownerId: "mallory", title: "Edited by member" },
      },
    },
  ],
});

await call(tools, "firebase_assurance_propose", {
  campaignId,
  observationId: "rtdb-own-presence",
  invariantId: "other-role-immutable",
  mutations: [
    {
      id: "rtdb-other-role",
      dimension: "path",
      description:
        "Change only the path from own status to another member role.",
      operation: {
        service: "rtdb",
        method: "set",
        path: "/rooms/r1/members/alice/role",
        data: "online",
      },
    },
  ],
});

await call(tools, "firebase_assurance_propose", {
  campaignId,
  observationId: "storage-own-upload",
  invariantId: "other-object-immutable",
  mutations: [
    {
      id: "storage-overwrite-owner",
      dimension: "path",
      description:
        "Change only the path from a new own object to another owner object.",
      operation: {
        service: "storage",
        method: "upload",
        path: "b/pyric-default/o/rooms/r1/alice/private.json",
        dataBase64: "bWFsbG9yeS1ub3Rl",
        contentType: "application/json",
        customMetadata: { owner: "mallory" },
      },
    },
  ],
});

const report = await call<AuthorizationCampaignReport>(
  tools,
  "firebase_assurance_run",
  { campaignId },
);
if (
  report.summary.controlsPassed !== 3 ||
  report.summary.localCounterexamples !== 3 ||
  report.summary.engineGaps !== 0
) {
  throw new Error(
    `Unexpected campaign result: ${JSON.stringify({
      summary: report.summary,
      results: report.results.map((result) => ({
        probeId: result.probeId,
        classification: result.classification,
        qualification: result.qualification,
      })),
    })}`,
  );
}

const inspections: AssuranceProbeResult[] = [];
for (const probeId of [
  "firestore-owner-transfer",
  "rtdb-other-role",
  "storage-overwrite-owner",
]) {
  const inspected = await call<{ result: AssuranceProbeResult }>(
    tools,
    "firebase_assurance_inspect",
    { campaignId, probeId },
  );
  inspections.push(inspected.result);
}

const minimized = await call<MinimizationResult>(
  tools,
  "firebase_assurance_minimize",
  { campaignId, probeId: "firestore-owner-transfer" },
);
const minimizedData = (
  minimized.probe.mutation.operation as { data?: Record<string, unknown> }
).data;
if (JSON.stringify(minimizedData) !== JSON.stringify({ ownerId: "mallory" })) {
  throw new Error(
    `Minimizer lost the policy delta: ${JSON.stringify(minimizedData)}`,
  );
}

const exported = await call<CampaignExport>(
  tools,
  "firebase_assurance_export",
  {
    campaignId,
  },
);
if (exported.cases.length !== 3) {
  throw new Error(`Expected 3 SecurityCases, got ${exported.cases.length}.`);
}

const fixedRules: LocalFirebaseTarget["rules"] = {
  firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, update: if request.auth != null
        && exists(/databases/$(database)/documents/rooms/$(roomId)/members/$(request.auth.uid))
        && request.resource.data.ownerId == resource.data.ownerId;
    }
  }
}`,
  rtdb: {
    rules: {
      rooms: {
        $roomId: {
          members: {
            $uid: {
              ".read": "auth != null && $uid == auth.uid",
              ".write": "auth != null && $uid == auth.uid",
            },
          },
        },
      },
    },
  },
  storage: `service firebase.storage {
  match /b/{bucket}/o {
    match /rooms/{roomId}/{uid}/{allPaths=**} {
      allow read, write: if request.auth != null && uid == request.auth.uid;
    }
  }
}`,
};

const verification = await call<AuthorizationCampaignReport>(
  tools,
  "firebase_assurance_verify",
  {
    campaignId,
    verificationId: `${campaignId}-fixed`,
    rules: fixedRules,
  },
);
const verifiedExport = await call<CampaignExport>(
  tools,
  "firebase_assurance_export",
  {
    campaignId,
  },
);
if (
  verification.summary.controlsPassed !== 3 ||
  verification.summary.noCounterexamples !== 3 ||
  verification.summary.localCounterexamples !== 0
) {
  throw new Error(
    `Candidate rules did not verify: ${JSON.stringify(verification.summary)}`,
  );
}
if (
  verifiedExport.verifications?.at(-1)?.campaignId !== `${campaignId}-fixed`
) {
  throw new Error(
    "Candidate verification was not retained in the campaign export.",
  );
}

console.log(
  JSON.stringify(
    {
      boundary: {
        attachment: "none; invented fixture",
        execution: "Pyric local sandboxes",
        network: "forbid",
        firebaseContacted: false,
        emulatorSuiteContacted: false,
      },
      campaignId,
      targetHash: report.targetHash,
      discovery: report.summary,
      findings: inspections.map((result) => ({
        probeId: result.probeId,
        service: result.control.operation.service,
        actor: result.actorEvidence,
        control: result.control.decision,
        expected: result.invariant.expected,
        observed: result.mutation.decision,
        classification: result.classification,
        impact: result.stateDiff,
        qualified: result.qualification.supported,
      })),
      minimization: {
        probeId: minimized.probeId,
        removedPayloadFields: minimized.removedPayloadFields,
        retainedPayload: minimizedData,
      },
      exportedCases: exported.cases.map((item) => ({
        id: item.id,
        service: item.mutation.operation.service,
        dimension: item.mutation.dimension,
        expectation: item.expect,
      })),
      candidateRulesVerification: {
        summary: verification.summary,
        results: verification.results.map((result) => ({
          probeId: result.probeId,
          control: result.control.decision,
          mutation: result.mutation.decision,
          classification: result.classification,
        })),
      },
      visualizationUpdates: visualizations,
    },
    null,
    2,
  ),
);
