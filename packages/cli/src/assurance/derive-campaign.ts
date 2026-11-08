/**
 * Translates `runProbes` reproducible findings into `AssuranceDiagnostic[]`
 * (`certainty: 'proven-counterexample'`) and registers an executable,
 * single-dimension `AuthorizationCampaign` into `AssuranceCampaignStore`.
 */
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  parseResourcePattern,
  type AssuranceDiagnostic,
  type DiagnosticSeverity,
} from "pyric/sandbox/internal";
import type {
  FindingKind,
  Probe,
  ProbeActor,
  ProbeReport,
  ProbeResult,
} from "pyric/rules/internal/usage";
import {
  AuthorizationCampaign,
  createAuthorizationCampaign,
} from "./campaign.js";
import {
  applyStepToTargetState,
  buildPeerReplacements,
  defineOwn,
  getOwn,
  initializeTargetState,
  materializeDataValue,
  replaceIdentityDeep,
  stepToFirebaseOperation,
} from "./derive-campaign-state.js";
import type { LiveRuntimeClone, LoadedAssuranceProject } from "./derive-project.js";
import type { AssuranceCampaignStore } from "./tools.js";
import {
  ASSURANCE_TARGET_SCHEMA,
  type AssuranceProbe,
  type FirebaseOperation,
  type LocalFirebaseTarget,
  type SecurityInvariant,
} from "./types.js";
import { changedDimensions } from "./validation.js";

const CRITICAL_KINDS: ReadonlySet<FindingKind> = new Set([
  "foreign-slot-write",
  "foreign-update",
  "foreign-delete",
  "owner-forge-create",
  "owner-transfer",
  "metadata-owner-forge",
]);

function severityForKind(kind: FindingKind): DiagnosticSeverity {
  if (CRITICAL_KINDS.has(kind)) return "critical";
  return "high";
}

function remediationForKind(kind: FindingKind): string {
  if (kind === "foreign-slot-write") {
    return "Require request.auth.uid (or auth.uid) to match the path owner segment or verified scope membership.";
  }
  if (kind === "foreign-update") {
    return "Require the stored owner field to equal request.auth.uid (or auth.uid) on update.";
  }
  if (kind === "foreign-delete") {
    return "Require the stored owner field or path owner segment to equal request.auth.uid (or auth.uid) on delete.";
  }
  if (kind === "owner-forge-create") {
    return "Require incoming owner fields on create to equal request.auth.uid (or auth.uid).";
  }
  if (kind === "owner-transfer") {
    return "Enforce owner field immutability on update (request.resource.data.<owner> == resource.data.<owner>).";
  }
  if (kind === "metadata-owner-forge") {
    return "Require request.resource.metadata.<owner> == request.auth.uid on upload and preserve resource.metadata.<owner> on metadata update.";
  }
  if (kind === "attribution-spoof") {
    return "Bind incoming attribution fields to verified auth token claims.";
  }
  if (kind === "counter-integrity") {
    return "Restrict counter updates to bounded deltas relative to the stored value.";
  }
  return "Permit the authenticated owner's legitimate client operation in security rules or align client request metadata with rule constraints.";
}

