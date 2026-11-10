import { getDatabase } from "pyric/database";
import { initializeSandbox, type SandboxEvent } from "pyric/sandbox";
import { resolveDatabaseInstance } from "pyric/sandbox/internal";
import { qualifyProbe, rulesLoadRefusal } from "./capabilities.js";
import {
  executeFirestore,
  executeRtdb,
  executeStorage,
} from "./runner-operations.js";
import {
  acquireActor,
  createRuntime,
  formatThrownMessage,
  readState,
  stableStringify,
  targetHash,
  type ActorRuntime,
} from "./runner-runtime.js";
import {
  ASSURANCE_REPORT_SCHEMA,
  type ActorEvidence,
  type AssuranceDecision,
  type AssuranceEventEvidence,
  type AssuranceProbe,
  type AssuranceProbeResult,
  type AuthorizationCampaignReport,
  type AuthorizationCampaignSpec,
  type FirebaseOperation,
  type LocalFirebaseTarget,
  type OperationEvidence,
  type ProbeClassification,
  type SecurityInvariant,
  type StateDiff,
} from "./types.js";
import { assertCampaign } from "./validation.js";

interface ExecutedOperation {
  actorEvidence: ActorEvidence;
  evidence: OperationEvidence;
  stateDiff: StateDiff;
}

function eventEvidence(events: SandboxEvent[]): AssuranceEventEvidence[] {
  return events.map((event): AssuranceEventEvidence => {
    const raw = event as unknown as Record<string, unknown>;
    const entry: AssuranceEventEvidence = {};
    if (typeof raw.id === "string") entry.id = raw.id;
    if (typeof raw.at === "number") entry.at = raw.at;
    if (typeof raw.kind === "string") entry.kind = raw.kind;
    if (typeof raw.service === "string") entry.service = raw.service;
    if (typeof raw.method === "string") entry.method = raw.method;
    if (typeof raw.op === "string") entry.op = raw.op;
    if (typeof raw.path === "string") entry.path = raw.path;
    if (typeof raw.result === "string") entry.result = raw.result;
    if (raw.auth !== undefined) entry.auth = raw.auth;
    if (raw.actor !== undefined) entry.actor = raw.actor;
    if (raw.authLens !== undefined) entry.authLens = raw.authLens;
    if (
      Array.isArray(raw.reasons) &&
      raw.reasons.every((item) => typeof item === "string")
    ) {
      entry.reasons = raw.reasons as string[];
    }
    if (raw.origin !== undefined) entry.origin = raw.origin;
    if (raw.request !== undefined) entry.request = raw.request;
    if (raw.resourceBefore !== undefined) {
      entry.resourceBefore = raw.resourceBefore;
    }
    if (event.kind === "request") {
      entry.queryProof = event.queryProof;
    }
    if (raw.matchedRule !== undefined) entry.matchedRule = raw.matchedRule;
    if (raw.evaluatedRule !== undefined) entry.evaluatedRule = raw.evaluatedRule;
    if (raw.rules !== undefined) entry.rules = raw.rules;
    return entry;
  });
}

function errorDecision(error: unknown): {
  decision: AssuranceDecision;
  error: { code?: string; message: string };
} {
  const code = (error as { code?: unknown } | null)?.code;
  const message = formatThrownMessage(error);
  let codeString: string | undefined;
  if (typeof code === "string") {
    codeString = code;
  }
  const messageDenied = /permission[-_ ]?denied|unauthorized/i.test(message);
  let codeDenied = false;
  if (codeString !== undefined) {
    codeDenied = /permission[-_ ]?denied|unauthorized/i.test(codeString);
  }
  let decision: AssuranceDecision = "ERROR";
  if (messageDenied || codeDenied) {
    decision = "DENY";
  }
  const detail: { code?: string; message: string } = { message };
  if (codeString) {
    detail.code = codeString;
  }
  return { decision, error: detail };
}

