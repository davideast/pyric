/**
 * Read-only loopback HTTP state and event cloner for `deriveAssurance` and
 * `pyric assurance derive --port / --url`. Never mutates the running server.
 */
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  parseResourcePattern,
  resolveDatabaseInstance,
  type SandboxSnapshot,
} from "pyric/sandbox/internal";
import type { SandboxHistoryEvent } from "pyric/rules/internal/usage";
import { resolveSessionTokenForTarget } from "../serve/local-session-token.js";
import { parseStateFile, type PyricStateFile } from "../serve/state-file.js";
import { isLoopbackHost } from "./attachment.js";
import { extractStorageBucketRulesText } from "./attachment-target-clone.js";
import { defineOwn, isUnsafeObjectKey } from "./derive-campaign-state.js";
import {
  computeLiveDefaultStorageBuckets,
  hydrateLiveStorageObjects,
  readDefaultProjectIdFromDir,
} from "./derive-live-http-storage.js";
import {
  fetchHostedEvents,
  parseLoopbackOrigin,
  requestLoopback,
} from "./derive-live-http-transport.js";
import { decodeLiveStatePayload } from "./derive-live-state.js";
import {
  ASSURANCE_TARGET_SCHEMA,
  AssuranceInputError,
  type LocalFirebaseTarget,
} from "./types.js";

export { isLoopbackHost, parseLoopbackOrigin };

interface InitMetadataPayload {
  readonly rules?: string | null;
  readonly databaseRules?: { readonly rules: Record<string, unknown> } | null;
  readonly databaseInstances?: {
    readonly defaultInstance?: string;
    readonly projectId?: string;
    readonly rules?: Readonly<
      Record<string, { readonly rules: Record<string, unknown> } | null>
    >;
  } | null;
  readonly storageRules?: string | null;
  readonly storageBucketRules?: Readonly<
    Record<string, string | { readonly rules: string; readonly rulesHash?: string } | null>
  > | null;
  readonly sessionToken?: string | null;
  readonly instanceId?: string | null;
}

export interface LoopbackCloneResult {
  readonly origin: string;
  readonly studioUrl: string;
  readonly snapshot: SandboxSnapshot;
  readonly target: LocalFirebaseTarget;
  readonly history: SandboxHistoryEvent[];
}

