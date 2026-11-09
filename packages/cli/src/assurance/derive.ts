/**
 * Tri-source assurance derivation (`deriveAssurance`):
 * combines static Tricorder passes (`staticQueryProofPass`, `storageContractPass`,
 * `coverageMatrixPass`, `checkRtdbIndexes`) with real-write `runProbes` execution
 * and registers a reproducible `AuthorizationCampaign` in `AssuranceCampaignStore`.
 */
import type { LocalSandbox } from "pyric/sandbox";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  sortAssuranceDiagnostics,
  type AssuranceDiagnostic,
  type DiagnosticCertainty,
  type DiagnosticSeverity,
} from "pyric/sandbox/internal";
import {
  checkRtdbIndexes,
  coverageMatrixPass,
  inferOwnerBindings,
  ownerConditionsFrom,
  rtdbIndexPass,
  runProbes,
  staticQueryProofPass,
  storageContractPass,
  type CoverageMatrixRuntimeInput,
  type ProbeUser,
  type RuleSources,
  type StorageContractPassConfig,
  type WorldState,
} from "pyric/rules/internal/usage";
import type { AssuranceAttachmentProvider } from "./attachment.js";
import { defineOwn } from "./derive-campaign-state.js";
import {
  buildCounterexampleDiagnostics,
  populateDerivedCampaign,
} from "./derive-campaign.js";
import {
  buildRuleSurfaceFromSources,
  cloneLiveRuntime,
  loadAssuranceProject,
  resolveDeriveRoot,
  targetRulesFromSnapshot,
  type LiveRuntimeClone,
  type LoadedAssuranceProject,
} from "./derive-project.js";
import {
  defaultAssuranceCampaignStore,
  type AssuranceCampaignStore,
} from "./tools.js";

export interface DeriveDiagnosticCounts {
  readonly total: number;
  readonly byCertainty: Readonly<Record<DiagnosticCertainty, number>>;
  readonly bySeverity: Readonly<Record<DiagnosticSeverity, number>>;
}

export interface DeriveAssuranceInput {
  readonly root?: string;
  readonly url?: string;
  readonly campaignId?: string;
  readonly includeStaticChecks?: boolean;
  readonly includeHeuristic?: boolean;
}

