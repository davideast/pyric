/**
 * Target rules assembly and single-dimension `AssuranceProbe` translation
 * for `derive-campaign.ts`.
 */
import { join } from "node:path";
import { DEFAULT_SNAPSHOT_RESOURCE } from "pyric/sandbox/internal";
import {
  bundleRulesSource,
  isModularRulesSource,
  lowerModularRulesInMemory,
  type Probe,
  type ProbeActor,
  type ProbeResult,
} from "pyric/rules/internal/usage";
import {
  applyStepToTargetState,
  buildPeerReplacements,
  defineOwn,
  getOwn,
  isUnsafeObjectKey,
  materializeDataValue,
  replaceIdentityDeep,
  stepToFirebaseOperation,
} from "./derive-campaign-state.js";
import {
  targetRulesFromSnapshot,
  type LiveRuntimeClone,
  type LoadedAssuranceProject,
} from "./derive-project.js";
import type {
  AssuranceProbe,
  FirebaseOperation,
  LocalFirebaseTarget,
  SecurityInvariant,
} from "./types.js";
import { changedDimensions } from "./validation.js";

function bundleCampaignRulesString(
  source: string,
  rootDir: string,
  sourceFile: string,
  targetService: "cloud.firestore" | "firebase.storage",
): string {
  if (!isModularRulesSource(source)) return source;
  try {
    return bundleRulesSource(source, {
      filePath: join(rootDir, sourceFile),
      rootDir,
      sourceFile,
      targetService,
    });
  } catch {
    return lowerModularRulesInMemory(source, { sourceFile, targetService });
  }
}