function buildTargetRules(
  project: LoadedAssuranceProject,
  runtime: LiveRuntimeClone,
): LocalFirebaseTarget["rules"] {
  const rules: LocalFirebaseTarget["rules"] = {};

  const defaultFs = project.sources.firestore.find(
    (s) => s.database === undefined || s.database === DEFAULT_SNAPSHOT_RESOURCE,
  );
  if (defaultFs !== undefined) {
    rules.firestore = defaultFs.text;
  } else if (runtime.targetRules?.firestore !== undefined) {
    rules.firestore = runtime.targetRules.firestore;
  }

  const defaultRtdb = project.sources.rtdb.find(
    (s) => s.instance === undefined || s.instance === DEFAULT_SNAPSHOT_RESOURCE,
  );
  if (defaultRtdb !== undefined) {
    const firstRtdb = defaultRtdb.json;
    if (
      firstRtdb &&
      typeof firstRtdb === "object" &&
      Object.hasOwn(firstRtdb, "rules")
    ) {
      const inner = (firstRtdb as { rules?: unknown }).rules;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        rules.rtdb = { rules: inner as Record<string, unknown> };
      }
    }
  } else if (runtime.targetRules?.rtdb !== undefined) {
    rules.rtdb = runtime.targetRules.rtdb;
  }

  const mergedInstances: Record<string, { rules: Record<string, unknown> }> = {};
  if (runtime.targetRules?.rtdbInstances !== undefined) {
    for (const [instId, instRules] of Object.entries(runtime.targetRules.rtdbInstances)) {
      defineOwn(mergedInstances, instId, instRules);
    }
  }
  for (const [instId, instRules] of Object.entries(project.rtdbInstances)) {
    defineOwn(mergedInstances, instId, instRules);
  }
  for (const s of project.sources.rtdb) {
    if (s.instance !== undefined && s.instance !== DEFAULT_SNAPSHOT_RESOURCE) {
      const rawJson = s.json;
      if (rawJson && typeof rawJson === "object" && Object.hasOwn(rawJson, "rules")) {
        const inner = (rawJson as { rules?: unknown }).rules;
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          defineOwn(mergedInstances, s.instance, {
            rules: inner as Record<string, unknown>,
          });
        }
      }
    }
  }
  if (Object.keys(mergedInstances).length > 0) {
    rules.rtdbInstances = mergedInstances;
  }

  const storageSources = project.sources.storage ?? [];
  const defaultSt =
    storageSources.find(
      (s) => s.bucket === undefined || s.bucket === DEFAULT_SNAPSHOT_RESOURCE,
    ) ?? storageSources[0];
  if (defaultSt !== undefined) {
    rules.storage = defaultSt.text;
  } else if (runtime.targetRules?.storage !== undefined) {
    rules.storage = runtime.targetRules.storage;
  }

  return rules;
}

function hasExistingRecordAtPath(
  state: LocalFirebaseTarget["state"],
  service: Probe["service"],
  path: string,
): boolean {
  if (service === "firestore") {
    return Boolean(state.firestore && Object.hasOwn(state.firestore, path));
  }
  if (service === "storage") {
    return (state.storage ?? []).some((item) => item.path === path);
  }
  return false;
}

function isPayloadAbuseProbe(probe: Probe): boolean {
  if (
    probe.kind === "owner-forge-create" ||
    probe.kind === "owner-transfer" ||
    probe.kind === "attribution-spoof" ||
    probe.kind === "counter-integrity"
  ) {
    return true;
  }
  if (probe.kind === "metadata-owner-forge" && probe.op === "create") {
    return true;
  }
  if (probe.kind === "foreign-slot-write" && probe.attack.path === "") {
    return true;
  }
  return false;
}

interface BuiltCampaignProbe {
  readonly invariant: SecurityInvariant;
  readonly probe: AssuranceProbe;
}

