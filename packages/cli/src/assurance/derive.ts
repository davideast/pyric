/**
 * Tri-source assurance derivation (`deriveAssurance`):
 * combines static Tricorder passes (`staticQueryProofPass`, `storageContractPass`,
 * `coverageMatrixPass`, `checkRtdbIndexes`) with real-write `runProbes` execution
 * and registers a reproducible `AuthorizationCampaign` in `AssuranceCampaignStore`.
 */
import type { LocalSandbox } from "pyric/sandbox";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  isDefaultDatabaseInstance,
  sortAssuranceDiagnostics,
  type AssuranceDiagnostic,
  type AssuranceService,
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
  type ProjectRuleProblem,
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
  let snapshotRules: ReturnType<typeof targetRulesFromSnapshot> | undefined;
  if (runtime.snapshot !== undefined) {
    snapshotRules = targetRulesFromSnapshot(runtime.snapshot);
  }
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

  const existingStorage = project.sources.storage ?? [];
  const storage = [...existingStorage];
  const hasDefaultStorage = storage.some(
    (s) =>
      s.bucket === undefined ||
      s.bucket === DEFAULT_SNAPSHOT_RESOURCE ||
      (project.defaultBucket !== undefined && s.bucket === project.defaultBucket),
  );
  if (!hasDefaultStorage && typeof tr.storage === "string") {
    storage.push({ source: "live:storage.rules", text: tr.storage });
  }
  const configuredBuckets = [...project.configuredBuckets];
  const mergedStorageBuckets: Record<string, string> = {};
  if (snapshotRules?.storageBuckets !== undefined) {
    Object.assign(mergedStorageBuckets, snapshotRules.storageBuckets);
  }
  if (tr.storageBuckets !== undefined) {
    Object.assign(mergedStorageBuckets, tr.storageBuckets);
  }
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
  const mergedInstances: Record<string, { rules: Record<string, unknown> }> = {};
  if (snapshotRules?.rtdbInstances !== undefined) {
    Object.assign(mergedInstances, snapshotRules.rtdbInstances);
  }
  if (tr.rtdbInstances !== undefined) {
    Object.assign(mergedInstances, tr.rtdbInstances);
  }
  Object.assign(mergedInstances, project.rtdbInstances);
  const ruleSurface = buildRuleSurfaceFromSources(mergedSources, mergedInstances);

  return {
    ...project,
    sources: mergedSources,
    configuredBuckets,
    rtdbInstances: mergedInstances,
    ruleSurface,
  };
}

function buildProjectProblemDiagnostics(
  project: LoadedAssuranceProject,
): AssuranceDiagnostic[] {
  const defaultService: AssuranceService =
    project.usage.operations[0]?.service ?? "firestore";
  const items: readonly ProjectRuleProblem[] =
    project.configProblems ??
    project.problems.map((p): ProjectRuleProblem => {
      const colonIdx = p.indexOf(": ");
      const source = colonIdx > 0 ? p.slice(0, colonIdx) : "firebase.json";
      return {
        source,
        message: p,
        isGlobalConfig: source === "firebase.json",
      };
    });

  const usedIds = new Set<string>();
  const out: AssuranceDiagnostic[] = [];
  for (const item of items) {
    const baseId = `invalid-rules-configuration:${item.source}`;
    let id = baseId;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${baseId}#${n}`)) n += 1;
      id = `${baseId}#${n}`;
    }
    usedIds.add(id);
    const service: AssuranceService = item.service ?? defaultService;
    out.push({
      id,
      code: "invalid-rules-configuration",
      service,
      resourceId: item.resourceId ?? DEFAULT_SNAPSHOT_RESOURCE,
      severity: "high",
      certainty: "static-proof",
      message: item.message,
      ruleSite: { source: item.source },
      remediation:
        "Fix firebase.json and ensure all referenced security rules files exist within the project root and contain valid syntax.",
    });
  }
  return out;
}

