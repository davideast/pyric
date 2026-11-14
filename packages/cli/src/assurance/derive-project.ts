/**
 * Project root containment, `SdkUsageIndex` + `RuleSurface` disk loading, and
 * non-destructive live sandbox cloning entrypoints for `deriveAssurance`.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SNAPSHOT_RESOURCE } from "pyric/sandbox/internal";
import { rtdbRulesSourceRejection } from "pyric/rules/internal/rtdb";
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
  type SdkUsageIndex,
  type StorageSurfaceSource,
} from "pyric/rules/internal/usage";
import { realProjectPathWithin } from "../bridge/surface/arguments/project-real-path.js";
import type { InvalidArguments } from "../bridge/surface/method-types.js";
import { failFor } from "../bridge/surface/method-validation.js";
import {
  cloneLiveRuntime,
  targetRulesFromSnapshot,
  type LiveRuntimeClone,
} from "./derive-live-runtime.js";
import {
  classifyRuleProblem,
  isContainedNonSymlinkFile,
  normalizeConfiguredResourceId,
  readFirebaseProjectConfig,
  type ConfiguredRuleTarget,
  type ProjectRuleProblem,
} from "./derive-project-config.js";
import { AssuranceInputError } from "./types.js";

export {
  cloneLiveRuntime,
  normalizeConfiguredResourceId,
  targetRulesFromSnapshot,
  type LiveRuntimeClone,
  type ProjectRuleProblem,
};

export interface LoadedAssuranceProject {
  readonly root: string;
  readonly projectId?: string;
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

  const hadFirestoreDiskRules =
    fbConfig.hasFirestoreConfig ||
    loadedRules.firestore.length > 0 ||
    existsSync(join(absRoot, "firestore.rules"));
  const hadRtdbDiskRules =
    fbConfig.hasDatabaseConfig ||
    loadedRules.rtdb.length > 0 ||
    existsSync(join(absRoot, "database.rules.json"));
  const hadStorageDiskRules =
    fbConfig.hasStorageConfig ||
    (loadedRules.storage?.length ?? 0) > 0 ||
    existsSync(join(absRoot, "storage.rules"));

  const eligibleEmbedded = usage.embeddedRules.filter((entry) => {
    if (entry.service === "firestore") return !hadFirestoreDiskRules;
    if (entry.service === "rtdb") return !hadRtdbDiskRules;
    if (entry.service === "storage") return !hadStorageDiskRules;
    return false;
  });

  const ruleTargets: Record<string, readonly ConfiguredRuleTarget[]> = {
    ...fbConfig.configuredRuleTargets,
  };
  for (const entry of eligibleEmbedded) {
    let existing: readonly ConfiguredRuleTarget[] = [];
    if (Object.hasOwn(ruleTargets, entry.source)) {
      existing = ruleTargets[entry.source] ?? [];
    }
    ruleTargets[entry.source] = [
      ...existing,
      { service: entry.service, resourceId: DEFAULT_SNAPSHOT_RESOURCE },
    ];
  }

  const sources = withEmbeddedRules(loadedRules, eligibleEmbedded);

  sources.firestore = sources.firestore.filter((entry) => {
    const syntax = validateRulesSourceSyntax(entry.text, "cloud.firestore", {
      sourceFile: entry.source,
      targetService: "cloud.firestore",
    });
    if (!syntax.ok) {
      sources.problems.push(`${entry.source}: ${syntax.message}`);
      return false;
    }
    return true;
  });

  if (sources.storage !== undefined) {
    sources.storage = sources.storage.filter((entry) => {
      const syntax = validateRulesSourceSyntax(entry.text, "firebase.storage", {
        sourceFile: entry.source,
        targetService: "firebase.storage",
      });
      if (!syntax.ok) {
        sources.problems.push(`${entry.source}: ${syntax.message}`);
        return false;
      }
      return true;
    });
  }

  sources.rtdb = sources.rtdb.filter((entry) => {
    if (
      !entry.json ||
      typeof entry.json !== "object" ||
      Array.isArray(entry.json)
    ) {
      sources.problems.push(
        `${entry.source}: RTDB rules file must contain a JSON object`,
      );
      return false;
    }
    const rejection = rtdbRulesSourceRejection(entry.json);
    if (rejection !== null) {
      sources.problems.push(`${entry.source}: ${rejection.message}`);
      return false;
    }
    return true;
  });

  problems.push(...sources.problems);
  const configProblems = problems.flatMap((p) =>
    classifyRuleProblem(p, ruleTargets),
  );

  const ruleSurface = buildRuleSurfaceFromSources(sources, fbConfig.rtdbInstances);
  let resolvedDefaultBucket = fbConfig.defaultBucket;
  if (
    fbConfig.projectId !== undefined &&
    resolvedDefaultBucket === `${fbConfig.projectId}.firebasestorage.app` &&
    !fbConfig.configuredBuckets.includes(resolvedDefaultBucket)
  ) {
    const legacyAppspot = `${fbConfig.projectId}.appspot.com`;
    const unnamedStorageSources = (sources.storage ?? []).filter(
      (s) => s.bucket === undefined || s.bucket === DEFAULT_SNAPSHOT_RESOURCE,
    );
    const usesAppspotHeader =
      unnamedStorageSources.some((s) => s.text.includes(`/b/${legacyAppspot}/o`)) &&
      !unnamedStorageSources.some((s) =>
        s.text.includes(`/b/${fbConfig.projectId}.firebasestorage.app/o`),
      );
    if (usesAppspotHeader) {
      resolvedDefaultBucket = legacyAppspot;
    }
  }

  const loadedProject: {
    root: string;
    projectId?: string;
    usage: SdkUsageIndex;
    sources: RuleSources;
    ruleSurface: RuleSurface;
    configuredBuckets: readonly string[];
    defaultBucket: string | undefined;
    rtdbInstances: Readonly<Record<string, { rules: Record<string, unknown> }>>;
    problems: readonly string[];
    configProblems: readonly ProjectRuleProblem[];
  } = {
    root: absRoot,
    usage,
    sources,
    ruleSurface,
    configuredBuckets: fbConfig.configuredBuckets,
    defaultBucket: resolvedDefaultBucket,
    rtdbInstances: fbConfig.rtdbInstances,
    problems,
    configProblems,
  };
  if (fbConfig.projectId !== undefined) {
    loadedProject.projectId = fbConfig.projectId;
  }
  return loadedProject;
}