export function buildTargetRules(
  project: LoadedAssuranceProject,
  runtime: LiveRuntimeClone,
): LocalFirebaseTarget["rules"] {
  const rules: LocalFirebaseTarget["rules"] = {};
  let snapshotRules: LocalFirebaseTarget["rules"] | undefined;
  if (runtime.snapshot !== undefined) {
    snapshotRules = targetRulesFromSnapshot(runtime.snapshot);
  }
  const effectiveRuntimeRules = runtime.targetRules ?? snapshotRules;

  const defaultFs = project.sources.firestore.find(
    (s) => s.database === undefined || s.database === DEFAULT_SNAPSHOT_RESOURCE,
  );
  if (defaultFs !== undefined) {
    rules.firestore = bundleCampaignRulesString(
      defaultFs.text,
      project.root,
      defaultFs.source || "firestore.rules",
      "cloud.firestore",
    );
  } else if (effectiveRuntimeRules?.firestore !== undefined) {
    rules.firestore = bundleCampaignRulesString(
      effectiveRuntimeRules.firestore,
      project.root,
      "firestore.rules",
      "cloud.firestore",
    );
  } else if (snapshotRules?.firestore !== undefined) {
    rules.firestore = bundleCampaignRulesString(
      snapshotRules.firestore,
      project.root,
      "firestore.rules",
      "cloud.firestore",
    );
  }

  const defaultRtdb = project.sources.rtdb.find(
    (s) => s.instance === undefined || s.instance === DEFAULT_SNAPSHOT_RESOURCE,
  );
  if (defaultRtdb !== undefined) {
    const firstRtdb = defaultRtdb.json;
    if (
      firstRtdb
      && typeof firstRtdb === "object"
      && Object.hasOwn(firstRtdb, "rules")
    ) {
      const inner = (firstRtdb as { rules?: unknown }).rules;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        rules.rtdb = { rules: inner as Record<string, unknown> };
      }
    }
  } else if (effectiveRuntimeRules?.rtdb !== undefined) {
    rules.rtdb = effectiveRuntimeRules.rtdb;
  } else if (snapshotRules?.rtdb !== undefined) {
    rules.rtdb = snapshotRules.rtdb;
  }

  const mergedInstances: Record<string, { rules: Record<string, unknown> }> = {};
  if (snapshotRules?.rtdbInstances !== undefined) {
    for (const [instId, instRules] of Object.entries(snapshotRules.rtdbInstances)) {
      defineOwn(mergedInstances, instId, instRules);
    }
  }
  if (effectiveRuntimeRules?.rtdbInstances !== undefined) {
    for (const [instId, instRules] of Object.entries(effectiveRuntimeRules.rtdbInstances)) {
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
  const storageBuckets: Record<string, string> = {};
  if (snapshotRules?.storageBuckets !== undefined) {
    for (const [bucketId, rulesText] of Object.entries(snapshotRules.storageBuckets)) {
      defineOwn(
        storageBuckets,
        bucketId,
        bundleCampaignRulesString(rulesText, project.root, "storage.rules", "firebase.storage"),
      );
    }
  }
  if (effectiveRuntimeRules?.storageBuckets !== undefined) {
    for (const [bucketId, rulesText] of Object.entries(effectiveRuntimeRules.storageBuckets)) {
      defineOwn(
        storageBuckets,
        bucketId,
        bundleCampaignRulesString(rulesText, project.root, "storage.rules", "firebase.storage"),
      );
    }
  }
  const isFirebaseDefaultBucketId = (bucketId: string): boolean =>
    project.defaultBucket !== undefined
    && bucketId === project.defaultBucket
    && (bucketId.endsWith(".firebasestorage.app") || bucketId.endsWith(".appspot.com"));
  for (const s of storageSources) {
    if (
      s.bucket !== undefined
      && s.bucket !== DEFAULT_SNAPSHOT_RESOURCE
      && !isFirebaseDefaultBucketId(s.bucket)
      && !isUnsafeObjectKey(s.bucket)
    ) {
      defineOwn(
        storageBuckets,
        s.bucket,
        bundleCampaignRulesString(
          s.text,
          project.root,
          s.source || "storage.rules",
          "firebase.storage",
        ),
      );
    }
  }
  if (Object.keys(storageBuckets).length > 0) {
    rules.storageBuckets = storageBuckets;
  }

  const defaultSt = storageSources.find(
    (s) =>
      s.bucket === undefined
      || s.bucket === DEFAULT_SNAPSHOT_RESOURCE
      || (project.defaultBucket !== undefined && s.bucket === project.defaultBucket),
  );
  if (defaultSt !== undefined) {
    rules.storage = bundleCampaignRulesString(
      defaultSt.text,
      project.root,
      defaultSt.source || "storage.rules",
      "firebase.storage",
    );
  } else if (effectiveRuntimeRules?.storage !== undefined) {
    rules.storage = bundleCampaignRulesString(
      effectiveRuntimeRules.storage,
      project.root,
      "storage.rules",
      "firebase.storage",
    );
  } else if (snapshotRules?.storage !== undefined) {
    rules.storage = bundleCampaignRulesString(
      snapshotRules.storage,
      project.root,
      "storage.rules",
      "firebase.storage",
    );
  }

  return rules;
}

function hasExistingRecordAtPath(
  state: LocalFirebaseTarget["state"],
  service: Probe["service"],
  path: string,
  resourceId?: string,
): boolean {
  if (service === "firestore") {
    return Boolean(state.firestore && Object.hasOwn(state.firestore, path));
  }
  if (service === "storage") {
    if (
      resourceId !== undefined
      && resourceId !== DEFAULT_SNAPSHOT_RESOURCE
      && !isUnsafeObjectKey(resourceId)
    ) {
      const named = getOwn(state.storageBuckets, resourceId) ?? [];
      return named.some((item) => item.path === path);
    }
    return (state.storage ?? []).some((item) => item.path === path);
  }
  return false;
}

function isPayloadAbuseProbe(probe: Probe): boolean {
  if (
    probe.kind === "owner-forge-create"
    || probe.kind === "owner-transfer"
    || probe.kind === "attribution-spoof"
    || probe.kind === "counter-integrity"
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

export interface BuiltCampaignProbe {
  readonly invariant: SecurityInvariant;
  readonly probe: AssuranceProbe;
}

export function translateHitToCampaignProbe(
  result: ProbeResult,
  index: number,
  owner: ProbeActor,
  peer: ProbeActor,
  targetState: LocalFirebaseTarget["state"],
  actorIdOverride?: string,
): BuiltCampaignProbe | null {
  const src = result.probe;
  if (src.expect !== "deny") return null;

  for (const seedStep of src.seed) {
    applyStepToTargetState(targetState, seedStep);
  }

  let actorId = actorIdOverride ?? "actor-peer";
  if (actorIdOverride === undefined && src.attack.actor === "owner") {
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
      src.attack.method === "create"
      || (src.service === "storage" && src.op === "create");

    if (isCreate) {
      let createPath = src.attack.path;
      if (
        hasExistingRecordAtPath(
          targetState,
          src.service,
          createPath,
          src.attack.resourceId,
        )
      ) {
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
          mutationOp.service === "firestore"
          && baseData
          && typeof baseData === "object"
          && !Array.isArray(baseData)
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
      src.setup.length === 0
      && src.seed.length === 0
      && peerPath !== src.attack.path
    ) {
      const ownerDoc = getOwn(targetState.firestore, src.attack.path);
      if (
        src.service === "firestore"
        && ownerDoc !== undefined
        && targetState.firestore !== undefined
      ) {
        defineOwn(
          targetState.firestore,
          peerPath,
          replaceIdentityDeep(ownerDoc, peerReplacements),
        );
      } else if (src.service === "storage") {
        let storageList = targetState.storage;
        if (
          src.attack.resourceId !== undefined
          && src.attack.resourceId !== DEFAULT_SNAPSHOT_RESOURCE
          && !isUnsafeObjectKey(src.attack.resourceId)
        ) {
          storageList = getOwn(targetState.storageBuckets, src.attack.resourceId);
        }
        if (storageList) {
          const ownerObj = storageList.find((item) => item.path === src.attack.path);
          if (ownerObj) {
            storageList.push({
              ...replaceIdentityDeep(ownerObj, peerReplacements),
              path: peerPath,
            });
          }
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
    src.service === "storage"
    && src.seed.some((step) => step.service === "firestore")
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
