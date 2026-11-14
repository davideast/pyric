/**
 * Translates `runProbes` reproducible findings and abstentions into
 * `AssuranceDiagnostic[]` and registers an executable, single-dimension
 * `AuthorizationCampaign` into `AssuranceCampaignStore`.
 */
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  parseResourcePattern,
  resolveDatabaseInstance,
  type AssuranceDiagnostic,
  type DiagnosticSeverity,
} from "pyric/sandbox/internal";
import type {
  FindingKind,
  ProbeActor,
  ProbeReport,
} from "pyric/rules/internal/usage";
import {
  AuthorizationCampaign,
  createAuthorizationCampaign,
} from "./campaign.js";
import { hasUnruledStorageObjects } from "./attachment-target-clone.js";
import {
  buildTargetRules,
  translateHitToCampaignProbe,
  type BuiltCampaignProbe,
} from "./derive-campaign-probes.js";
import {
  defineOwn,
  initializeTargetState,
} from "./derive-campaign-state.js";
import type {
  LiveRuntimeClone,
  LoadedAssuranceProject,
} from "./derive-project.js";
import type { AssuranceCampaignStore } from "./tools.js";
import {
  ASSURANCE_TARGET_SCHEMA,
  type AssuranceActor,
  type AssuranceCoverageGap,
  type LocalFirebaseTarget,
} from "./types.js";

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

function copyOwnRecordFields(
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(source)) {
    defineOwn(out, key, Object.getOwnPropertyDescriptor(source, key)?.value);
  }
  return out;
}

function stableTokenSignature(token: Readonly<Record<string, unknown>>): string {
  const keys = Object.getOwnPropertyNames(token).sort();
  const entries = keys.map((k) => [
    k,
    Object.getOwnPropertyDescriptor(token, k)?.value,
  ]);
  return JSON.stringify(entries);
}