function translateHitToCampaignProbe(
  result: ProbeResult,
  index: number,
  owner: ProbeActor,
  peer: ProbeActor,
  targetState: LocalFirebaseTarget["state"],
): BuiltCampaignProbe | null {
  const src = result.probe;
  if (src.expect !== "deny") return null;

  for (const seedStep of src.seed) {
    applyStepToTargetState(targetState, seedStep);
  }

  let actorId = "actor-peer";
  if (src.attack.actor === "owner") {
    actorId = "actor-owner";
  }

  const peerReplacements = buildPeerReplacements(src, owner, peer);
  for (const seedStep of src.seed) {
    if (src.attack.actor === "peer") {
      applyStepToTargetState(
        targetState,
        replaceIdentityDeep(seedStep, peerReplacements),
      );
    }
  }

  let controlOp: FirebaseOperation;
  let mutationOp: FirebaseOperation;

  if (isPayloadAbuseProbe(src)) {
    const isCreate =
      src.attack.method === "create" ||
      (src.service === "storage" && src.op === "create");

    if (isCreate) {
      let createPath = src.attack.path;
      if (hasExistingRecordAtPath(targetState, src.service, createPath)) {
        createPath = `${createPath}-create-${index + 1}`;
      }
      const adjustedAttack = { ...src.attack, path: createPath };
      mutationOp = stepToFirebaseOperation(adjustedAttack);
      const identityOnly: Array<readonly [string, string]> = [
        [owner.uid, peer.uid],
        [owner.email, peer.email],
        [owner.displayName, peer.displayName],
      ];
      controlOp = {
        ...replaceIdentityDeep(mutationOp, identityOnly),
        path: createPath,
      };
    } else {
      for (const setupStep of src.setup) {
        applyStepToTargetState(targetState, setupStep);
      }
      const existingDoc = getOwn(targetState.firestore, src.attack.path);
      mutationOp = stepToFirebaseOperation(src.attack, existingDoc);
      if (src.attack.actor === "owner" && src.setup.length > 0) {
        const baseData = materializeDataValue(src.setup[0]!.data ?? {}, existingDoc);
        if (
          mutationOp.service === "firestore" &&
          baseData &&
          typeof baseData === "object" &&
          !Array.isArray(baseData)
        ) {
          controlOp = {
            ...mutationOp,
            data: baseData as Record<string, unknown>,
          };
        } else if (mutationOp.service === "rtdb") {
          controlOp = { ...mutationOp, data: baseData };
        } else {
          controlOp = mutationOp;
        }
      } else {
        const identityOnly: Array<readonly [string, string]> = [
          [owner.uid, peer.uid],
          [owner.email, peer.email],
          [owner.displayName, peer.displayName],
        ];
        controlOp = replaceIdentityDeep(mutationOp, identityOnly);
      }
    }
  } else {
    for (const setupStep of src.setup) {
      applyStepToTargetState(targetState, setupStep);
      applyStepToTargetState(
        targetState,
        replaceIdentityDeep(setupStep, peerReplacements),
      );
    }
    const peerPath = replaceIdentityDeep(src.attack.path, peerReplacements);
    if (
      src.setup.length === 0 &&
      src.seed.length === 0 &&
      peerPath !== src.attack.path
    ) {
      const ownerDoc = getOwn(targetState.firestore, src.attack.path);
      if (
        src.service === "firestore" &&
        ownerDoc !== undefined &&
        targetState.firestore !== undefined
      ) {
        defineOwn(
          targetState.firestore,
          peerPath,
          replaceIdentityDeep(ownerDoc, peerReplacements),
        );
      } else if (src.service === "storage" && targetState.storage) {
        const ownerObj = targetState.storage.find(
          (item) => item.path === src.attack.path,
        );
        if (ownerObj) {
          targetState.storage.push({
            ...replaceIdentityDeep(ownerObj, peerReplacements),
            path: peerPath,
          });
        }
      }
    }
    const existingDoc = getOwn(targetState.firestore, src.attack.path);
    mutationOp = stepToFirebaseOperation(src.attack, existingDoc);
    controlOp = { ...mutationOp, path: peerPath };
  }

  const dims = changedDimensions(controlOp, mutationOp);
  if (dims.length !== 1) return null;
  const dimension = dims[0]!;

  let invService: SecurityInvariant["service"] = src.service;
  if (
    src.service === "storage" &&
    src.seed.some((step) => step.service === "firestore")
  ) {
    invService = "cross-service";
  }

  const invariantId = `inv-${src.id}`;
  const invariant: SecurityInvariant = {
    id: invariantId,
    statement: `Deny ${src.kind} on ${src.template} (${src.op})`,
    service: invService,
    expected: "DENY",
    source: "derived",
    confidence: "strong",
  };

  const probe: AssuranceProbe = {
    id: src.id,
    actorId,
    invariantId,
    control: controlOp,
    mutation: {
      dimension,
      description: src.evidence,
      operation: mutationOp,
    },
  };

  return { invariant, probe };
}