async function executeOperation(
  campaignId: string,
  probeId: string,
  phase: "control" | "mutation",
  target: LocalFirebaseTarget,
  actorRuntime: ActorRuntime,
  operation: FirebaseOperation,
): Promise<ExecutedOperation> {
  const runtime = await createRuntime(
    campaignId,
    probeId,
    phase,
    target,
    actorRuntime,
    operation.service,
  );
  const before = await readState(operation, runtime);
  const eventOffset = runtime.sandbox.history().length;
  let decision: AssuranceDecision = "ALLOW";
  let output: unknown;
  let failure: { code?: string; message: string } | undefined;
  try {
    if (operation.service === "firestore") {
      output = await executeFirestore(operation, runtime.firestore!, runtime);
    } else if (operation.service === "rtdb") {
      let db = runtime.rtdb!;
      if (operation.instance && operation.instance !== "default") {
        const instanceUrl = resolveDatabaseInstance(operation.instance)!.url;
        db = getDatabase(runtime.context, instanceUrl);
      }
      output = await executeRtdb(operation, db);
    } else {
      output = await executeStorage(operation, runtime.storage!);
    }
  } catch (error) {
    const result = errorDecision(error);
    decision = result.decision;
    failure = result.error;
  }
  const events = eventEvidence(runtime.sandbox.history().slice(eventOffset));
  const after = await readState(operation, runtime);
  const evidence: OperationEvidence = {
    operation,
    decision,
    events,
  };
  if (output !== undefined) evidence.output = output;
  if (failure !== undefined) evidence.error = failure;
  return {
    actorEvidence: runtime.actor.evidence,
    evidence,
    stateDiff: {
      changed: stableStringify(before) !== stableStringify(after),
      before,
      after,
    },
  };
}

function skippedEvidence(
  operation: FirebaseOperation,
  decision: AssuranceDecision,
): OperationEvidence {
  return { operation, decision, events: [] };
}

const READ_METHODS = new Set(["get", "list"]);

function hasReadImpact(
  operation: FirebaseOperation,
  output: unknown,
): boolean {
  if (output === undefined || output === null) return false;
  if (operation.method === "list") {
    if (Array.isArray(output)) return output.length > 0;
    if (typeof output === "object") {
      const listing = output as { items?: unknown[]; prefixes?: unknown[] };
      if (Array.isArray(listing.items) && Array.isArray(listing.prefixes)) {
        return listing.items.length > 0 || listing.prefixes.length > 0;
      }
    }
  }
  return true;
}

function classify(
  actor: ActorEvidence,
  invariant: SecurityInvariant,
  control: OperationEvidence,
  mutation: OperationEvidence,
  stateDiff: StateDiff,
): ProbeClassification {
  if (actor.reachability === "unreachable") return "invalid-probe";
  if (control.decision !== "ALLOW") return "invalid-probe";
  if (mutation.decision === "ERROR" || mutation.decision === "UNSUPPORTED") {
    return "invalid-probe";
  }
  if (mutation.decision === invariant.expected) return "no-counterexample";
  if (invariant.expected === "DENY" && mutation.decision === "ALLOW") {
    const isRead = READ_METHODS.has(mutation.operation.method);
    let hasImpact = stateDiff.changed;
    if (isRead) {
      hasImpact = hasReadImpact(mutation.operation, mutation.output);
    }
    const isAuthoritativeCounterexample =
      actor.reachability === "reachable" &&
      invariant.confidence !== "tentative" &&
      hasImpact;
    if (isAuthoritativeCounterexample) {
      return "local-counterexample";
    }
    return "candidate-signal";
  }
  return "candidate-signal";
}

function unreachableReachability(
  kind: ActorEvidence["acquisition"],
): ActorEvidence["reachability"] {
  if (kind === "synthetic") return "synthetic";
  return "unreachable";
}

