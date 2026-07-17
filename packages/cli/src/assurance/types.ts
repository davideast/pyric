export const ASSURANCE_CAMPAIGN_SCHEMA = "pyric.assurance.campaign.v1" as const;
export const ASSURANCE_TARGET_SCHEMA = "pyric.assurance.target.v1" as const;
export const ASSURANCE_REPORT_SCHEMA = "pyric.assurance.report.v1" as const;

export type AssuranceService = "firestore" | "rtdb" | "storage";
export type AssuranceDecision = "ALLOW" | "DENY" | "ERROR" | "UNSUPPORTED";

export interface AssuranceCoverageGap {
  service: AssuranceService | "auth" | "attachment";
  code: string;
  reason: string;
}

export interface AssuranceAttachmentSource {
  requestedUrl: string;
  origin: string;
  transport: "same-origin-shared-worker";
  readOnly: true;
  studioUrl: string;
}

export interface AssuranceAttachmentInventory {
  firestoreDocuments: number;
  rtdbPresent: boolean;
  authUsers: number;
  storageObjects: number;
}

export interface AssuranceCampaignContext {
  attachment?: {
    source: AssuranceAttachmentSource;
    inventory: AssuranceAttachmentInventory;
    coverageGaps: AssuranceCoverageGap[];
  };
}
export type MutationDimension = "path" | "query" | "payload" | "operation";

export interface AuthFixtureUser {
  uid: string;
  email?: string | null;
  password?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  customClaims?: Record<string, unknown>;
}