export interface DeriveAssuranceDeps {
  readonly store?: AssuranceCampaignStore;
  readonly sandbox?: LocalSandbox;
  readonly attachmentProvider?: AssuranceAttachmentProvider;
  readonly projectDir?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface DeriveAssuranceResult {
  readonly campaignId: string;
  readonly studioUrl?: string;
  readonly counts: DeriveDiagnosticCounts;
  readonly diagnostics: AssuranceDiagnostic[];
}

let derivedCampaignSequence = 0;

function mergeRuntimeFallbackRules(
  project: LoadedAssuranceProject,
  runtime: LiveRuntimeClone,
): LoadedAssuranceProject {
  const snapshotRules =
    runtime.snapshot !== undefined
      ? targetRulesFromSnapshot(runtime.snapshot)
      : undefined;
  const tr = runtime.targetRules ?? snapshotRules;
  if (!tr) return project;

  const firestore = [...project.sources.firestore];
  if (firestore.length === 0 && typeof tr.firestore === "string") {
    firestore.push({ source: "live:firestore.rules", text: tr.firestore });
  }

  const rtdb = [...project.sources.rtdb];
  const hasDefaultRtdb = rtdb.some(
    (s) => s.instance === undefined || s.instance === DEFAULT_SNAPSHOT_RESOURCE,
  );
  if (!hasDefaultRtdb && tr.rtdb !== undefined) {
    rtdb.push({ source: "live:database.rules.json", json: tr.rtdb });
  }

  const storage = [...(project.sources.storage ?? [])];
  const hasDefaultStorage = storage.some(
    (s) => s.bucket === undefined || s.bucket === DEFAULT_SNAPSHOT_RESOURCE,
  );
  if (!hasDefaultStorage && typeof tr.storage === "string") {
    storage.push({ source: "live:storage.rules", text: tr.storage });
  }
  const configuredBuckets = [...project.configuredBuckets];
  const mergedStorageBuckets = {
    ...(snapshotRules?.storageBuckets ?? {}),
    ...(tr.storageBuckets ?? {}),
  };
  for (const [bucketId, rulesText] of Object.entries(mergedStorageBuckets)) {
    if (!storage.some((s) => s.bucket === bucketId)) {
      storage.push({
        source: `live:storage:${bucketId}`,
        bucket: bucketId,
        text: rulesText,
      });
    }
    if (!configuredBuckets.includes(bucketId)) {
      configuredBuckets.push(bucketId);
    }
  }

  const mergedSources: RuleSources = {
    firestore,
    rtdb,
    storage,
    problems: [...project.sources.problems],
  };
  const mergedInstances = {
    ...(snapshotRules?.rtdbInstances ?? {}),
    ...(tr.rtdbInstances ?? {}),
    ...project.rtdbInstances,
  };
  const ruleSurface = buildRuleSurfaceFromSources(mergedSources, mergedInstances);

  return {
    ...project,
    sources: mergedSources,
    configuredBuckets,
    rtdbInstances: mergedInstances,
    ruleSurface,
  };
}

export function runStaticAssurancePasses(
  project: LoadedAssuranceProject,
  runtime?: LiveRuntimeClone,
): AssuranceDiagnostic[] {
  const diagnostics: AssuranceDiagnostic[] = [];

  if (project.sources.firestore.length > 0) {
    const fsRulesMap: Record<string, string> = {};
    const fsFilesMap: Record<string, string> = {};
    for (const fsSource of project.sources.firestore) {
      const dbId = fsSource.database ?? DEFAULT_SNAPSHOT_RESOURCE;
      defineOwn(fsRulesMap, dbId, fsSource.text);
      defineOwn(fsFilesMap, dbId, fsSource.source);
    }
    diagnostics.push(
      ...staticQueryProofPass(project.usage, {
        rules: fsRulesMap,
        rulesFile: fsFilesMap,
      }),
    );
  }

  const storageSources = project.sources.storage ?? [];
  if (storageSources.length > 0 || project.configuredBuckets.length > 0) {
    const storageConfig: {
      ruleSurface: LoadedAssuranceProject["ruleSurface"];
      configuredBuckets?: readonly string[];
      defaultBucket?: string;
    } = {
      ruleSurface: project.ruleSurface,
    };
    if (project.configuredBuckets.length > 0) {
      storageConfig.configuredBuckets = project.configuredBuckets;
    }
    if (project.defaultBucket !== undefined) {
      storageConfig.defaultBucket = project.defaultBucket;
    }
    diagnostics.push(
      ...storageContractPass(
        project.usage,
        storageConfig as StorageContractPassConfig,
      ),
    );
  }

  const rtdbReqs = rtdbIndexPass(project.usage).requirements;
  if (rtdbReqs.length > 0) {
    const rtdbRulesByInstance: Record<string, Record<string, unknown>> = {};
    for (const [instanceId, rulesObj] of Object.entries(project.rtdbInstances)) {
      defineOwn(rtdbRulesByInstance, instanceId, rulesObj);
    }
    for (const rtdbSource of project.sources.rtdb) {
      const instKey = rtdbSource.instance ?? DEFAULT_SNAPSHOT_RESOURCE;
      if (rtdbSource.json && typeof rtdbSource.json === "object") {
        defineOwn(
          rtdbRulesByInstance,
          instKey,
          rtdbSource.json as Record<string, unknown>,
        );
      }
    }
    for (const [instanceId, rulesObj] of Object.entries(rtdbRulesByInstance)) {
      const instReqs = rtdbReqs.filter((r) => r.resourceId === instanceId);
      if (instReqs.length > 0) {
        diagnostics.push(...checkRtdbIndexes(rulesObj, instReqs));
      }
    }
  }

  if (project.ruleSurface.entries.length > 0) {
    const runtimeInput: {
      snapshot?: NonNullable<LiveRuntimeClone["snapshot"]>;
      history?: LiveRuntimeClone["history"];
    } = {};
    if (runtime?.snapshot !== undefined) {
      runtimeInput.snapshot = runtime.snapshot;
    }
    if (runtime !== undefined && runtime.history.length > 0) {
      runtimeInput.history = runtime.history;
    }
    diagnostics.push(
      ...coverageMatrixPass(
        project.usage,
        project.ruleSurface,
        runtimeInput as CoverageMatrixRuntimeInput,
      ),
    );
  }

  return sortAssuranceDiagnostics(diagnostics);
}

export function summarizeDiagnosticCounts(
  diagnostics: readonly AssuranceDiagnostic[],
): DeriveDiagnosticCounts {
  const byCertainty: Record<DiagnosticCertainty, number> = {
    "proven-counterexample": 0,
    "static-proof": 0,
    heuristic: 0,
  };
  const bySeverity: Record<DiagnosticSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const d of diagnostics) {
    byCertainty[d.certainty] += 1;
    bySeverity[d.severity] += 1;
  }
  return {
    total: diagnostics.length,
    byCertainty,
    bySeverity,
  };
}