function abstainedCoverageGaps(report: ProbeReport): AssuranceCoverageGap[] {
  const seen = new Set<string>();
  const gaps: AssuranceCoverageGap[] = [];
  for (const result of report.results) {
    if (result.abstained !== true) continue;
    const reason =
      result.reason
      ?? result.probe.inconclusiveOnDeny
      ?? "probe abstained due to inconclusive seed or runtime preconditions";
    const fullReason = `${result.probe.op} '${result.probe.template}': ${reason}`;
    const key = `${result.probe.service}|probe-inconclusive|${fullReason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({
      service: result.probe.service,
      code: "probe-inconclusive",
      reason: fullReason,
    });
  }
  return gaps;
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
  const enabledSeedUsers = (options.runtime.snapshot?.auth.users ?? []).filter(
    (u) => u.disabled !== true,
  );
  if (
    owner.uid === "probe-owner"
    && enabledSeedUsers.length > 0
    && !enabledSeedUsers.some((u) => u.uid === "probe-owner")
  ) {
    const first = enabledSeedUsers[0]!;
    const emailVerified = first.emailVerified === true;
    const token: Record<string, unknown> = { email_verified: emailVerified };
    if (first.customClaims !== undefined) {
      Object.assign(token, first.customClaims);
    }
    owner = {
      role: "owner",
      uid: first.uid,
      email: first.email ?? `${first.uid}@example.test`,
      displayName: first.displayName ?? first.uid,
      token,
    };
  }

  const targetRules = buildTargetRules(options.project, options.runtime);
  if (
    typeof globalThis.indexedDB === "undefined"
    && (targetRules.storage !== undefined || targetRules.storageBuckets !== undefined)
  ) {
    const fake = await import("fake-indexeddb");
    Object.assign(globalThis, {
      indexedDB: fake.indexedDB,
      IDBKeyRange: fake.IDBKeyRange,
    });
  }
  const targetState = initializeTargetState(
    options.runtime.snapshot,
    options.runtime.targetState,
    [owner, peer],
  );
  const runtimeProviders =
    options.runtime.targetState?.auth?.providers
    ?? options.runtime.snapshot?.auth.providers;
  if (
    runtimeProviders !== undefined
    && targetState.auth !== undefined
    && targetState.auth.providers === undefined
  ) {
    targetState.auth = {
      ...targetState.auth,
      providers: { ...runtimeProviders },
    };
  }
  if (targetState.rtdbInstances !== undefined) {
    if (targetRules.rtdbInstances === undefined) {
      Reflect.deleteProperty(targetState, "rtdbInstances");
    } else {
      const declaredResolved = new Set<string>();
      for (const instKey of Object.keys(targetRules.rtdbInstances)) {
        try {
          declaredResolved.add(resolveDatabaseInstance(instKey)!.name);
        } catch {
          // Leave malformed rule keys to target validation.
        }
      }
      const filteredRtdbInstances: Record<string, unknown> = {};
      for (const [instKey, instVal] of Object.entries(targetState.rtdbInstances)) {
        try {
          const resolvedName = resolveDatabaseInstance(instKey)!.name;
          if (declaredResolved.has(resolvedName)) {
            defineOwn(filteredRtdbInstances, instKey, instVal);
          }
        } catch {
          // Skip undeclared/invalid state instance key.
        }
      }
      if (Object.keys(filteredRtdbInstances).length > 0) {
        targetState.rtdbInstances = filteredRtdbInstances;
      } else {
        Reflect.deleteProperty(targetState, "rtdbInstances");
      }
    }
  }

  const seededUids = new Set<string>();
  for (const user of options.runtime.snapshot?.auth.users ?? []) {
    seededUids.add(user.uid);
  }
  for (const user of options.runtime.targetState?.auth?.users ?? []) {
    seededUids.add(user.uid);
  }
  const actorAcquisition = (
    actor: ProbeActor,
    forceSyntheticToken = false,
  ): AssuranceActor["acquisition"] => {
    if (forceSyntheticToken || (actor.synthetic === true && !seededUids.has(actor.uid))) {
      return { kind: "synthetic", uid: actor.uid, token: copyOwnRecordFields(actor.token) };
    }
    return { kind: "fixture-user", uid: actor.uid };
  };

  const registeredActors: AssuranceActor[] = [
    { id: "actor-owner", acquisition: actorAcquisition(owner) },
    { id: "actor-peer", acquisition: actorAcquisition(peer) },
  ];
  const actorIdByProfile = new Map<string, string>();
  actorIdByProfile.set(
    `owner|${owner.uid}|${stableTokenSignature(owner.token)}`,
    "actor-owner",
  );
  actorIdByProfile.set(
    `peer|${peer.uid}|${stableTokenSignature(peer.token)}`,
    "actor-peer",
  );
  let nextOwnerVariant = 2;
  let nextPeerVariant = 2;
  const resolveCampaignActorId = (actor: ProbeActor): string => {
    const profileKey = `${actor.role}|${actor.uid}|${stableTokenSignature(actor.token)}`;
    const existingId = actorIdByProfile.get(profileKey);
    if (existingId !== undefined) return existingId;
    let allocatedId = `actor-peer-${nextPeerVariant}`;
    if (actor.role === "owner") {
      allocatedId = `actor-owner-${nextOwnerVariant}`;
      nextOwnerVariant += 1;
    } else {
      nextPeerVariant += 1;
    }
    registeredActors.push({
      id: allocatedId,
      acquisition: actorAcquisition(actor, true),
    });
    actorIdByProfile.set(profileKey, allocatedId);
    return allocatedId;
  };

  const builtProbes: BuiltCampaignProbe[] = [];
  const hits = probeReport.results.filter((r) => r.outcome === "hit");
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i]!;
    const hitOwner = hit.actors?.[0] ?? owner;
    const hitPeer = hit.actors?.[1] ?? peer;
    let attacker = hitPeer;
    if (hit.probe.attack.actor === "owner") attacker = hitOwner;
    const hitActorId = resolveCampaignActorId(attacker);
    const built = translateHitToCampaignProbe(
      hit,
      i,
      hitOwner,
      hitPeer,
      targetState,
      hitActorId,
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
    context?: {
      attachment?: NonNullable<LiveRuntimeClone["attachmentContext"]>;
      coverageGaps?: AssuranceCoverageGap[];
    };
    safety: { network: "forbid"; maxRuns: number };
  } = {
    id: options.campaignId,
    target,
    safety: {
      network: "forbid",
      maxRuns: Math.max(200, builtProbes.length * 10 + 50),
    },
  };
  const extraGaps = abstainedCoverageGaps(probeReport);
  const populatedNamedBuckets = Object.entries(targetState.storageBuckets ?? {})
    .filter(([, list]) => list.length > 0)
    .map(([bucketKey]) => bucketKey);
  const existingHasStorageGap =
    options.runtime.attachmentContext?.coverageGaps.some(
      (g) => g.code === "storage-rules-unavailable",
    ) === true;
  if (
    options.runtime.snapshot !== undefined &&
    !existingHasStorageGap &&
    hasUnruledStorageObjects({
      defaultObjectCount: targetState.storage?.length ?? 0,
      populatedNamedBuckets,
      defaultStorageRules: targetRules.storage,
      storageBucketRules: targetRules.storageBuckets,
    })
  ) {
    extraGaps.push({
      service: "storage",
      code: "storage-rules-unavailable",
      reason:
        "The running sandbox has Storage objects but no explicit Storage rules source.",
    });
  }
  if (options.runtime.attachmentContext !== undefined) {
    const combinedGaps = [
      ...options.runtime.attachmentContext.coverageGaps,
      ...extraGaps,
    ];
    campaignOpts.context = {
      attachment: {
        ...options.runtime.attachmentContext,
        coverageGaps: combinedGaps,
      },
      coverageGaps: combinedGaps,
    };
  } else if (extraGaps.length > 0 && options.runtime.snapshot !== undefined) {
    let namedStorageCount = 0;
    for (const objs of Object.values(targetState.storageBuckets ?? {})) {
      namedStorageCount += objs.length;
    }
    const rtdbPresent =
      targetState.rtdb !== undefined
      || Object.keys(targetState.rtdbInstances ?? {}).length > 0;
    campaignOpts.context = {
      attachment: {
        source: {
          requestedUrl: "in-process://sandbox",
          origin: "in-process://sandbox",
          transport: "in-process-sandbox",
          readOnly: true,
          studioUrl: "",
        },
        inventory: {
          firestoreDocuments: Object.keys(targetState.firestore ?? {}).length,
          rtdbPresent,
          authUsers: targetState.auth?.users.length ?? 0,
          storageObjects: (targetState.storage?.length ?? 0) + namedStorageCount,
        },
        coverageGaps: extraGaps,
      },
      coverageGaps: extraGaps,
    };
  } else if (extraGaps.length > 0) {
    campaignOpts.context = { coverageGaps: extraGaps };
  }

  const campaign = createAuthorizationCampaign(campaignOpts);
  for (const actorSpec of registeredActors) {
    campaign.addActor(actorSpec);
  }

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
    const probe = result.probe;
    let resourceId = DEFAULT_SNAPSHOT_RESOURCE;
    if (probe.attack.resourceId !== undefined && probe.attack.resourceId.length > 0) {
      resourceId = probe.attack.resourceId;
    }
    const firstSource = probe.sources[0];

    if (result.outcome === "hit") {
      const attacker =
        result.actors?.find((a) => a.role === probe.attack.actor)
        ?? actorsByRole.get(probe.attack.actor);
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
      if (firstSource !== undefined) {
        diagnostics.push({ ...base, codeSite: { source: firstSource } });
      } else {
        diagnostics.push(base);
      }
      continue;
    }

    if (result.abstained === true) {
      const abstentionReason =
        result.reason
        ?? probe.inconclusiveOnDeny
        ?? "inconclusive under current seed or runtime preconditions";
      const base: AssuranceDiagnostic = {
        id: `${campaignId}:${probe.id}:inconclusive`,
        code: "assurance-probe-inconclusive",
        service: probe.service,
        resourceId,
        severity: "medium",
        certainty: "heuristic",
        message:
          `Assurance probe for ${probe.op} on '${probe.template}' abstained: ${abstentionReason}.`,
        resource: parseResourcePattern(
          probe.service,
          probe.template,
          probe.attack.resourceId,
        ),
        witness: [
          {
            campaignId,
            probeId: probe.id,
            kind: probe.kind,
            op: probe.op,
            reason: abstentionReason,
          },
        ],
        remediation:
          "Seed a representative fixture user/object or pass static metadata matching the rule contract so this operation can be verified deterministically.",
      };
      if (firstSource !== undefined) {
        diagnostics.push({ ...base, codeSite: { source: firstSource } });
      } else {
        diagnostics.push(base);
      }
    }
  }
  return diagnostics;
}
