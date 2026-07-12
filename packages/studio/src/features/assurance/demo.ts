import type {
  AssuranceProbeResult,
  FirebaseOperation,
} from "pyric-tools/assurance";
import type { AssuranceVisualizationSnapshot } from "pyric-tools/assurance/browser";

interface DemoResultInput {
  id: string;
  service: "firestore" | "rtdb" | "storage";
  control: FirebaseOperation;
  mutation: FirebaseOperation;
  statement: string;
  description: string;
  before: unknown;
  after: unknown;
}

function demoResult(input: DemoResultInput): AssuranceProbeResult {
  return {
    campaignId: "collaboration-local-v1",
    probeId: input.id,
    targetHash: "fnv1a32-7f4c911a",
    actorEvidence: {
      actorId: "member-b",
      acquisition: "password",
      reachability: "reachable",
      uid: "mallory",
    },
    invariant: {
      id: `${input.id}-invariant`,
      service: input.service,
      statement: input.statement,
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    },
    mutationSpec: {
      dimension: input.service === "firestore" ? "payload" : "path",
      description: input.description,
      operation: input.mutation,
    },
    control: { operation: input.control, decision: "ALLOW", events: [] },
    mutation: {
      operation: input.mutation,
      decision: "ALLOW",
      events:
        input.service === "firestore"
          ? [
              {
                id: "req-firestore-owner-transfer",
                at: 100,
                kind: "request",
                service: "firestore",
                method: "update",
                path: "rooms/r1",
                result: "allow",
                auth: { uid: "mallory", token: {} },
                reasons: ["Rule #1 (update) -> ALLOW"],
                origin: "user",
                request: { resourceData: { ownerId: "mallory" } },
                resourceBefore: { exists: true, data: input.before },
                matchedRule: { ruleIndex: 0, operations: ["update"] },
              },
            ]
          : [],
    },
    stateDiff: { changed: true, before: input.before, after: input.after },
    qualification: {
      engine: "pyric-local-sandboxes",
      supported: true,
      requirements: [
        {
          id: `${input.service}.local-supported-subset`,
          supported: true,
          reason:
            "This probe stays within the supported local evaluator subset.",
        },
      ],
    },
    classification: "local-counterexample",
  };
}

const results = [
  demoResult({
    id: "firestore-owner-transfer",
    service: "firestore",
    control: {
      service: "firestore",
      method: "update",
      path: "rooms/r1",
      data: { title: "Edited" },
    },
    mutation: {
      service: "firestore",
      method: "update",
      path: "rooms/r1",
      data: { ownerId: "mallory" },
    },
    statement: "A non-owner room member must not change ownerId.",
    description: "Changed only the updated field from title to ownerId.",
    before: { ownerId: "alice", title: "Original title" },
    after: { ownerId: "mallory", title: "Original title" },
  }),
  demoResult({
    id: "rtdb-other-role",
    service: "rtdb",
    control: {
      service: "rtdb",
      method: "set",
      path: "/rooms/r1/members/mallory/status",
      data: "online",
    },
    mutation: {
      service: "rtdb",
      method: "set",
      path: "/rooms/r1/members/alice/role",
      data: "online",
    },
    statement: "A member must not change another member's role.",
    description:
      "Changed only the target path from own status to another member role.",
    before: "owner",
    after: "online",
  }),
  demoResult({
    id: "storage-overwrite-owner",
    service: "storage",
    control: {
      service: "storage",
      method: "upload",
      path: "b/pyric-default/o/rooms/r1/mallory/note.json",
      dataBase64: "bWFsbG9yeQ==",
      customMetadata: { owner: "mallory" },
    },
    mutation: {
      service: "storage",
      method: "upload",
      path: "b/pyric-default/o/rooms/r1/alice/private.json",
      dataBase64: "bWFsbG9yeQ==",
      customMetadata: { owner: "mallory" },
    },
    statement: "A member must not overwrite an object owned by another actor.",
    description:
      "Changed only the target from a new own object to an existing other-owned object.",
    before: { text: "alice-secret", customMetadata: { owner: "alice" } },
    after: {
      text: "mallory",
      customMetadata: { owner: "mallory" },
    },
  }),
];

const verificationResults = results.map((result) => ({
  ...result,
  campaignId: "collaboration-local-v1-fixed",
  targetHash: "fnv1a32-a9f18f23",
  mutation: { ...result.mutation, decision: "DENY" as const, events: [] },
  stateDiff: undefined,
  classification: "no-counterexample" as const,
}));

export const ASSURANCE_DEMO_CAMPAIGN: AssuranceVisualizationSnapshot = {
  schema: "pyric.assurance.visualization.v1",
  campaignId: "collaboration-local-v1",
  context: {
    attachment: {
      source: {
        requestedUrl: "http://localhost:5210/__pyric/ui/",
        origin: "http://localhost:5210",
        transport: "same-origin-shared-worker",
        readOnly: true,
        studioUrl: "http://localhost:5210/__pyric/ui/assurance",
      },
      inventory: {
        firestoreDocuments: 3,
        rtdbPresent: true,
        authUsers: 2,
        storageObjects: 0,
      },
      coverageGaps: [
        {
          service: "storage",
          code: "storage-attachment-unavailable",
          reason:
            "Provide explicit Storage rules and object fixtures for Storage coverage.",
        },
      ],
    },
  },
  observations: [],
  probes: [],
  report: {
    schema: "pyric.assurance.report.v1",
    campaignId: "collaboration-local-v1",
    targetHash: "fnv1a32-7f4c911a",
    localOnly: { network: "forbid", engine: "pyric-local-sandboxes" },
    results,
    summary: {
      probes: 3,
      controlsPassed: 3,
      localCounterexamples: 3,
      candidateSignals: 0,
      noCounterexamples: 0,
      engineGaps: 0,
      invalidProbes: 0,
    },
  },
  verifications: [
    {
      schema: "pyric.assurance.report.v1",
      campaignId: "collaboration-local-v1-fixed",
      targetHash: "fnv1a32-a9f18f23",
      localOnly: { network: "forbid", engine: "pyric-local-sandboxes" },
      results: verificationResults,
      summary: {
        probes: 3,
        controlsPassed: 3,
        localCounterexamples: 0,
        candidateSignals: 0,
        noCounterexamples: 3,
        engineGaps: 0,
        invalidProbes: 0,
      },
    },
  ],
};