async function runProbe(
  spec: AuthorizationCampaignSpec,
  probe: AssuranceProbe,
  hash: string,
): Promise<AssuranceProbeResult> {
  const actor = spec.actors.find((item) => item.id === probe.actorId)!;
  const invariant = spec.invariants.find(
    (item) => item.id === probe.invariantId,
  )!;
  const qualification = qualifyProbe(spec.target, probe);
  const refusal =
    rulesLoadRefusal(spec.target, probe.control.service) ??
    rulesLoadRefusal(spec.target, probe.mutation.operation.service);
  if (refusal !== undefined) {
    const error = { code: "rules-refused", message: refusal };
    return {
      campaignId: spec.id,
      probeId: probe.id,
      targetHash: hash,
      actorEvidence: {
        actorId: actor.id,
        acquisition: actor.acquisition.kind,
        reachability: unreachableReachability(actor.acquisition.kind),
      },
      invariant,
      mutationSpec: probe.mutation,
      control: { ...skippedEvidence(probe.control, "ERROR"), error },
      mutation: {
        ...skippedEvidence(probe.mutation.operation, "ERROR"),
        error,
      },
      qualification,
      classification: "invalid-probe",
    };
  }
  if (!qualification.supported) {
    return {
      campaignId: spec.id,
      probeId: probe.id,
      targetHash: hash,
      actorEvidence: {
        actorId: actor.id,
        acquisition: actor.acquisition.kind,
        reachability: unreachableReachability(actor.acquisition.kind),
      },
      invariant,
      mutationSpec: probe.mutation,
      control: skippedEvidence(probe.control, "UNSUPPORTED"),
      mutation: skippedEvidence(probe.mutation.operation, "UNSUPPORTED"),
      qualification,
      classification: qualification.classification ?? "engine-gap",
    };
  }

  const actorRuntime = acquireActor(initializeSandbox(), spec.target, actor);
  if (actorRuntime.evidence.reachability === "unreachable") {
    const error = {
      message: actorRuntime.evidence.error ?? "Actor acquisition failed.",
    };
    return {
      campaignId: spec.id,
      probeId: probe.id,
      targetHash: hash,
      actorEvidence: actorRuntime.evidence,
      invariant,
      mutationSpec: probe.mutation,
      control: { ...skippedEvidence(probe.control, "ERROR"), error },
      mutation: {
        ...skippedEvidence(probe.mutation.operation, "ERROR"),
        error,
      },
      qualification,
      classification: "invalid-probe",
    };
  }

  const control = await executeOperation(
    spec.id,
    probe.id,
    "control",
    spec.target,
    actorRuntime,
    probe.control,
  );
  const mutation = await executeOperation(
    spec.id,
    probe.id,
    "mutation",
    spec.target,
    actorRuntime,
    probe.mutation.operation,
  );
  return {
    campaignId: spec.id,
    probeId: probe.id,
    targetHash: hash,
    actorEvidence: control.actorEvidence,
    invariant,
    mutationSpec: probe.mutation,
    control: control.evidence,
    mutation: mutation.evidence,
    stateDiff: mutation.stateDiff,
    qualification,
    classification: classify(
      control.actorEvidence,
      invariant,
      control.evidence,
      mutation.evidence,
      mutation.stateDiff,
    ),
  };
}

function summarize(
  results: AssuranceProbeResult[],
): AuthorizationCampaignReport["summary"] {
  return {
    probes: results.length,
    controlsPassed: results.filter(
      (result) => result.control.decision === "ALLOW",
    ).length,
    localCounterexamples: results.filter(
      (result) => result.classification === "local-counterexample",
    ).length,
    candidateSignals: results.filter(
      (result) => result.classification === "candidate-signal",
    ).length,
    noCounterexamples: results.filter(
      (result) => result.classification === "no-counterexample",
    ).length,
    engineGaps: results.filter(
      (result) => result.classification === "engine-gap",
    ).length,
    invalidProbes: results.filter(
      (result) => result.classification === "invalid-probe",
    ).length,
  };
}

export async function runAuthorizationCampaign(
  spec: AuthorizationCampaignSpec,
): Promise<AuthorizationCampaignReport> {
  assertCampaign(spec);
  if (
    typeof globalThis.indexedDB === "undefined" &&
    spec.probes.some((probe) => probe.control.service === "storage")
  ) {
    const fake = await import("fake-indexeddb");
    Object.assign(globalThis, {
      indexedDB: fake.indexedDB,
      IDBKeyRange: fake.IDBKeyRange,
    });
  }
  const hash = targetHash(spec.target);
  const results: AssuranceProbeResult[] = [];
  for (const probe of spec.probes) {
    results.push(await runProbe(spec, probe, hash));
  }
  return {
    schema: ASSURANCE_REPORT_SCHEMA,
    campaignId: spec.id,
    targetHash: hash,
    localOnly: { network: "forbid", engine: "pyric-local-sandboxes" },
    results,
    summary: summarize(results),
  };
}
