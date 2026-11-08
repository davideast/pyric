/**
 * Project root containment, `SdkUsageIndex` + `RuleSurface` disk loading, and
 * non-destructive live sandbox cloning for `deriveAssurance`.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LocalSandbox } from "pyric/sandbox";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
  decodeBase64ToBytes,
  parseResourcePattern,
  type SandboxSnapshot,
} from "pyric/sandbox/internal";
import {
  extractSdkUsage,
  loadDiskProject,
  loadRuleSources,
  parseRtdbRulesText,
  projectRuleSurface,
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
import { realProjectPathWithin } from "../bridge/surface/arguments/project-real-path.js";
import { failFor } from "../bridge/surface/method-validation.js";
import type { InvalidArguments } from "../bridge/surface/method-types.js";
import type { AssuranceAttachmentProvider } from "./attachment.js";
import type { AuthorizationCampaign } from "./campaign.js";
import { defineOwn } from "./derive-campaign-state.js";
import { cloneLoopbackSandboxHttp } from "./derive-live-http.js";
import type { AssuranceCampaignStore } from "./tools.js";
import {
  AssuranceInputError,
  type AssuranceCampaignContext,
  type LocalFirebaseTarget,
} from "./types.js";

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
}

function readFirebaseProjectConfig(absRoot: string): ParsedFirebaseConfig {
  const configPath = join(absRoot, "firebase.json");
  const configuredBuckets: string[] = [];
  let defaultBucket: string | undefined;
  const rtdbInstances: Record<string, { rules: Record<string, unknown> }> = {};

  if (!existsSync(configPath)) {
    return { configuredBuckets, defaultBucket, rtdbInstances };
  }
  try {
    if (lstatSync(configPath).isSymbolicLink()) {
      return { configuredBuckets, defaultBucket, rtdbInstances };
    }
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      storage?: unknown;
      database?: unknown;
    };

    let storageEntries: unknown[] = [];
    if (Array.isArray(raw.storage)) {
      storageEntries = raw.storage;
    } else if (raw.storage && typeof raw.storage === "object") {
      storageEntries = [raw.storage];
    }
    for (const item of storageEntries) {
      if (!item || typeof item !== "object") continue;
      const bucket = (item as { bucket?: unknown }).bucket;
      if (typeof bucket === "string" && bucket.trim().length > 0) {
        const normalized = parseResourcePattern("storage", "object", bucket).resourceId;
        if (!configuredBuckets.includes(normalized)) {
          configuredBuckets.push(normalized);
        }
        if (defaultBucket === undefined && storageEntries.length === 1) {
          defaultBucket = normalized;
        }
      }
    }

    if (Array.isArray(raw.database)) {
      for (const item of raw.database) {
        if (!item || typeof item !== "object") continue;
        const entry = item as { instance?: unknown; rules?: unknown };
        let instName: string | undefined;
        if (typeof entry.instance === "string" && entry.instance.length > 0) {
          instName = entry.instance;
        }
        if (!instName || typeof entry.rules !== "string") continue;
        const rulesPath = join(absRoot, entry.rules);
        if (!existsSync(rulesPath) || lstatSync(rulesPath).isSymbolicLink()) continue;
        const parsedRtdb = parseRtdbRulesText(readFileSync(rulesPath, "utf8"));
        if (
          parsedRtdb &&
          typeof parsedRtdb === "object" &&
          Object.hasOwn(parsedRtdb, "rules")
        ) {
          const rulesObj = (parsedRtdb as { rules?: unknown }).rules;
          if (rulesObj && typeof rulesObj === "object" && !Array.isArray(rulesObj)) {
            defineOwn(rtdbInstances, instName, {
              rules: rulesObj as Record<string, unknown>,
            });
          }
        }
      }
    }
  } catch {
    return { configuredBuckets, defaultBucket, rtdbInstances };
  }

  return { configuredBuckets, defaultBucket, rtdbInstances };
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

  const loadedRules = loadRuleSources(absRoot);
  if (loadedRules.firestore.length === 0) {
    const convFs = join(absRoot, "firestore.rules");
    if (existsSync(convFs) && !lstatSync(convFs).isSymbolicLink()) {
      loadedRules.firestore.push({
        source: "firestore.rules",
        text: readFileSync(convFs, "utf8"),
      });
    }
  }
  if (loadedRules.rtdb.length === 0) {
    const convRtdb = join(absRoot, "database.rules.json");
    if (existsSync(convRtdb) && !lstatSync(convRtdb).isSymbolicLink()) {
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
  if ((loadedRules.storage?.length ?? 0) === 0) {
    const convSt = join(absRoot, "storage.rules");
    if (existsSync(convSt) && !lstatSync(convSt).isSymbolicLink()) {
      if (!loadedRules.storage) loadedRules.storage = [];
      loadedRules.storage.push({
        source: "storage.rules",
        text: readFileSync(convSt, "utf8"),
      });
    }
  }
  const sources = withEmbeddedRules(loadedRules, [...usage.embeddedRules]);
  problems.push(...sources.problems);

  const fbConfig = readFirebaseProjectConfig(absRoot);
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
  };
}

function historyEventsFromSandbox(sandbox: LocalSandbox): SandboxHistoryEvent[] {
  return [...sandbox.history()];
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
  const storageObjs = (target.state.storage ?? []).map((item) => {
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
  return {
    version: 1,
    rules: {},
    auth: {
      users: (target.state.auth?.users ?? []).map((u) => {
        const rec: {
          uid: string;
          email?: string;
          displayName?: string;
          emailVerified?: boolean;
          customClaims?: Record<string, unknown>;
        } = { uid: u.uid };
        if (typeof u.email === "string") rec.email = u.email;
        if (u.displayName !== undefined) rec.displayName = u.displayName;
        if (u.emailVerified !== undefined) rec.emailVerified = u.emailVerified;
        if (u.customClaims !== undefined) rec.customClaims = { ...u.customClaims };
        return rec;
      }),
    },
    firestore: { [DEFAULT_SNAPSHOT_RESOURCE]: firestoreDocs },
    rtdb: rtdbMap,
    storage: { [DEFAULT_SNAPSHOT_RESOURCE]: storageObjs },
  };
}

export async function cloneLiveRuntime(options: {
  url?: string;
  campaignId?: string;
  store: AssuranceCampaignStore;
  sandbox?: LocalSandbox;
  attachmentProvider?: AssuranceAttachmentProvider;
  fetchImpl?: typeof fetch;
  projectDir?: string;
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
        targetRules: attached.target.rules,
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

    const httpOpts: { fetchImpl?: typeof fetch; projectDir?: string } = {};
    if (options.fetchImpl !== undefined) httpOpts.fetchImpl = options.fetchImpl;
    if (options.projectDir !== undefined) httpOpts.projectDir = options.projectDir;
    const remote = await cloneLoopbackSandboxHttp(options.url, httpOpts);
    const out: {
      snapshot: SandboxSnapshot;
      history: SandboxHistoryEvent[];
      studioUrl: string;
      existingCampaign?: AuthorizationCampaign;
      targetRules: LocalFirebaseTarget["rules"];
      targetState: LocalFirebaseTarget["state"];
    } = {
      snapshot: remote.snapshot,
      history: remote.history,
      studioUrl: remote.studioUrl,
      targetRules: remote.target.rules,
      targetState: remote.target.state,
    };
    if (existingCampaign !== undefined) out.existingCampaign = existingCampaign;
    return out;
  }

  if (options.sandbox !== undefined) {
    const snapshot = await captureSandboxSnapshot(options.sandbox);
    const history = historyEventsFromSandbox(options.sandbox);
    const out: {
      snapshot: SandboxSnapshot;
      history: SandboxHistoryEvent[];
      existingCampaign?: AuthorizationCampaign;
    } = { snapshot, history };
    if (existingCampaign !== undefined) out.existingCampaign = existingCampaign;
    return out;
  }

  if (existingCampaign !== undefined) {
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

  return { history: [] };
}