export interface StorageObjectFixture {
  path: string;
  dataBase64: string;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

export interface LocalFirebaseTarget {
  schema: typeof ASSURANCE_TARGET_SCHEMA;
  network: "forbid";
  rules: {
    firestore?: string;
    rtdb?: { rules: Record<string, unknown> };
    storage?: string;
  };
  state: {
    firestore?: Record<string, Record<string, unknown>>;
    rtdb?: unknown;
    storage?: StorageObjectFixture[];
    auth?: { users: AuthFixtureUser[] };
  };
}

export type ActorAcquisition =
  | { kind: "anonymous-request" }
  | { kind: "anonymous-account" }
  | { kind: "password"; email: string; password: string }
  | { kind: "fixture-user"; uid: string }
  | { kind: "synthetic"; uid: string; token?: Record<string, unknown> };

export interface AssuranceActor {
  id: string;
  acquisition: ActorAcquisition;
}

export interface SecurityInvariant {
  id: string;
  statement: string;
  service: AssuranceService | "cross-service";
  expected: "ALLOW" | "DENY";
  source: "declared" | "authored-test" | "captured" | "derived" | "agent";
  confidence: "authoritative" | "strong" | "tentative";
}

export interface FirestoreQueryConstraint {
  field: string;
  op:
    | "<"
    | "<="
    | "=="
    | "!="
    | ">="
    | ">"
    | "array-contains"
    | "in"
    | "not-in"
    | "array-contains-any";
  value: unknown;
}

export interface FirestoreOperation {
  service: "firestore";
  method: "get" | "list" | "create" | "set" | "merge" | "update" | "delete";
  path: string;
  data?: Record<string, unknown>;
  query?: {
    where?: FirestoreQueryConstraint[];
    orderBy?: Array<{ field: string; direction?: "asc" | "desc" }>;
    limit?: number;
  };
}

export interface RtdbOperation {
  service: "rtdb";
  method: "get" | "set" | "update" | "remove";
  path: string;
  data?: unknown;
  query?: {
    orderBy?:
      { kind: "child"; path: string } | { kind: "key" } | { kind: "value" };
    startAt?: { value: unknown; key?: string };
    startAfter?: { value: unknown; key?: string };
    endAt?: { value: unknown; key?: string };
    endBefore?: { value: unknown; key?: string };
    equalTo?: { value: unknown; key?: string };
    limitToFirst?: number;
    limitToLast?: number;
  };
}

export interface StorageOperation {
  service: "storage";
  method: "get" | "list" | "upload" | "updateMetadata" | "delete";
  path: string;
  dataBase64?: string;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

export type FirebaseOperation =
  FirestoreOperation | RtdbOperation | StorageOperation;

export interface ProbeMutation {
  dimension: MutationDimension;
  description: string;
  operation: FirebaseOperation;
}

/**
 * A conformance-graph node a probe leans on: a rules-language construct or a
 * compatibility-registry row, named by id. The probe declares what it needs;
 * the engine resolves the node's derived verdict against the graph at
 * qualification time (a probe never carries a status).
 */
export type CapabilityDependency =
  | { kind: 'construct'; id: string }
  | { kind: 'registry-row'; id: string };

export interface AssuranceProbe {
  id: string;
  actorId: string;
  invariantId: string;
  control: FirebaseOperation;
  mutation: ProbeMutation;
  /**
   * Graph nodes this probe's verdict depends on. Each is resolved live against
   * the conformance graph statuses: a node the graph derives non-`supported`
   * makes the engine abstain (engine-gap), and a node the graph does not model
   * is a campaign authoring error (invalid-probe).
   */
  requires?: CapabilityDependency[];
}

export interface AssuranceObservation {
  id: string;
  actorId: string;
  operation: FirebaseOperation;
  result: "ALLOW";
  source: "captured" | "authored" | "discovered";
  description?: string;
}

export interface MutationCandidate extends ProbeMutation {
  id?: string;
}

export interface ProposalInput {
  observationId: string;
  invariantId: string;
  mutations: MutationCandidate[];
}

export interface AuthorizationCampaignSpec {
  schema: typeof ASSURANCE_CAMPAIGN_SCHEMA;
  id: string;
  target: LocalFirebaseTarget;
  actors: AssuranceActor[];
  invariants: SecurityInvariant[];
  probes: AssuranceProbe[];
}

export interface ActorEvidence {
  actorId: string;
  acquisition: ActorAcquisition["kind"];
  reachability: "reachable" | "synthetic" | "unreachable";
  uid?: string;
  error?: string;
}

export interface AssuranceEventEvidence {
  id?: string;
  at?: number;
  kind?: string;
  service?: string;
  method?: string;
  op?: string;
  path?: string;
  result?: string;
  auth?: unknown;
  actor?: unknown;
  authLens?: unknown;
  reasons?: string[];
  origin?: unknown;
  request?: unknown;
  resourceBefore?: unknown;
  matchedRule?: unknown;
  evaluatedRule?: unknown;
  rules?: unknown;
}

export interface OperationEvidence {
  operation: FirebaseOperation;
  decision: AssuranceDecision;
  output?: unknown;
  error?: { code?: string; message: string };
  events: AssuranceEventEvidence[];
}

export interface StateDiff {
  changed: boolean;
  before: unknown;
  after: unknown;
}

export interface CapabilityRequirement {
  id: string;
  supported: boolean;
  reason: string;
}

export interface EngineQualification {
  engine: "pyric-local-sandboxes";
  supported: boolean;
  requirements: CapabilityRequirement[];
  /** How an unsupported qualification must be classified. Absent when the
   *  qualification is supported. `engine-gap` is the default abstention (a
   *  target-specific check failed, or a required graph node is derived
   *  non-supported); `invalid-probe` overrides it when the campaign names a
   *  graph node the engine does not know. */
  classification?: Extract<ProbeClassification, "engine-gap" | "invalid-probe">;
}

export type ProbeClassification =
  | "local-counterexample"
  | "candidate-signal"
  | "no-counterexample"
  | "engine-gap"
  | "invalid-probe";

export interface AssuranceProbeResult {
  campaignId: string;
  probeId: string;
  targetHash: string;
  actorEvidence: ActorEvidence;
  invariant: SecurityInvariant;
  mutationSpec: ProbeMutation;
  control: OperationEvidence;
  mutation: OperationEvidence;
  stateDiff?: StateDiff;
  qualification: EngineQualification;
  classification: ProbeClassification;
}

export interface AssuranceReportSummary {
  probes: number;
  controlsPassed: number;
  localCounterexamples: number;
  candidateSignals: number;
  noCounterexamples: number;
  engineGaps: number;
  invalidProbes: number;
}

export interface AuthorizationCampaignReport {
  schema: typeof ASSURANCE_REPORT_SCHEMA;
  campaignId: string;
  targetHash: string;
  localOnly: { network: "forbid"; engine: "pyric-local-sandboxes" };
  results: AssuranceProbeResult[];
  summary: AssuranceReportSummary;
}

export interface SecurityCase {
  schema: "pyric.assurance.case.v1";
  id: string;
  campaignId: string;
  actorId: string;
  invariant: SecurityInvariant;
  control: FirebaseOperation;
  mutation: ProbeMutation;
  expect: "ALLOW" | "DENY";
  qualification: EngineQualification;
}

export interface MinimizationResult {
  probeId: string;
  changed: boolean;
  removedPayloadFields: string[];
  probe: AssuranceProbe;
  result: AssuranceProbeResult;
}

export interface CampaignExport {
  schema: "pyric.assurance.export.v1";
  campaign: AuthorizationCampaignSpec;
  context?: AssuranceCampaignContext;
  observations: AssuranceObservation[];
  report?: AuthorizationCampaignReport;
  cases: SecurityCase[];
  verifications?: AuthorizationCampaignReport[];
}

/** Credential-free projection safe to hand to Studio visualization code. */
export interface AssuranceVisualizationSnapshot {
  schema: "pyric.assurance.visualization.v1";
  campaignId: string;
  context?: AssuranceCampaignContext;
  observations: AssuranceObservation[];
  probes: AssuranceProbe[];
  report?: AuthorizationCampaignReport;
  verifications?: AuthorizationCampaignReport[];
}

export class AssuranceInputError extends Error {
  readonly code = "ASSURANCE_INVALID_INPUT";
}