export function runStaticAssurancePasses(
  project: LoadedAssuranceProject,
  runtime?: LiveRuntimeClone,
): AssuranceDiagnostic[] {
  const diagnostics: AssuranceDiagnostic[] = [
    ...buildProjectProblemDiagnostics(project),
  ];

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
        sharedDefaultRules: project.sources.firestore.some(
          (s) => s.database === undefined,
        ),
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
    const defaultRtdbSuffixRe = /^[a-z0-9-]+-default-rtdb$/i;
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
      const instReqs = rtdbReqs.filter((r) => {
        if (r.resourceId === instanceId) return true;
        if (
          instanceId === DEFAULT_SNAPSHOT_RESOURCE &&
          !Object.hasOwn(rtdbRulesByInstance, r.resourceId) &&
          (isDefaultDatabaseInstance(r.resourceId, project.projectId) ||
            (project.projectId === undefined &&
              defaultRtdbSuffixRe.test(r.resourceId)))
        ) {
          return true;
        }
        return false;
      });
      if (instReqs.length > 0) {
        diagnostics.push(...checkRtdbIndexes(rulesObj, instReqs));
      }
    }
  }

  if (project.ruleSurface.entries.length > 0) {
    const runtimeInput: {
      snapshot?: NonNullable<LiveRuntimeClone["snapshot"]>;
      history?: LiveRuntimeClone["history"];
      defaultBucket?: string;
      projectId?: string;
    } = {};
    if (runtime?.snapshot !== undefined) {
      runtimeInput.snapshot = runtime.snapshot;
    }
    if (runtime !== undefined && runtime.history.length > 0) {
      runtimeInput.history = runtime.history;
    }
    if (project.defaultBucket !== undefined) {
      runtimeInput.defaultBucket = project.defaultBucket;
    }
    if (project.projectId !== undefined) {
      runtimeInput.projectId = project.projectId;
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
  return { state: { snapshot: runtime.snapshot } };
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
    projectId?: string;
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
  if (diskProject.projectId !== undefined) {
    cloneOpts.projectId = diskProject.projectId;
  }
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
  } else {
    staticDiagnostics = sortAssuranceDiagnostics(
      buildProjectProblemDiagnostics(project),
    );
  }

  const mutableSites = project.usage.operations.filter(
    (site) =>
      !site.admin &&
      (site.service === "storage" ||
        site.resourceId === undefined ||
        site.resourceId === DEFAULT_SNAPSHOT_RESOURCE),
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
  if (
    typeof globalThis.indexedDB === "undefined" &&
    (probeScopedSources.storage?.length ?? 0) > 0
  ) {
    const fake = await import("fake-indexeddb");
    Object.assign(globalThis, {
      indexedDB: fake.indexedDB,
      IDBKeyRange: fake.IDBKeyRange,
    });
  }
  const conditions = ownerConditionsFrom(probeScopedSources);
  let ownerBindingOptions: { defaultBucket: string } | undefined;
  if (project.defaultBucket !== undefined) {
    ownerBindingOptions = { defaultBucket: project.defaultBucket };
  }
  const ownerBindings = inferOwnerBindings(
    conditions,
    mutableSites,
    ownerBindingOptions,
  );
  const seedInput = buildProbeSeedInput(runtime);

  const runProbesInput: {
    accessSites: typeof mutableSites;
    ownerBindings: typeof ownerBindings;
    conditions: typeof conditions;
    sources: typeof probeScopedSources;
    state?: WorldState;
    users?: ProbeUser[];
    defaultBucket?: string;
  } = {
    accessSites: mutableSites,
    ownerBindings,
    conditions,
    sources: probeScopedSources,
  };
  if (seedInput.state !== undefined) runProbesInput.state = seedInput.state;
  if (seedInput.users !== undefined) runProbesInput.users = seedInput.users;
  if (project.defaultBucket !== undefined) {
    runProbesInput.defaultBucket = project.defaultBucket;
  }

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
