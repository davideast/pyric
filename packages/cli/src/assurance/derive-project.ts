/**
 * Project root containment, `SdkUsageIndex` + `RuleSurface` disk loading, and
 * non-destructive live sandbox cloning for `deriveAssurance`.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LocalSandbox } from "pyric/sandbox";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
  decodeBase64ToBytes,
  isDefaultDatabaseInstance,
  parseResourcePattern,
  type AssuranceService,
  type SandboxSnapshot,
  type SnapshotStorageObject,
} from "pyric/sandbox/internal";
import {
  bundleRulesSource,
  extractSdkUsage,
  loadDiskProject,
  loadRuleSources,
  parseRtdbRulesText,
  projectRuleSurface,
  validateRulesSourceSyntax,
  withEmbeddedRules,
  type FirestoreSurfaceSource,
  type ProjectRuleSurfaceInput,
  type RtdbSurfaceSource,
  type RuleSources,
  type RuleSurface,
  type SandboxHistoryEvent,
  type SdkUsageIndex,
  type StorageSurfaceSource,
} from "pyric/rules/internal/usage";
import { DEFAULT_BUCKET } from "pyric/storage/internal";
import { realProjectPathWithin } from "../bridge/surface/arguments/project-real-path.js";
import { failFor } from "../bridge/surface/method-validation.js";
import type { InvalidArguments } from "../bridge/surface/method-types.js";
import type { FirebaseRc } from "../cli/firebase-json.js";
import { resolveFirebaseProject } from "../cli/firebase-project.js";
import type { AssuranceAttachmentProvider } from "./attachment.js";
import type { AuthorizationCampaign } from "./campaign.js";
import { defineOwn, isUnsafeObjectKey } from "./derive-campaign-state.js";
import { cloneLoopbackSandboxHttp } from "./derive-live-http.js";
import type { AssuranceCampaignStore } from "./tools.js";
import {
  AssuranceInputError,
  type AssuranceCampaignContext,
  type LocalFirebaseTarget,
  type StorageObjectFixture,
} from "./types.js";

export interface ProjectRuleProblem {
  readonly source: string;
  readonly message: string;
  readonly service?: AssuranceService;
  readonly resourceId?: string;
  readonly isGlobalConfig?: boolean;
}

export interface LoadedAssuranceProject {
  readonly root: string;
  readonly usage: SdkUsageIndex;
  readonly sources: RuleSources;
  readonly ruleSurface: RuleSurface;
  readonly configuredBuckets: readonly string[];
  readonly defaultBucket: string | undefined;
  readonly rtdbInstances: Readonly<
    Record<string, { rules: Record<string, unknown> }>
  >;
  readonly problems: readonly string[];
  readonly configProblems?: readonly ProjectRuleProblem[];
}

export interface LiveRuntimeClone {
  readonly snapshot?: SandboxSnapshot;
  readonly history: readonly SandboxHistoryEvent[];
  readonly studioUrl?: string;
  readonly attachmentContext?: AssuranceCampaignContext["attachment"];
  readonly existingCampaign?: AuthorizationCampaign;
  readonly targetRules?: LocalFirebaseTarget["rules"];
  readonly targetState?: LocalFirebaseTarget["state"];
}

function hasResolvedPath(
  value: { path: string } | InvalidArguments,
): value is { path: string } {
  return Object.hasOwn(value, "path");
}

export function resolveDeriveRoot(
  rawRoot: string | undefined,
  projectDir: string | undefined,
): string {
  if (projectDir !== undefined) {
    let candidate = ".";
    if (rawRoot !== undefined && rawRoot.trim().length > 0) {
      candidate = rawRoot;
    }
    const checked = realProjectPathWithin(
      projectDir,
      candidate,
      "root",
      failFor("assurance", "derive"),
    );
    if (!hasResolvedPath(checked)) {
      throw new AssuranceInputError(checked.summary);
    }
    const lexicalPath = checked.path;
    if (!existsSync(lexicalPath)) {
      throw new AssuranceInputError(
        `Project root '${candidate}' does not exist.`,
      );
    }
    const st = lstatSync(lexicalPath);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new AssuranceInputError(
        `Project root '${candidate}' must be a non-symlink directory.`,
      );
    }
    return realpathSync(lexicalPath);
  }

  let base = process.cwd();
  if (rawRoot !== undefined && rawRoot.trim().length > 0) {
    base = resolve(rawRoot);
  }
  if (!existsSync(base)) {
    throw new AssuranceInputError(`Project root '${base}' does not exist.`);
  }
  const st = lstatSync(base);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new AssuranceInputError(
      `Project root '${base}' must be a non-symlink directory.`,
    );
  }
  return realpathSync(base);
}

interface ParsedFirebaseConfig {
  readonly configuredBuckets: string[];
  readonly defaultBucket: string | undefined;
  readonly rtdbInstances: Record<string, { rules: Record<string, unknown> }>;
  readonly hasFirestoreConfig: boolean;
  readonly hasDatabaseConfig: boolean;
  readonly hasStorageConfig: boolean;
  readonly hasInvalidFirebaseJson: boolean;
  readonly configuredRuleServices: Readonly<Record<string, AssuranceService>>;
}

function isWithinRootDir(baseDir: string, targetPath: string): boolean {
  const rel = relative(baseDir, targetPath);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (
    rel.startsWith(`..${sep}`) ||
    rel.startsWith("../") ||
    rel.startsWith("..\\")
  ) {
    return false;
  }
  return !isAbsolute(rel);
}

function isContainedNonSymlinkFile(
  absRoot: string,
  realRoot: string,
  candidatePath: string,
): boolean {
  if (!isWithinRootDir(absRoot, candidatePath)) return false;
  if (!existsSync(candidatePath)) return false;
  try {
    const st = lstatSync(candidatePath);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    const realTarget = realpathSync(candidatePath);
    return isWithinRootDir(realRoot, realTarget);
  } catch {
    return false;
  }
}

function readContainedJsonFile<T>(
  absRoot: string,
  realRoot: string,
  fileName: string,
): T | null {
  const filePath = resolve(absRoot, fileName);
  if (!isContainedNonSymlinkFile(absRoot, realRoot, filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function pathExistsIncludingBrokenSymlink(candidatePath: string): boolean {
  try {
    lstatSync(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeConfigRuleRel(absRoot: string, rawFile: string): string {
  const absFile = resolve(absRoot, rawFile);
  return relative(absRoot, absFile).split(sep).join("/");
}

function collectConfiguredRuleServices(
  absRoot: string,
  section: unknown,
  service: AssuranceService,
  into: Record<string, AssuranceService>,
): void {
  const entries = Array.isArray(section) ? section : [section];
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const rules = (item as { rules?: unknown }).rules;
    if (typeof rules === "string" && rules.length > 0) {
      defineOwn(into, normalizeConfigRuleRel(absRoot, rules), service);
    }
  }
}

function readFirebaseProjectConfig(absRoot: string): ParsedFirebaseConfig {
  let realRoot = absRoot;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    realRoot = absRoot;
  }

  const configuredBuckets: string[] = [];
  let defaultBucket: string | undefined;
  const rtdbInstances: Record<string, { rules: Record<string, unknown> }> = {};
  const configuredRuleServices: Record<string, AssuranceService> = {};

  const fbPath = resolve(absRoot, "firebase.json");
  const fbExists = pathExistsIncludingBrokenSymlink(fbPath);
  const raw = readContainedJsonFile<{
    firestore?: unknown;
    storage?: unknown;
    database?: unknown;
  }>(absRoot, realRoot, "firebase.json");

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      configuredBuckets,
      defaultBucket,
      rtdbInstances,
      hasFirestoreConfig: false,
      hasDatabaseConfig: false,
      hasStorageConfig: false,
      hasInvalidFirebaseJson: fbExists,
      configuredRuleServices,
    };
  }

  const hasFirestoreConfig =
    raw.firestore !== undefined && raw.firestore !== null;
  const hasDatabaseConfig = raw.database !== undefined && raw.database !== null;
  const hasStorageConfig = raw.storage !== undefined && raw.storage !== null;

  collectConfiguredRuleServices(absRoot, raw.firestore, "firestore", configuredRuleServices);
  collectConfiguredRuleServices(absRoot, raw.database, "rtdb", configuredRuleServices);
  collectConfiguredRuleServices(absRoot, raw.storage, "storage", configuredRuleServices);

  const rc = readContainedJsonFile<FirebaseRc>(absRoot, realRoot, ".firebaserc");
  const pyricCfg = readContainedJsonFile<{ project?: unknown }>(
    absRoot,
    realRoot,
    "pyric.json",
  );
  const configProject =
    typeof pyricCfg?.project === "string" && pyricCfg.project.trim().length > 0
      ? pyricCfg.project.trim()
      : undefined;
  const resolveInput: {
    projectDir: string;
    configProject?: string;
    rc: FirebaseRc | null;
  } = { projectDir: absRoot, rc };
  if (configProject !== undefined) {
    resolveInput.configProject = configProject;
  }
  const projectId = resolveFirebaseProject(resolveInput).projectId;

  const projectTargets =
    projectId !== undefined &&
    rc?.targets !== undefined &&
    Object.hasOwn(rc.targets, projectId)
      ? rc.targets[projectId]
      : undefined;

  try {
    let storageEntries: unknown[] = [];
    if (Array.isArray(raw.storage)) {
      storageEntries = raw.storage;
    } else if (raw.storage && typeof raw.storage === "object") {
      storageEntries = [raw.storage];
    }
    let hasUnnamedStorageEntry = false;
    for (const item of storageEntries) {
      if (!item || typeof item !== "object") continue;
      const entry = item as { bucket?: unknown; target?: unknown };
      if (typeof entry.target === "string" && entry.target.trim().length > 0) {
        const storageTargets = projectTargets?.storage;
        const mapped =
          storageTargets && Object.hasOwn(storageTargets, entry.target.trim())
            ? storageTargets[entry.target.trim()]
            : undefined;
        if (Array.isArray(mapped)) {
          for (const bucket of mapped) {
            if (typeof bucket === "string" && bucket.trim().length > 0) {
              const normalized = parseResourcePattern(
                "storage",
                "object",
                bucket,
              ).resourceId;
              if (!configuredBuckets.includes(normalized)) {
                configuredBuckets.push(normalized);
              }
            }
          }
        }
        continue;
      }
      if (typeof entry.bucket === "string" && entry.bucket.trim().length > 0) {
        const normalized = parseResourcePattern(
          "storage",
          "object",
          entry.bucket,
        ).resourceId;
        if (!configuredBuckets.includes(normalized)) {
          configuredBuckets.push(normalized);
        }
      } else {
        hasUnnamedStorageEntry = true;
      }
    }
    if (!hasUnnamedStorageEntry) {
      defaultBucket =
        configuredBuckets.find((b) => isFirebaseDefaultBucketName(b, projectId)) ??
        (configuredBuckets.length === 1 ? configuredBuckets[0] : undefined);
    }

    let databaseEntries: unknown[] = [];
    if (Array.isArray(raw.database)) {
      databaseEntries = raw.database;
    } else if (raw.database && typeof raw.database === "object") {
      databaseEntries = [raw.database];
    }

    for (const item of databaseEntries) {
      if (!item || typeof item !== "object") continue;
      const entry = item as {
        instance?: unknown;
        target?: unknown;
        rules?: unknown;
      };
      if (typeof entry.rules !== "string" || entry.rules.trim().length === 0) {
        continue;
      }
      const instanceNames: string[] = [];
      if (typeof entry.target === "string" && entry.target.trim().length > 0) {
        const dbTargets = projectTargets?.database;
        const mapped =
          dbTargets && Object.hasOwn(dbTargets, entry.target.trim())
            ? dbTargets[entry.target.trim()]
            : undefined;
        if (Array.isArray(mapped)) {
          for (const candidate of mapped) {
            if (typeof candidate === "string" && candidate.trim().length > 0) {
              instanceNames.push(candidate.trim());
            }
          }
        }
      } else if (
        typeof entry.instance === "string" &&
        entry.instance.length > 0
      ) {
        instanceNames.push(entry.instance);
      }
      if (instanceNames.length === 0) continue;

      const rulesPath = resolve(absRoot, entry.rules);
      if (!isContainedNonSymlinkFile(absRoot, realRoot, rulesPath)) continue;

      const parsedRtdb = parseRtdbRulesText(readFileSync(rulesPath, "utf8"));
      if (
        parsedRtdb &&
        typeof parsedRtdb === "object" &&
        Object.hasOwn(parsedRtdb, "rules")
      ) {
        const rulesObj = (parsedRtdb as { rules?: unknown }).rules;
        if (rulesObj && typeof rulesObj === "object" && !Array.isArray(rulesObj)) {
          for (const instName of instanceNames) {
            if (
              instName === DEFAULT_SNAPSHOT_RESOURCE ||
              isUnsafeObjectKey(instName) ||
              isDefaultDatabaseInstance(instName, projectId) ||
              (projectId === undefined && DEFAULT_RTDB_SUFFIX_RE.test(instName))
            ) {
              continue;
            }
            defineOwn(rtdbInstances, instName, {
              rules: rulesObj as Record<string, unknown>,
            });
          }
        }
      }
    }
  } catch {
    return {
      configuredBuckets,
      defaultBucket,
      rtdbInstances,
      hasFirestoreConfig,
      hasDatabaseConfig,
      hasStorageConfig,
      hasInvalidFirebaseJson: false,
      configuredRuleServices,
    };
  }

  return {
    configuredBuckets,
    defaultBucket,
    rtdbInstances,
    hasFirestoreConfig,
    hasDatabaseConfig,
    hasStorageConfig,
    hasInvalidFirebaseJson: false,
    configuredRuleServices,
  };
}

const DEFAULT_RTDB_SUFFIX_RE = /^[a-z0-9-]+-default-rtdb$/i;

function isFirebaseDefaultBucketName(
  bucketId: string,
  projectId: string | undefined,
): boolean {
  if (projectId === undefined || projectId.length === 0) return false;
  return (
    bucketId === `${projectId}.firebasestorage.app` ||
    bucketId === `${projectId}.appspot.com`
  );
}

export function buildRuleSurfaceFromSources(
  sources: RuleSources,
  rtdbInstances: Readonly<Record<string, { rules: Record<string, unknown> }>>,
): RuleSurface {
  const firestore: FirestoreSurfaceSource[] = sources.firestore.map((s) => {
    const item: { source: string; text: string; databaseId?: string } = {
      source: s.source,
      text: s.text,
    };
    if (s.database !== undefined) item.databaseId = s.database;
    return item;
  });

  const seenRtdbInstances = new Set<string>();
  const rtdb: RtdbSurfaceSource[] = sources.rtdb.map((s) => {
    const item: { source: string; json: unknown; instance?: string } = {
      source: s.source,
      json: s.json,
    };
    if (s.instance !== undefined) {
      item.instance = s.instance;
      seenRtdbInstances.add(s.instance);
    }
    return item;
  });
  for (const [instanceId, wrapper] of Object.entries(rtdbInstances)) {
    if (seenRtdbInstances.has(instanceId)) continue;
    rtdb.push({
      source: `instance:${instanceId}`,
      json: wrapper,
      instance: instanceId,
    });
  }

  const storage: StorageSurfaceSource[] = (sources.storage ?? []).map((s) => {
    const item: { source: string; text: string; bucket?: string } = {
      source: s.source,
      text: s.text,
    };
    if (s.bucket !== undefined) item.bucket = s.bucket;
    return item;
  });

  const surfaceInput: {
    firestore?: readonly FirestoreSurfaceSource[];
    rtdb?: readonly RtdbSurfaceSource[];
    storage?: readonly StorageSurfaceSource[];
  } = {};
  if (firestore.length > 0) surfaceInput.firestore = firestore;
  if (rtdb.length > 0) surfaceInput.rtdb = rtdb;
  if (storage.length > 0) surfaceInput.storage = storage;

  return projectRuleSurface(surfaceInput satisfies ProjectRuleSurfaceInput);
}

function classifyRuleProblem(
  problemText: string,
  configuredServices: Readonly<Record<string, AssuranceService>>,
): ProjectRuleProblem {
  const colonIdx = problemText.indexOf(": ");
  const source = colonIdx > 0 ? problemText.slice(0, colonIdx) : "firebase.json";
  if (source === "firebase.json") {
    return {
      source,
      message: problemText,
      isGlobalConfig: true,
    };
  }
  let service: AssuranceService | undefined = Object.hasOwn(configuredServices, source)
    ? configuredServices[source]
    : undefined;
  if (service === undefined) {
    if (source.endsWith(".json")) {
      service = "rtdb";
    } else if (
      source.includes("storage") ||
      problemText.includes("firebase.storage")
    ) {
      service = "storage";
    } else {
      service = "firestore";
    }
  }
  return {
    source,
    message: problemText,
    service,
    resourceId: DEFAULT_SNAPSHOT_RESOURCE,
  };
}

export function loadAssuranceProject(absRoot: string): LoadedAssuranceProject {
  const diskLoaded = loadDiskProject(["."], absRoot);
  let usage: SdkUsageIndex;
  const problems: string[] = [];

  if (diskLoaded.ok) {
    const memoryFiles: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const cfg of diskLoaded.configs) {
      memoryFiles[cfg.name] = cfg.source;
    }
    for (const entry of diskLoaded.files) {
      memoryFiles[entry.name] = entry.source;
    }
    usage = extractSdkUsage({
      root: diskLoaded.root,
      files: memoryFiles,
      clientRoots: diskLoaded.clientRoots,
      includeReads: true,
    });
  } else {
    usage = extractSdkUsage({ root: absRoot, files: {} });
    if (!diskLoaded.message.includes("No TypeScript or JavaScript source files")) {
      problems.push(diskLoaded.message);
    }
  }

  let realRoot = absRoot;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    realRoot = absRoot;
  }
  const fbConfig = readFirebaseProjectConfig(absRoot);
  const loadedRules = loadRuleSources(absRoot);
  if (
    fbConfig.hasInvalidFirebaseJson &&
    !loadedRules.problems.some((p) => p.startsWith("firebase.json:"))
  ) {
    loadedRules.problems.push(
      "firebase.json: invalid or unreadable Firebase project configuration",
    );
  }

  if (
    !fbConfig.hasInvalidFirebaseJson &&
    loadedRules.firestore.length === 0 &&
    !fbConfig.hasFirestoreConfig
  ) {
    const convFs = join(absRoot, "firestore.rules");
    if (isContainedNonSymlinkFile(absRoot, realRoot, convFs)) {
      try {
        loadedRules.firestore.push({
          source: "firestore.rules",
          text: bundleRulesSource(readFileSync(convFs, "utf8"), {
            filePath: convFs,
            rootDir: absRoot,
            sourceFile: "firestore.rules",
            targetService: "cloud.firestore",
          }),
        });
      } catch (err) {
        let msg = String(err);
        if (err instanceof Error) msg = err.message;
        loadedRules.problems.push(`firestore.rules: ${msg}`);
      }
    }
  }
  if (
    !fbConfig.hasInvalidFirebaseJson &&
    loadedRules.rtdb.length === 0 &&
    !fbConfig.hasDatabaseConfig
  ) {
    const convRtdb = join(absRoot, "database.rules.json");
    if (isContainedNonSymlinkFile(absRoot, realRoot, convRtdb)) {
      try {
        loadedRules.rtdb.push({
          source: "database.rules.json",
          json: parseRtdbRulesText(readFileSync(convRtdb, "utf8")),
        });
      } catch (err) {
        let msg = String(err);
        if (err instanceof Error) msg = err.message;
        loadedRules.problems.push(`database.rules.json: ${msg}`);
      }
    }
  }
  if (
    !fbConfig.hasInvalidFirebaseJson &&
    (loadedRules.storage?.length ?? 0) === 0 &&
    !fbConfig.hasStorageConfig
  ) {
    const convSt = join(absRoot, "storage.rules");
    if (isContainedNonSymlinkFile(absRoot, realRoot, convSt)) {
      try {
        if (!loadedRules.storage) loadedRules.storage = [];
        loadedRules.storage.push({
          source: "storage.rules",
          text: bundleRulesSource(readFileSync(convSt, "utf8"), {
            filePath: convSt,
            rootDir: absRoot,
            sourceFile: "storage.rules",
            targetService: "firebase.storage",
          }),
        });
      } catch (err) {
        let msg = String(err);
        if (err instanceof Error) msg = err.message;
        loadedRules.problems.push(`storage.rules: ${msg}`);
      }
    }
  }

  loadedRules.firestore = loadedRules.firestore.filter((entry) => {
    const syntax = validateRulesSourceSyntax(entry.text, "cloud.firestore", {
      sourceFile: entry.source,
      targetService: "cloud.firestore",
    });
    if (!syntax.ok) {
      loadedRules.problems.push(`${entry.source}: ${syntax.message}`);
      return false;
    }
    return true;
  });

  if (loadedRules.storage !== undefined) {
    loadedRules.storage = loadedRules.storage.filter((entry) => {
      const syntax = validateRulesSourceSyntax(entry.text, "firebase.storage", {
        sourceFile: entry.source,
        targetService: "firebase.storage",
      });
      if (!syntax.ok) {
        loadedRules.problems.push(`${entry.source}: ${syntax.message}`);
        return false;
      }
      return true;
    });
  }

  loadedRules.rtdb = loadedRules.rtdb.filter((entry) => {
    if (
      !entry.json ||
      typeof entry.json !== "object" ||
      Array.isArray(entry.json)
    ) {
      loadedRules.problems.push(
        `${entry.source}: RTDB rules file must contain a JSON object`,
      );
      return false;
    }
    return true;
  });

  const sources = withEmbeddedRules(loadedRules, [...usage.embeddedRules]);
  problems.push(...sources.problems);
  const configProblems = problems.map((p) =>
    classifyRuleProblem(p, fbConfig.configuredRuleServices),
  );

  const ruleSurface = buildRuleSurfaceFromSources(sources, fbConfig.rtdbInstances);

  return {
    root: absRoot,
    usage,
    sources,
    ruleSurface,
    configuredBuckets: fbConfig.configuredBuckets,
    defaultBucket: fbConfig.defaultBucket,
    rtdbInstances: fbConfig.rtdbInstances,
    problems,
    configProblems,
  };
}

function historyEventsFromSandbox(sandbox: LocalSandbox): SandboxHistoryEvent[] {
  return [...sandbox.history()];
}

function toSnapshotStorageObjects(
  fixtures: readonly StorageObjectFixture[],
): SnapshotStorageObject[] {
  return fixtures.map((item) => {
    const snap: {
      path: string;
      contentBase64: string;
      size: number;
      contentType?: string;
      customMetadata?: Record<string, string>;
    } = {
      path: item.path,
      contentBase64: item.dataBase64,
      size: decodeBase64ToBytes(item.dataBase64).byteLength,
    };
    if (item.contentType !== undefined) snap.contentType = item.contentType;
    if (item.customMetadata !== undefined) {
      snap.customMetadata = { ...item.customMetadata };
    }
    return snap;
  });
}

export function targetRulesFromSnapshot(
  snapshot: SandboxSnapshot,
): LocalFirebaseTarget["rules"] {
  const rules: LocalFirebaseTarget["rules"] = {};
  const defaultFs = snapshot.rules.firestore?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (typeof defaultFs === "string" && defaultFs.trim().length > 0) {
    rules.firestore = defaultFs;
  }

  const rtdbInstances: Record<string, { rules: Record<string, unknown> }> = {};
  for (const [instKey, rawJson] of Object.entries(snapshot.rules.rtdb ?? {})) {
    if (isUnsafeObjectKey(instKey)) continue;
    try {
      const parsed = parseRtdbRulesText(rawJson);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.hasOwn(parsed, "rules")
      ) {
        const inner = (parsed as { rules?: unknown }).rules;
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          const wrapper = { rules: { ...(inner as Record<string, unknown>) } };
          if (instKey === DEFAULT_SNAPSHOT_RESOURCE) {
            rules.rtdb = wrapper;
          } else {
            defineOwn(rtdbInstances, instKey, wrapper);
          }
        }
      }
    } catch {
      // Ignore unparseable snapshot RTDB rule text.
    }
  }
  if (Object.keys(rtdbInstances).length > 0) {
    rules.rtdbInstances = rtdbInstances;
  }

  const storageBuckets: Record<string, string> = {};
  for (const [bucketKey, rawSource] of Object.entries(
    snapshot.rules.storage ?? {},
  )) {
    if (typeof rawSource !== "string" || rawSource.trim().length === 0) {
      continue;
    }
    const normalized = parseResourcePattern("storage", "object", bucketKey).resourceId;
    if (isUnsafeObjectKey(normalized)) continue;
    if (normalized === DEFAULT_SNAPSHOT_RESOURCE || normalized === DEFAULT_BUCKET) {
      if (rules.storage === undefined) {
        rules.storage = rawSource;
      }
    } else {
      defineOwn(storageBuckets, normalized, rawSource);
    }
  }
  if (Object.keys(storageBuckets).length > 0) {
    rules.storageBuckets = storageBuckets;
  }

  return rules;
}

function snapshotFromTarget(target: LocalFirebaseTarget): SandboxSnapshot {
  const firestoreDocs: Record<string, Record<string, unknown>> = {};
  for (const [docPath, fields] of Object.entries(target.state.firestore ?? {})) {
    defineOwn(firestoreDocs, docPath, { ...fields });
  }

  const rtdbMap: Record<string, unknown> = {};
  if (target.state.rtdb !== undefined) {
    defineOwn(rtdbMap, DEFAULT_SNAPSHOT_RESOURCE, target.state.rtdb);
  }
  for (const [instKey, instTree] of Object.entries(
    target.state.rtdbInstances ?? {},
  )) {
    if (instKey === DEFAULT_SNAPSHOT_RESOURCE || isUnsafeObjectKey(instKey)) {
      continue;
    }
    defineOwn(rtdbMap, instKey, structuredClone(instTree));
  }

  const storageMap: Record<string, SnapshotStorageObject[]> = {
    [DEFAULT_SNAPSHOT_RESOURCE]: toSnapshotStorageObjects(
      target.state.storage ?? [],
    ),
  };
  for (const [bucketKey, fixtures] of Object.entries(
    target.state.storageBuckets ?? {},
  )) {
    if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE || isUnsafeObjectKey(bucketKey)) {
      continue;
    }
    defineOwn(storageMap, bucketKey, toSnapshotStorageObjects(fixtures));
  }

  const snapshotRules: {
    firestore?: Record<string, string>;
    rtdb?: Record<string, string>;
    storage?: Record<string, string>;
  } = {};
  if (typeof target.rules.firestore === "string" && target.rules.firestore.length > 0) {
    snapshotRules.firestore = { [DEFAULT_SNAPSHOT_RESOURCE]: target.rules.firestore };
  }
  const rtdbRuleMap: Record<string, string> = {};
  if (target.rules.rtdb !== undefined) {
    defineOwn(rtdbRuleMap, DEFAULT_SNAPSHOT_RESOURCE, JSON.stringify(target.rules.rtdb));
  }
  for (const [instKey, instRules] of Object.entries(target.rules.rtdbInstances ?? {})) {
    if (instKey === DEFAULT_SNAPSHOT_RESOURCE || isUnsafeObjectKey(instKey)) continue;
    defineOwn(rtdbRuleMap, instKey, JSON.stringify(instRules));
  }
  if (Object.keys(rtdbRuleMap).length > 0) {
    snapshotRules.rtdb = rtdbRuleMap;
  }
  const storageRuleMap: Record<string, string> = {};
  if (typeof target.rules.storage === "string" && target.rules.storage.length > 0) {
    defineOwn(storageRuleMap, DEFAULT_SNAPSHOT_RESOURCE, target.rules.storage);
  }
  for (const [bucketKey, bucketRules] of Object.entries(
    target.rules.storageBuckets ?? {},
  )) {
    if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE || isUnsafeObjectKey(bucketKey)) continue;
    defineOwn(storageRuleMap, bucketKey, bucketRules);
  }
  if (Object.keys(storageRuleMap).length > 0) {
    snapshotRules.storage = storageRuleMap;
  }

  return {
    version: 1,
    rules: snapshotRules,
    auth: {
      users: (target.state.auth?.users ?? []).map((u) => {
        const rec: {
          uid: string;
          email?: string;
          password?: string;
          displayName?: string;
          photoUrl?: string;
          phoneNumber?: string;
          emailVerified?: boolean;
          disabled?: boolean;
          tenantId?: string;
          providerId?: string;
          customClaims?: Record<string, unknown>;
        } = { uid: u.uid };
        if (typeof u.email === "string") rec.email = u.email;
        if (u.password !== undefined) rec.password = u.password;
        if (u.displayName !== undefined) rec.displayName = u.displayName;
        if (u.photoUrl !== undefined) rec.photoUrl = u.photoUrl;
        if (u.phoneNumber !== undefined) rec.phoneNumber = u.phoneNumber;
        if (u.emailVerified !== undefined) rec.emailVerified = u.emailVerified;
        if (u.disabled !== undefined) rec.disabled = u.disabled;
        if (u.tenantId !== undefined) rec.tenantId = u.tenantId;
        if (u.providerId !== undefined) rec.providerId = u.providerId;
        if (u.customClaims !== undefined) rec.customClaims = { ...u.customClaims };
        return rec;
      }),
    },
    firestore: { [DEFAULT_SNAPSHOT_RESOURCE]: firestoreDocs },
    rtdb: rtdbMap,
    storage: storageMap,
  };
}

function buildExistingCampaignClone(
  existingCampaign: AuthorizationCampaign,
): LiveRuntimeClone {
  const out: {
    snapshot: SandboxSnapshot;
    history: SandboxHistoryEvent[];
    studioUrl?: string;
    attachmentContext?: AssuranceCampaignContext["attachment"];
    existingCampaign: AuthorizationCampaign;
    targetRules: LocalFirebaseTarget["rules"];
    targetState: LocalFirebaseTarget["state"];
  } = {
    snapshot: snapshotFromTarget(existingCampaign.target),
    history: [],
    existingCampaign,
    targetRules: existingCampaign.target.rules,
    targetState: existingCampaign.target.state,
  };
  if (existingCampaign.context?.attachment !== undefined) {
    out.attachmentContext = existingCampaign.context.attachment;
    const sUrl = existingCampaign.context.attachment.source.studioUrl;
    if (sUrl.startsWith("http://") || sUrl.startsWith("https://")) {
      out.studioUrl = sUrl;
    }
  }
  return out;
}

export async function cloneLiveRuntime(options: {
  url?: string;
  campaignId?: string;
  store: AssuranceCampaignStore;
  sandbox?: LocalSandbox;
  attachmentProvider?: AssuranceAttachmentProvider;
  fetchImpl?: typeof fetch;
  projectDir?: string;
  configuredBuckets?: readonly string[];
  defaultBucket?: string;
}): Promise<LiveRuntimeClone> {
  let existingCampaign: AuthorizationCampaign | undefined;
  if (options.campaignId !== undefined) {
    try {
      existingCampaign = options.store.get(options.campaignId);
    } catch {
      existingCampaign = undefined;
    }
    if (existingCampaign !== undefined && existingCampaign.spec().probes.length > 0) {
      throw new AssuranceInputError(
        `campaign '${options.campaignId}' already exists.`,
      );
    }
  }

  if (options.url !== undefined) {
    if (options.attachmentProvider !== undefined) {
      const attached = await options.attachmentProvider({ url: options.url });
      let snapshot = snapshotFromTarget(attached.target);
      let history: SandboxHistoryEvent[] = [];
      if (options.sandbox !== undefined) {
        snapshot = await captureSandboxSnapshot(options.sandbox);
        history = historyEventsFromSandbox(options.sandbox);
      }
      const snapshotRules = targetRulesFromSnapshot(snapshot);
      const mergedRules: LocalFirebaseTarget["rules"] = {
        ...snapshotRules,
        ...attached.target.rules,
      };
      if (snapshotRules.rtdbInstances || attached.target.rules.rtdbInstances) {
        mergedRules.rtdbInstances = {
          ...(snapshotRules.rtdbInstances ?? {}),
          ...(attached.target.rules.rtdbInstances ?? {}),
        };
      }
      if (snapshotRules.storageBuckets || attached.target.rules.storageBuckets) {
        mergedRules.storageBuckets = {
          ...(snapshotRules.storageBuckets ?? {}),
          ...(attached.target.rules.storageBuckets ?? {}),
        };
      }
      const result: {
        snapshot: SandboxSnapshot;
        history: SandboxHistoryEvent[];
        studioUrl?: string;
        attachmentContext: AssuranceCampaignContext["attachment"];
        existingCampaign?: AuthorizationCampaign;
        targetRules: LocalFirebaseTarget["rules"];
        targetState: LocalFirebaseTarget["state"];
      } = {
        snapshot,
        history,
        attachmentContext: {
          source: attached.source,
          inventory: attached.inventory,
          coverageGaps: attached.coverageGaps,
        },
        targetRules: mergedRules,
        targetState: attached.target.state,
      };
      if (
        attached.source.studioUrl.startsWith("http://") ||
        attached.source.studioUrl.startsWith("https://")
      ) {
        result.studioUrl = attached.source.studioUrl;
      }
      if (existingCampaign !== undefined) {
        result.existingCampaign = existingCampaign;
      }
      return result;
    }

    const httpOpts: {
      fetchImpl?: typeof fetch;
      projectDir?: string;
      configuredBuckets?: readonly string[];
      defaultBucket?: string;
    } = {};
    if (options.fetchImpl !== undefined) httpOpts.fetchImpl = options.fetchImpl;
    if (options.projectDir !== undefined) httpOpts.projectDir = options.projectDir;
    if (options.configuredBuckets !== undefined) {
      httpOpts.configuredBuckets = options.configuredBuckets;
    }
    if (options.defaultBucket !== undefined) {
      httpOpts.defaultBucket = options.defaultBucket;
    }
    const remote = await cloneLoopbackSandboxHttp(options.url, httpOpts);
    let namedBucketObjectCount = 0;
    for (const objs of Object.values(remote.target.state.storageBuckets ?? {})) {
      namedBucketObjectCount += objs.length;
    }
    const rtdbPresent =
      remote.target.state.rtdb !== undefined ||
      Object.keys(remote.target.state.rtdbInstances ?? {}).length > 0;
    const out: {
      snapshot: SandboxSnapshot;
      history: SandboxHistoryEvent[];
      studioUrl: string;
      attachmentContext: NonNullable<AssuranceCampaignContext["attachment"]>;
      existingCampaign?: AuthorizationCampaign;
      targetRules: LocalFirebaseTarget["rules"];
      targetState: LocalFirebaseTarget["state"];
    } = {
      snapshot: remote.snapshot,
      history: remote.history,
      studioUrl: remote.studioUrl,
      attachmentContext: {
        source: {
          requestedUrl: options.url,
          origin: remote.origin,
          transport: "same-origin-shared-worker",
          readOnly: true,
          studioUrl: remote.studioUrl,
        },
        inventory: {
          firestoreDocuments: Object.keys(remote.target.state.firestore ?? {}).length,
          rtdbPresent,
          authUsers: remote.target.state.auth?.users.length ?? 0,
          storageObjects:
            (remote.target.state.storage?.length ?? 0) + namedBucketObjectCount,
        },
        coverageGaps: [],
      },
      targetRules: remote.target.rules,
      targetState: remote.target.state,
    };
    if (existingCampaign !== undefined) out.existingCampaign = existingCampaign;
    return out;
  }

  if (
    existingCampaign !== undefined &&
    existingCampaign.context?.attachment?.source.transport !== "in-process-sandbox"
  ) {
    return buildExistingCampaignClone(existingCampaign);
  }

  if (options.sandbox !== undefined) {
    const snapshot = await captureSandboxSnapshot(options.sandbox);
    const history = historyEventsFromSandbox(options.sandbox);
    const out: {
      snapshot: SandboxSnapshot;
      history: SandboxHistoryEvent[];
      existingCampaign?: AuthorizationCampaign;
      targetRules: LocalFirebaseTarget["rules"];
    } = {
      snapshot,
      history,
      targetRules: targetRulesFromSnapshot(snapshot),
    };
    if (existingCampaign !== undefined) out.existingCampaign = existingCampaign;
    return out;
  }

  if (existingCampaign !== undefined) {
    return buildExistingCampaignClone(existingCampaign);
  }

  return { history: [] };
}