export async function cloneLoopbackSandboxHttp(
  rawUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    projectDir?: string;
    projectId?: string;
    configuredBuckets?: readonly string[];
    defaultBucket?: string;
    sessionToken?: string;
  } = {},
): Promise<LoopbackCloneResult> {
  const parsedUrl = parseLoopbackOrigin(rawUrl);
  const origin = parsedUrl.origin;
  const customFetch = options.fetchImpl;
  const effectiveCwd = options.projectDir ?? process.cwd();
  const initialToken = resolveSessionTokenForTarget({
    explicitToken: options.sessionToken,
    url: origin,
    cwd: effectiveCwd,
  });
  const getLoopback = async (
    targetUrl: string,
    headers: Record<string, string>,
  ): Promise<Response> => {
    const reqOpts: {
      method: "GET";
      headers: Record<string, string>;
      cwd: string;
      customFetch?: typeof fetch;
    } = {
      method: "GET",
      headers,
      cwd: effectiveCwd,
    };
    if (customFetch !== undefined) {
      reqOpts.customFetch = customFetch;
    }
    return requestLoopback(targetUrl, reqOpts);
  };

  let initRes: Response;
  try {
    const initHeaders: Record<string, string> = {};
    if (initialToken !== undefined) {
      initHeaders["x-pyric-session-token"] = initialToken;
    }
    initRes = await getLoopback(`${origin}/__pyric/init.json`, initHeaders);
  } catch (error) {
    if (error instanceof AssuranceInputError) throw error;
    let detail = String(error);
    if (error instanceof Error) detail = error.message;
    throw new AssuranceInputError(
      `Unable to reach Pyric sandbox server at '${origin}': ${detail}`,
    );
  }

  if (initRes.status !== 200) {
    throw new AssuranceInputError(
      `Pyric initialization metadata returned HTTP ${initRes.status} at '${origin}'.`,
    );
  }

  let parsedInit: unknown;
  try {
    parsedInit = await initRes.json();
  } catch {
    throw new AssuranceInputError(
      `Invalid JSON from '${origin}/__pyric/init.json'.`,
    );
  }
  if (!parsedInit || typeof parsedInit !== "object" || Array.isArray(parsedInit)) {
    throw new AssuranceInputError(
      `Invalid Pyric initialization metadata at '${origin}/__pyric/init.json'.`,
    );
  }
  const initPayload = parsedInit as InitMetadataPayload;
  const headers: Record<string, string> = {};
  let effectiveToken = initialToken;
  if (typeof initPayload.sessionToken === "string" && initPayload.sessionToken.length > 0) {
    effectiveToken = initPayload.sessionToken;
  }
  if (effectiveToken !== undefined && effectiveToken.length > 0) {
    headers["x-pyric-session-token"] = effectiveToken;
  }

  let stateBody: PyricStateFile | null = null;
  let stateRes: Response;
  try {
    stateRes = await getLoopback(`${origin}/__pyric/state`, headers);
  } catch (error) {
    if (error instanceof AssuranceInputError) throw error;
    let detail = String(error);
    if (error instanceof Error) detail = error.message;
    throw new AssuranceInputError(
      `Unable to fetch Pyric state from '${origin}/__pyric/state': ${detail}`,
    );
  }

  if (stateRes.status === 200) {
    let rawState: unknown;
    try {
      rawState = await stateRes.json();
      stateBody = parseStateFile(rawState, "/__pyric/state");
    } catch (error) {
      if (error instanceof AssuranceInputError) throw error;
      let detail = String(error);
      if (error instanceof Error) detail = error.message;
      throw new AssuranceInputError(
        `Invalid Pyric state payload from '${origin}/__pyric/state': ${detail}`,
      );
    }
  } else if (stateRes.status !== 404) {
    throw new AssuranceInputError(
      `Pyric state endpoint returned HTTP ${stateRes.status} at '${origin}/__pyric/state'.`,
    );
  }

  const decodedState = decodeLiveStatePayload(stateBody);

  const rules: LocalFirebaseTarget["rules"] = {};
  const snapshotRules: {
    firestore?: Record<string, string>;
    rtdb?: Record<string, string>;
    storage?: Record<string, string>;
  } = {};

  if (typeof initPayload.rules === "string" && initPayload.rules.trim().length > 0) {
    rules.firestore = initPayload.rules;
    snapshotRules.firestore = { [DEFAULT_SNAPSHOT_RESOURCE]: initPayload.rules };
  }

  const rtdbRuleMap: Record<string, string> = {};
  const mergedRtdbInstanceRules: Record<
    string,
    { rules: Record<string, unknown> }
  > = {};
  if (
    initPayload.databaseRules?.rules &&
    typeof initPayload.databaseRules.rules === "object" &&
    !Array.isArray(initPayload.databaseRules.rules)
  ) {
    rules.rtdb = { rules: { ...initPayload.databaseRules.rules } };
    defineOwn(
      rtdbRuleMap,
      DEFAULT_SNAPSHOT_RESOURCE,
      JSON.stringify(rules.rtdb),
    );
  }
  const initDbInstances = initPayload.databaseInstances;
  if (
    initDbInstances &&
    typeof initDbInstances === "object" &&
    !Array.isArray(initDbInstances) &&
    initDbInstances.rules &&
    typeof initDbInstances.rules === "object" &&
    !Array.isArray(initDbInstances.rules)
  ) {
    let defaultInstName: string | undefined;
    if (typeof initDbInstances.defaultInstance === "string") {
      defaultInstName = initDbInstances.defaultInstance;
    }
    for (const [instName, wrapper] of Object.entries(initDbInstances.rules)) {
      if (isUnsafeObjectKey(instName)) continue;
      if (
        !wrapper ||
        typeof wrapper !== "object" ||
        Array.isArray(wrapper) ||
        !wrapper.rules ||
        typeof wrapper.rules !== "object" ||
        Array.isArray(wrapper.rules)
      ) {
        continue;
      }
      const clonedWrapper = { rules: { ...wrapper.rules } };
      if (
        instName === DEFAULT_SNAPSHOT_RESOURCE ||
        (defaultInstName !== undefined && instName === defaultInstName)
      ) {
        if (rules.rtdb === undefined) {
          rules.rtdb = clonedWrapper;
          defineOwn(
            rtdbRuleMap,
            DEFAULT_SNAPSHOT_RESOURCE,
            JSON.stringify(clonedWrapper),
          );
        }
      } else {
        defineOwn(mergedRtdbInstanceRules, instName, clonedWrapper);
        defineOwn(rtdbRuleMap, instName, JSON.stringify(clonedWrapper));
      }
    }
  }
  if (rules.rtdb === undefined && decodedState.defaultRtdbRules !== undefined) {
    rules.rtdb = decodedState.defaultRtdbRules;
    defineOwn(
      rtdbRuleMap,
      DEFAULT_SNAPSHOT_RESOURCE,
      JSON.stringify(decodedState.defaultRtdbRules),
    );
  }
  for (const [instName, instRules] of Object.entries(
    decodedState.rtdbInstanceRules,
  )) {
    defineOwn(mergedRtdbInstanceRules, instName, instRules);
    defineOwn(rtdbRuleMap, instName, JSON.stringify(instRules));
  }
  if (Object.keys(mergedRtdbInstanceRules).length > 0) {
    rules.rtdbInstances = mergedRtdbInstanceRules;
  }
  if (Object.keys(rtdbRuleMap).length > 0) {
    snapshotRules.rtdb = rtdbRuleMap;
  }

  const storageRuleMap: Record<string, string> = {};
  const targetStorageBuckets: Record<string, string> = {};
  const namedStorageBuckets = new Set<string>();
  let inferredProjectId = options.projectId;
  if (
    inferredProjectId === undefined &&
    typeof initDbInstances?.projectId === "string" &&
    initDbInstances.projectId.trim().length > 0
  ) {
    inferredProjectId = initDbInstances.projectId.trim();
  }
  if (inferredProjectId === undefined) {
    inferredProjectId = readDefaultProjectIdFromDir(options.projectDir);
  }
  const initialDefaultStorageBuckets = computeLiveDefaultStorageBuckets({
    namedBuckets: namedStorageBuckets,
    defaultBucket: options.defaultBucket,
    projectId: inferredProjectId,
    storageEntries: stateBody?.storage,
  });
  for (const configured of options.configuredBuckets ?? []) {
    const norm = parseResourcePattern("storage", "object", configured).resourceId;
    if (!initialDefaultStorageBuckets.has(norm) && !isUnsafeObjectKey(norm)) {
      namedStorageBuckets.add(norm);
    }
  }
  if (
    typeof initPayload.storageRules === "string" &&
    initPayload.storageRules.trim().length > 0
  ) {
    rules.storage = initPayload.storageRules;
    defineOwn(storageRuleMap, DEFAULT_SNAPSHOT_RESOURCE, initPayload.storageRules);
  }
  if (
    initPayload.storageBucketRules &&
    typeof initPayload.storageBucketRules === "object" &&
    !Array.isArray(initPayload.storageBucketRules)
  ) {
    for (const [rawBucket, entry] of Object.entries(
      initPayload.storageBucketRules,
    )) {
      const entryRules = extractStorageBucketRulesText(entry);
      if (entryRules === undefined || entryRules.trim().length === 0) {
        continue;
      }
      const bucketId = parseResourcePattern("storage", "object", rawBucket).resourceId;
      if (isUnsafeObjectKey(bucketId)) continue;
      if (initialDefaultStorageBuckets.has(bucketId)) {
        if (rules.storage === undefined) {
          rules.storage = entryRules;
        }
        defineOwn(storageRuleMap, DEFAULT_SNAPSHOT_RESOURCE, entryRules);
      } else {
        namedStorageBuckets.add(bucketId);
        defineOwn(storageRuleMap, bucketId, entryRules);
        defineOwn(targetStorageBuckets, bucketId, entryRules);
      }
    }
  }
  if (Object.keys(targetStorageBuckets).length > 0) {
    rules.storageBuckets = targetStorageBuckets;
  }
  if (Object.keys(storageRuleMap).length > 0) {
    snapshotRules.storage = storageRuleMap;
  }

  const defaultStorageBuckets = computeLiveDefaultStorageBuckets({
    namedBuckets: namedStorageBuckets,
    defaultBucket: options.defaultBucket,
    projectId: inferredProjectId,
    storageEntries: stateBody?.storage,
  });

  const {
    storageSnapshotsByBucket,
    defaultStorageFixtures,
    namedStorageFixtures,
  } = await hydrateLiveStorageObjects({
    origin,
    headers,
    getLoopback,
    storageEntries: stateBody?.storage,
    namedStorageBuckets,
    defaultStorageBuckets,
  });

  const snapshotAuth: {
    users: SandboxSnapshot["auth"]["users"];
    providers?: Record<string, boolean>;
  } = {
    users: decodedState.snapshotUsers,
  };
  if (decodedState.authProviders !== undefined) {
    snapshotAuth.providers = { ...decodedState.authProviders };
  }
  const snapshot: SandboxSnapshot = {
    version: 1,
    rules: snapshotRules,
    auth: snapshotAuth,
    firestore: decodedState.firestoreByDb,
    rtdb: decodedState.rtdbByInstance,
    storage: storageSnapshotsByBucket,
  };

  const targetState: LocalFirebaseTarget["state"] = {};
  if (Object.keys(decodedState.defaultTargetFirestore).length > 0) {
    targetState.firestore = decodedState.defaultTargetFirestore;
  }
  if (decodedState.defaultTargetRtdb !== undefined) {
    targetState.rtdb = decodedState.defaultTargetRtdb;
  }
  if (rules.rtdbInstances !== undefined) {
    const declaredResolved = new Set<string>();
    for (const key of Object.keys(rules.rtdbInstances)) {
      try {
        declaredResolved.add(resolveDatabaseInstance(key)!.name);
      } catch {
        // Ignore malformed instance keys; target validation reports them.
      }
    }
    const targetRtdbInstances: Record<string, unknown> = {};
    for (const [instName, instTree] of Object.entries(
      decodedState.rtdbByInstance,
    )) {
      if (instName === DEFAULT_SNAPSHOT_RESOURCE || isUnsafeObjectKey(instName)) {
        continue;
      }
      try {
        const resolvedName = resolveDatabaseInstance(instName)!.name;
        if (declaredResolved.has(resolvedName)) {
          defineOwn(targetRtdbInstances, instName, structuredClone(instTree));
        }
      } catch {
        // Skip invalid instance key.
      }
    }
    if (Object.keys(targetRtdbInstances).length > 0) {
      targetState.rtdbInstances = targetRtdbInstances;
    }
  }
  if (defaultStorageFixtures.length > 0) {
    targetState.storage = defaultStorageFixtures;
  }
  if (Object.keys(namedStorageFixtures).length > 0) {
    targetState.storageBuckets = namedStorageFixtures;
  }
  if (decodedState.fixtureUsers.length > 0 || decodedState.authProviders !== undefined) {
    const targetAuth: NonNullable<LocalFirebaseTarget["state"]["auth"]> = {
      users: decodedState.fixtureUsers,
    };
    if (decodedState.authProviders !== undefined) {
      targetAuth.providers = { ...decodedState.authProviders };
    }
    targetState.auth = targetAuth;
  }

  const history = await fetchHostedEvents(
    origin,
    initPayload.instanceId,
    options.projectDir,
    effectiveCwd,
    customFetch,
    headers["x-pyric-session-token"],
  );

  return {
    origin,
    studioUrl: `${origin}/__pyric/ui/assurance`,
    snapshot,
    target: {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules,
      state: targetState,
    },
    history,
  };
}