export async function populateDerivedCampaign(options: {
  campaignId: string;
  existingCampaign?: AuthorizationCampaign;
  store: AssuranceCampaignStore;
  project: LoadedAssuranceProject;
  runtime: LiveRuntimeClone;
  probeReport: ProbeReport;
}): Promise<{
  campaign: AuthorizationCampaign;
  registeredProbeIds: Set<string>;
}> {
  const { probeReport } = options;
  let owner: ProbeActor = {
    role: "owner",
    uid: "probe-owner",
    email: "probe-owner@example.test",
    displayName: "Probe Owner",
    token: { email_verified: true },
  };
  let peer: ProbeActor = {
    role: "peer",
    uid: "probe-peer",
    email: "probe-peer@example.test",
    displayName: "Probe Peer",
    token: { email_verified: true },
  };
  for (const actor of probeReport.actors) {
    if (actor.role === "owner") owner = actor;
    if (actor.role === "peer") peer = actor;
  }

  const targetRules = buildTargetRules(options.project, options.runtime);
  const targetState = initializeTargetState(
    options.runtime.snapshot,
    options.runtime.targetState,
    [owner, peer],
  );

  const builtProbes: BuiltCampaignProbe[] = [];
  const hits = probeReport.results.filter((r) => r.outcome === "hit");
  for (let i = 0; i < hits.length; i += 1) {
    const built = translateHitToCampaignProbe(
      hits[i]!,
      i,
      owner,
      peer,
      targetState,
    );
    if (built !== null) builtProbes.push(built);
  }

  const target: LocalFirebaseTarget = {
    schema: ASSURANCE_TARGET_SCHEMA,
    network: "forbid",
    rules: targetRules,
    state: targetState,
  };

  const campaignOpts: {
    id: string;
    target: LocalFirebaseTarget;
    context?: { attachment: NonNullable<LiveRuntimeClone["attachmentContext"]> };
    safety: { network: "forbid"; maxRuns: number };
  } = {
    id: options.campaignId,
    target,
    safety: {
      network: "forbid",
      maxRuns: Math.max(200, builtProbes.length * 10 + 50),
    },
  };
  if (options.runtime.attachmentContext !== undefined) {
    campaignOpts.context = { attachment: options.runtime.attachmentContext };
  }

  const campaign = createAuthorizationCampaign(campaignOpts);
  campaign.addActor({
    id: "actor-owner",
    acquisition: { kind: "fixture-user", uid: owner.uid },
  });
  campaign.addActor({
    id: "actor-peer",
    acquisition: { kind: "fixture-user", uid: peer.uid },
  });

  const registeredProbeIds = new Set<string>();
  for (const entry of builtProbes) {
    campaign.addInvariant(entry.invariant);
    campaign.addProbe(entry.probe);
    registeredProbeIds.add(entry.probe.id);
  }

  if (builtProbes.length > 0) {
    await campaign.run();
  }

  if (options.existingCampaign !== undefined) {
    options.store.replace(campaign);
  } else {
    options.store.create(campaign);
  }
  options.store.publish(campaign);

  return { campaign, registeredProbeIds };
}

export function buildCounterexampleDiagnostics(
  report: ProbeReport,
  campaignId: string,
  registeredProbeIds: ReadonlySet<string>,
): AssuranceDiagnostic[] {
  const actorsByRole = new Map<string, ProbeActor>();
  for (const actor of report.actors) {
    actorsByRole.set(actor.role, actor);
  }

  const diagnostics: AssuranceDiagnostic[] = [];
  for (const result of report.results) {
    if (result.outcome !== "hit") continue;
    const probe = result.probe;
    let resourceId = DEFAULT_SNAPSHOT_RESOURCE;
    if (probe.attack.resourceId !== undefined && probe.attack.resourceId.length > 0) {
      resourceId = probe.attack.resourceId;
    }
    const attacker = actorsByRole.get(probe.attack.actor);
    const witnessItem: Record<string, unknown> = {
      campaignId,
      probeId: probe.id,
      registeredInCampaign: registeredProbeIds.has(probe.id),
      kind: probe.kind,
      op: probe.op,
      operation: probe.attack,
    };
    if (attacker !== undefined) witnessItem.actorUid = attacker.uid;

    const base: AssuranceDiagnostic = {
      id: `${campaignId}:${probe.id}`,
      code: `assurance-${probe.kind}`,
      service: probe.service,
      resourceId,
      severity: severityForKind(probe.kind),
      certainty: "proven-counterexample",
      message: probe.evidence,
      resource: parseResourcePattern(
        probe.service,
        probe.template,
        probe.attack.resourceId,
      ),
      witness: [witnessItem],
      remediation: remediationForKind(probe.kind),
    };

    const firstSource = probe.sources[0];
    if (firstSource !== undefined) {
      diagnostics.push({ ...base, codeSite: { source: firstSource } });
    } else {
      diagnostics.push(base);
    }
  }
  return diagnostics;
}
