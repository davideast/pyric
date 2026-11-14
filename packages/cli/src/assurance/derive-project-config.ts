/**
 * Contained `firebase.json` / `.firebaserc` / `pyric.json` target resolution
 * and rule-problem classification for `derive-project.ts`.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  isDefaultDatabaseInstance,
  parseResourcePattern,
  type AssuranceService,
} from "pyric/sandbox/internal";
import { parseRtdbRulesText } from "pyric/rules/internal/usage";
import { DEFAULT_BUCKET } from "pyric/storage/internal";
import type { FirebaseRc } from "../cli/firebase-json.js";
import { resolveFirebaseProject } from "../cli/firebase-project.js";
import { defineOwn, isUnsafeObjectKey } from "./derive-campaign-state.js";

export interface ProjectRuleProblem {
  readonly source: string;
  readonly message: string;
  readonly service?: AssuranceService;
  readonly resourceId?: string;
  readonly isGlobalConfig?: boolean;
}

export interface ConfiguredRuleTarget {
  readonly service: AssuranceService;
  readonly resourceId: string;
}

export interface ParsedFirebaseConfig {
  readonly projectId: string | undefined;
  readonly configuredBuckets: string[];
  readonly defaultBucket: string | undefined;
  readonly rtdbInstances: Record<string, { rules: Record<string, unknown> }>;
  readonly hasFirestoreConfig: boolean;
  readonly hasDatabaseConfig: boolean;
  readonly hasStorageConfig: boolean;
  readonly hasInvalidFirebaseJson: boolean;
  readonly configuredRuleTargets: Readonly<
    Record<string, readonly ConfiguredRuleTarget[]>
  >;
}

const DEFAULT_RTDB_SUFFIX_RE = /^[a-z0-9-]+-default-rtdb$/i;

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

export function isContainedNonSymlinkFile(
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

function appendRuleTarget(
  into: Record<string, ConfiguredRuleTarget[]>,
  relFile: string,
  service: AssuranceService,
  resourceId: string,
): void {
  if (isUnsafeObjectKey(relFile)) return;
  let list: ConfiguredRuleTarget[] | undefined;
  if (Object.hasOwn(into, relFile)) {
    list = into[relFile];
  }
  if (list === undefined) {
    list = [];
    defineOwn(into, relFile, list);
  }
  if (!list.some((t) => t.service === service && t.resourceId === resourceId)) {
    list.push({ service, resourceId });
  }
}

export function normalizeConfiguredResourceId(
  service: AssuranceService,
  rawId: string | undefined,
  projectId: string | undefined,
): string {
  if (rawId === undefined) return DEFAULT_SNAPSHOT_RESOURCE;
  const trimmed = rawId.trim();
  if (
    trimmed.length === 0 ||
    trimmed === DEFAULT_SNAPSHOT_RESOURCE ||
    trimmed === "default"
  ) {
    return DEFAULT_SNAPSHOT_RESOURCE;
  }
  if (service === "firestore") {
    return trimmed;
  }
  if (service === "storage") {
    let bucketId: string;
    if (/^https?:\/\//i.test(trimmed)) {
      bucketId = parseResourcePattern("storage", trimmed).resourceId;
    } else {
      bucketId = trimmed.replace(/^gs:\/\//i, "").replace(/^\/+|\/+$/g, "");
    }
    if (
      bucketId.length === 0 ||
      bucketId === DEFAULT_SNAPSHOT_RESOURCE ||
      bucketId === "default" ||
      bucketId === "pyric-default" ||
      bucketId === "default-bucket" ||
      bucketId === DEFAULT_BUCKET
    ) {
      return DEFAULT_SNAPSHOT_RESOURCE;
    }
    return bucketId;
  }
  const instId = parseResourcePattern("rtdb", "ref", trimmed).resourceId;
  if (
    instId === DEFAULT_SNAPSHOT_RESOURCE ||
    instId === "default" ||
    isDefaultDatabaseInstance(instId, projectId) ||
    (projectId === undefined && DEFAULT_RTDB_SUFFIX_RE.test(instId))
  ) {
    return DEFAULT_SNAPSHOT_RESOURCE;
  }
  return instId;
}

function collectConfiguredRuleTargets(
  absRoot: string,
  section: unknown,
  service: AssuranceService,
  projectId: string | undefined,
  projectTargets:
    | Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
    | undefined,
  into: Record<string, ConfiguredRuleTarget[]>,
): void {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) {
    entries = section;
  }
  let rcServiceKey: string = service;
  if (service === "rtdb") {
    rcServiceKey = "database";
  }
  let targetMap: Readonly<Record<string, readonly string[]>> | undefined;
  if (projectTargets && Object.hasOwn(projectTargets, rcServiceKey)) {
    targetMap = projectTargets[rcServiceKey];
  }

  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const entry = item as {
      rules?: unknown;
      database?: unknown;
      bucket?: unknown;
      instance?: unknown;
      target?: unknown;
    };
    if (typeof entry.rules !== "string" || entry.rules.length === 0) continue;
    const relFile = normalizeConfigRuleRel(absRoot, entry.rules);

    const rawIds: Array<string | undefined> = [];
    if (typeof entry.target === "string" && entry.target.trim().length > 0) {
      const trimmedTarget = entry.target.trim();
      let mapped: readonly string[] | undefined;
      if (targetMap && Object.hasOwn(targetMap, trimmedTarget)) {
        mapped = targetMap[trimmedTarget];
      }
      if (Array.isArray(mapped) && mapped.length > 0) {
        for (const candidate of mapped) {
          if (typeof candidate === "string" && candidate.trim().length > 0) {
            rawIds.push(candidate);
          }
        }
      }
    } else if (service === "firestore" && typeof entry.database === "string") {
      rawIds.push(entry.database);
    } else if (service === "storage" && typeof entry.bucket === "string") {
      rawIds.push(entry.bucket);
    } else if (service === "rtdb" && typeof entry.instance === "string") {
      rawIds.push(entry.instance);
    }

    if (rawIds.length === 0) {
      appendRuleTarget(into, relFile, service, DEFAULT_SNAPSHOT_RESOURCE);
    } else {
      for (const rawId of rawIds) {
        appendRuleTarget(
          into,
          relFile,
          service,
          normalizeConfiguredResourceId(service, rawId, projectId),
        );
      }
    }
  }
}

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

export function readFirebaseProjectConfig(absRoot: string): ParsedFirebaseConfig {
  let realRoot = absRoot;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    realRoot = absRoot;
  }

  const configuredBuckets: string[] = [];
  let defaultBucket: string | undefined;
  const rtdbInstances: Record<string, { rules: Record<string, unknown> }> = {};
  const configuredRuleTargets: Record<string, ConfiguredRuleTarget[]> = {};

  const fbPath = resolve(absRoot, "firebase.json");
  const fbExists = pathExistsIncludingBrokenSymlink(fbPath);
  const raw = readContainedJsonFile<{
    firestore?: unknown;
    storage?: unknown;
    database?: unknown;
  }>(absRoot, realRoot, "firebase.json");

  const rc = readContainedJsonFile<FirebaseRc>(absRoot, realRoot, ".firebaserc");
  const pyricCfg = readContainedJsonFile<{ project?: unknown }>(
    absRoot,
    realRoot,
    "pyric.json",
  );
  let configProject: string | undefined;
  if (typeof pyricCfg?.project === "string" && pyricCfg.project.trim().length > 0) {
    configProject = pyricCfg.project.trim();
  }
  const resolveInput: {
    projectDir: string;
    configProject?: string;
    rc: FirebaseRc | null;
  } = { projectDir: absRoot, rc };
  if (configProject !== undefined) {
    resolveInput.configProject = configProject;
  }
  const projectId = resolveFirebaseProject(resolveInput).projectId;
  if (projectId !== undefined) {
    defaultBucket = `${projectId}.firebasestorage.app`;
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      projectId,
      configuredBuckets,
      defaultBucket,
      rtdbInstances,
      hasFirestoreConfig: false,
      hasDatabaseConfig: false,
      hasStorageConfig: false,
      hasInvalidFirebaseJson: fbExists,
      configuredRuleTargets,
    };
  }

  const hasFirestoreConfig =
    raw.firestore !== undefined && raw.firestore !== null;
  const hasDatabaseConfig = raw.database !== undefined && raw.database !== null;
  const hasStorageConfig = raw.storage !== undefined && raw.storage !== null;

  let projectTargets:
    | Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
    | undefined;
  if (
    projectId !== undefined &&
    rc?.targets !== undefined &&
    Object.hasOwn(rc.targets, projectId)
  ) {
    projectTargets = rc.targets[projectId] as
      | Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
      | undefined;
  }

  collectConfiguredRuleTargets(
    absRoot,
    raw.firestore,
    "firestore",
    projectId,
    projectTargets,
    configuredRuleTargets,
  );
  collectConfiguredRuleTargets(
    absRoot,
    raw.database,
    "rtdb",
    projectId,
    projectTargets,
    configuredRuleTargets,
  );
  collectConfiguredRuleTargets(
    absRoot,
    raw.storage,
    "storage",
    projectId,
    projectTargets,
    configuredRuleTargets,
  );

  try {
    let storageEntries: unknown[] = [];
    if (Array.isArray(raw.storage)) {
      storageEntries = raw.storage;
    } else if (raw.storage && typeof raw.storage === "object") {
      storageEntries = [raw.storage];
    }
    for (const item of storageEntries) {
      if (!item || typeof item !== "object") continue;
      const entry = item as { bucket?: unknown; target?: unknown };
      if (typeof entry.target === "string" && entry.target.trim().length > 0) {
        const storageTargets = projectTargets?.storage;
        const trimmedTarget = entry.target.trim();
        let mapped: readonly string[] | undefined;
        if (storageTargets && Object.hasOwn(storageTargets, trimmedTarget)) {
          mapped = storageTargets[trimmedTarget];
        }
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
      }
    }
    const configuredDefaultBucket = configuredBuckets.find((b) =>
      isFirebaseDefaultBucketName(b, projectId),
    );
    if (configuredDefaultBucket !== undefined) {
      defaultBucket = configuredDefaultBucket;
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
        const trimmedTarget = entry.target.trim();
        let mapped: readonly string[] | undefined;
        if (dbTargets && Object.hasOwn(dbTargets, trimmedTarget)) {
          mapped = dbTargets[trimmedTarget];
        }
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
          for (const rawInstName of instanceNames) {
            const instName = parseResourcePattern("rtdb", "ref", rawInstName).resourceId;
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
      projectId,
      configuredBuckets,
      defaultBucket,
      rtdbInstances,
      hasFirestoreConfig,
      hasDatabaseConfig,
      hasStorageConfig,
      hasInvalidFirebaseJson: false,
      configuredRuleTargets,
    };
  }

  return {
    projectId,
    configuredBuckets,
    defaultBucket,
    rtdbInstances,
    hasFirestoreConfig,
    hasDatabaseConfig,
    hasStorageConfig,
    hasInvalidFirebaseJson: false,
    configuredRuleTargets,
  };
}

export function classifyRuleProblem(
  problemText: string,
  configuredTargets: Readonly<Record<string, readonly ConfiguredRuleTarget[]>>,
): ProjectRuleProblem[] {
  const colonIdx = problemText.indexOf(": ");
  let source = "firebase.json";
  if (colonIdx > 0) {
    source = problemText.slice(0, colonIdx);
  }
  if (source === "firebase.json") {
    return [
      {
        source,
        message: problemText,
        isGlobalConfig: true,
      },
    ];
  }
  let matched: readonly ConfiguredRuleTarget[] | undefined;
  if (Object.hasOwn(configuredTargets, source)) {
    matched = configuredTargets[source];
  }
  if (matched !== undefined && matched.length > 0) {
    return matched.map((target) => ({
      source,
      message: problemText,
      service: target.service,
      resourceId: target.resourceId,
    }));
  }
  let service: AssuranceService;
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
  return [
    {
      source,
      message: problemText,
      service,
      resourceId: DEFAULT_SNAPSHOT_RESOURCE,
    },
  ];
}