function buildProbeSeedInput(runtime: LiveRuntimeClone): {
  state?: WorldState;
  users?: ProbeUser[];
} {
  if (runtime.snapshot === undefined) return {};
  const state: WorldState = { snapshot: runtime.snapshot };
  const users: ProbeUser[] = runtime.snapshot.auth.users
    .filter((u) => u.disabled !== true)
    .map((u) => {
      const entry: ProbeUser = { uid: u.uid, emailVerified: u.emailVerified === true };
      if (u.email !== undefined) entry.email = u.email;
      if (u.displayName !== undefined) entry.displayName = u.displayName;
      if (u.customClaims !== undefined) {
        entry.customClaims = { ...u.customClaims };
      }
      return entry;
    });
  if (users.length === 1) {
    let syntheticPeerUid = "probe-peer";
    if (users[0]!.uid === syntheticPeerUid) {
      syntheticPeerUid = "probe-peer-2";
    }
    users.push({ uid: syntheticPeerUid, displayName: "Probe Peer" });
  }
  if (users.length > 0) {
    return { state, users };
  }
  return { state };
}

export async function deriveAssurance(
  input: DeriveAssuranceInput = {},
  deps: DeriveAssuranceDeps = {},
): Promise<DeriveAssuranceResult> {
  const store = deps.store ?? defaultAssuranceCampaignStore;
  const absRoot = resolveDeriveRoot(input.root, deps.projectDir);
  const diskProject = loadAssuranceProject(absRoot);

  const cloneOpts: {
    url?: string;
    campaignId?: string;
    store: AssuranceCampaignStore;
    sandbox?: LocalSandbox;
    attachmentProvider?: AssuranceAttachmentProvider;
    fetchImpl?: typeof fetch;
    projectDir?: string;
    configuredBuckets?: readonly string[];
    defaultBucket?: string;
  } = { store };
  if (input.url !== undefined) cloneOpts.url = input.url;
  if (input.campaignId !== undefined) cloneOpts.campaignId = input.campaignId;
  if (deps.sandbox !== undefined) cloneOpts.sandbox = deps.sandbox;
  if (deps.attachmentProvider !== undefined) {
    cloneOpts.attachmentProvider = deps.attachmentProvider;
  }
  if (deps.fetchImpl !== undefined) cloneOpts.fetchImpl = deps.fetchImpl;
  cloneOpts.projectDir = deps.projectDir ?? absRoot;
  if (diskProject.configuredBuckets.length > 0) {
    cloneOpts.configuredBuckets = diskProject.configuredBuckets;
  }
  if (diskProject.defaultBucket !== undefined) {
    cloneOpts.defaultBucket = diskProject.defaultBucket;
  }

  const runtime = await cloneLiveRuntime(cloneOpts);
  const project = mergeRuntimeFallbackRules(diskProject, runtime);

  const includeStatic = input.includeStaticChecks !== false;
  let staticDiagnostics: AssuranceDiagnostic[] = [];
  if (includeStatic) {
    staticDiagnostics = runStaticAssurancePasses(project, runtime);
  }

  const mutableSites = project.usage.operations.filter(
    (site) =>
      site.service === "storage" ||
      site.resourceId === undefined ||
      site.resourceId === DEFAULT_SNAPSHOT_RESOURCE,
  );
  const probeScopedSources: RuleSources = {
    firestore: project.sources.firestore.filter(
      (s) => s.database === undefined || s.database === DEFAULT_SNAPSHOT_RESOURCE,
    ),
    rtdb: project.sources.rtdb.filter(
      (s) => s.instance === undefined || s.instance === DEFAULT_SNAPSHOT_RESOURCE,
    ),
    storage: project.sources.storage ?? [],
    problems: project.sources.problems,
  };
  const conditions = ownerConditionsFrom(probeScopedSources);
  const ownerBindings = inferOwnerBindings(conditions, mutableSites);
  const seedInput = buildProbeSeedInput(runtime);

  const runProbesInput: {
    accessSites: typeof mutableSites;
    ownerBindings: typeof ownerBindings;
    conditions: typeof conditions;
    sources: typeof probeScopedSources;
    state?: WorldState;
    users?: ProbeUser[];
  } = {
    accessSites: mutableSites,
    ownerBindings,
    conditions,
    sources: probeScopedSources,
  };
  if (seedInput.state !== undefined) runProbesInput.state = seedInput.state;
  if (seedInput.users !== undefined) runProbesInput.users = seedInput.users;

  const probeReport = await runProbes(runProbesInput);

  let campaignId = `assurance-derive-${++derivedCampaignSequence}`;
  if (input.campaignId !== undefined && input.campaignId.trim().length > 0) {
    campaignId = input.campaignId;
  }

  const populateOpts: {
    campaignId: string;
    existingCampaign?: NonNullable<LiveRuntimeClone["existingCampaign"]>;
    store: AssuranceCampaignStore;
    project: LoadedAssuranceProject;
    runtime: LiveRuntimeClone;
    probeReport: typeof probeReport;
  } = {
    campaignId,
    store,
    project,
    runtime,
    probeReport,
  };
  if (runtime.existingCampaign !== undefined) {
    populateOpts.existingCampaign = runtime.existingCampaign;
  }

  const { campaign, registeredProbeIds } =
    await populateDerivedCampaign(populateOpts);

  const counterexampleDiagnostics = buildCounterexampleDiagnostics(
    probeReport,
    campaign.id,
    registeredProbeIds,
  );

  let combined = sortAssuranceDiagnostics([
    ...counterexampleDiagnostics,
    ...staticDiagnostics,
  ]);
  if (input.includeHeuristic === false) {
    combined = combined.filter((d) => d.certainty !== "heuristic");
  }
  const counts = summarizeDiagnosticCounts(combined);

  const result: {
    campaignId: string;
    studioUrl?: string;
    counts: DeriveDiagnosticCounts;
    diagnostics: AssuranceDiagnostic[];
  } = {
    campaignId: campaign.id,
    counts,
    diagnostics: combined,
  };

  if (runtime.studioUrl !== undefined) {
    const viewUrl = new URL(runtime.studioUrl);
    viewUrl.searchParams.set("campaign", campaign.id);
    result.studioUrl = viewUrl.toString();
  }

  return result;
}
