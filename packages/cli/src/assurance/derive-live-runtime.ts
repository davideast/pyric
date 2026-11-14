/**
 * Non-destructive live sandbox runtime cloning (in-process, attachment provider,
 * loopback HTTP, and existing campaign targets) for `derive-project.ts`.
 */
import type { LocalSandbox } from "pyric/sandbox";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
  decodeBase64ToBytes,
  parseResourcePattern,
  type SandboxSnapshot,
  type SnapshotStorageObject,
} from "pyric/sandbox/internal";
import {
  parseRtdbRulesText,
  type SandboxHistoryEvent,
} from "pyric/rules/internal/usage";
import { DEFAULT_BUCKET } from "pyric/storage/internal";
import type { AssuranceAttachmentProvider } from "./attachment.js";
import type { AuthorizationCampaign } from "./campaign.js";
import { defineOwn, isUnsafeObjectKey } from "./derive-campaign-state.js";
import { cloneLoopbackSandboxHttp } from "./derive-live-http.js";
import { cloneProviderUserInfoList } from "./derive-live-state.js";
import type { AssuranceCampaignStore } from "./tools.js";
import {
  AssuranceInputError,
  type AssuranceCampaignContext,
  type AuthProviderUserInfo,
  type LocalFirebaseTarget,
  type StorageObjectFixture,
} from "./types.js";

export interface LiveRuntimeClone {
  readonly snapshot?: SandboxSnapshot;
  readonly history: readonly SandboxHistoryEvent[];
  readonly studioUrl?: string;
  readonly attachmentContext?: AssuranceCampaignContext["attachment"];
  readonly existingCampaign?: AuthorizationCampaign;
  readonly targetRules?: LocalFirebaseTarget["rules"];
  readonly targetState?: LocalFirebaseTarget["state"];
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
      cacheControl?: string;
      contentDisposition?: string;
      contentEncoding?: string;
      contentLanguage?: string;
      timeCreated?: string;
      updated?: string;
      customMetadata?: Record<string, string>;
    } = {
      path: item.path,
      contentBase64: item.dataBase64,
      size: decodeBase64ToBytes(item.dataBase64).byteLength,
    };
    if (item.contentType !== undefined) snap.contentType = item.contentType;
    if (item.cacheControl !== undefined) snap.cacheControl = item.cacheControl;
    if (item.contentDisposition !== undefined) {
      snap.contentDisposition = item.contentDisposition;
    }
    if (item.contentEncoding !== undefined) {
      snap.contentEncoding = item.contentEncoding;
    }
    if (item.contentLanguage !== undefined) {
      snap.contentLanguage = item.contentLanguage;
    }
    if (item.timeCreated !== undefined) snap.timeCreated = item.timeCreated;
    if (item.updated !== undefined) snap.updated = item.updated;
    if (item.customMetadata !== undefined) {
      const customCopy: Record<string, string> = {};
      for (const [k, v] of Object.entries(item.customMetadata)) {
        if (typeof v === "string") defineOwn(customCopy, k, v);
      }
      snap.customMetadata = { ...customCopy };
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
          const innerRecord = inner as Record<string, unknown>;
          const wrapper = { rules: { ...innerRecord } };
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

  const authProviders: Record<string, boolean> = {};
  if (target.state.auth?.providers !== undefined) {
    for (const [providerId, enabled] of Object.entries(target.state.auth.providers)) {
      if (!isUnsafeObjectKey(providerId) && typeof enabled === "boolean") {
        defineOwn(authProviders, providerId, enabled);
      }
    }
  }
  const authSnapshot: {
    users: Array<{
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
      providerUserInfo?: AuthProviderUserInfo[];
      customClaims?: Record<string, unknown>;
    }>;
    providers?: Record<string, boolean>;
  } = {
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
        providerUserInfo?: AuthProviderUserInfo[];
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
      const providerInfo = cloneProviderUserInfoList(u.providerUserInfo);
      if (providerInfo !== undefined) {
        rec.providerUserInfo = providerInfo;
      }
      if (u.customClaims !== undefined) rec.customClaims = { ...u.customClaims };
      return rec;
    }),
  };
  if (Object.keys(authProviders).length > 0) {
    authSnapshot.providers = authProviders;
  }

  const snapshot: {
    version: 1;
    rules: typeof snapshotRules;
    auth: typeof authSnapshot;
    firestore: { [DEFAULT_SNAPSHOT_RESOURCE]: typeof firestoreDocs };
    rtdb: typeof rtdbMap;
    storage: typeof storageMap;
    storageConfig?: {
      crossServiceIam?: "granted" | "denied";
      undeployedBucketPolicy?: "allow" | "deny";
    };
  } = {
    version: 1,
    rules: snapshotRules,
    auth: authSnapshot,
    firestore: { [DEFAULT_SNAPSHOT_RESOURCE]: firestoreDocs },
    rtdb: rtdbMap,
    storage: storageMap,
  };
  if (target.state.storageConfig !== undefined) {
    const cfg: {
      crossServiceIam?: "granted" | "denied";
      undeployedBucketPolicy?: "allow" | "deny";
    } = {};
    if (target.state.storageConfig.crossServiceIam !== undefined) {
      cfg.crossServiceIam = target.state.storageConfig.crossServiceIam;
    }
    if (target.state.storageConfig.undeployedBucketPolicy !== undefined) {
      cfg.undeployedBucketPolicy = target.state.storageConfig.undeployedBucketPolicy;
    }
    if (Object.keys(cfg).length > 0) {
      snapshot.storageConfig = cfg;
    }
  }
  return snapshot;
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
  projectId?: string;
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
        const nextRtdbInstances: Record<
          string,
          { rules: Record<string, unknown> }
        > = {};
        if (snapshotRules.rtdbInstances !== undefined) {
          Object.assign(nextRtdbInstances, snapshotRules.rtdbInstances);
        }
        if (attached.target.rules.rtdbInstances !== undefined) {
          Object.assign(nextRtdbInstances, attached.target.rules.rtdbInstances);
        }
        mergedRules.rtdbInstances = nextRtdbInstances;
      }
      if (snapshotRules.storageBuckets || attached.target.rules.storageBuckets) {
        const nextStorageBuckets: Record<string, string> = {};
        if (snapshotRules.storageBuckets !== undefined) {
          Object.assign(nextStorageBuckets, snapshotRules.storageBuckets);
        }
        if (attached.target.rules.storageBuckets !== undefined) {
          Object.assign(nextStorageBuckets, attached.target.rules.storageBuckets);
        }
        mergedRules.storageBuckets = nextStorageBuckets;
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
      projectId?: string;
      configuredBuckets?: readonly string[];
      defaultBucket?: string;
    } = {};
    if (options.fetchImpl !== undefined) httpOpts.fetchImpl = options.fetchImpl;
    if (options.projectDir !== undefined) httpOpts.projectDir = options.projectDir;
    if (options.projectId !== undefined) httpOpts.projectId = options.projectId;
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
