/**
 * Read-only loopback HTTP state and event cloner for `deriveAssurance` and
 * `pyric assurance derive --port / --url`. Never mutates the running server.
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  encodeBytesToBase64,
  parseResourcePattern,
  resolveDatabaseInstance,
  type SandboxSnapshot,
  type SnapshotStorageObject,
} from "pyric/sandbox/internal";
import type { SandboxHistoryEvent } from "pyric/rules/internal/usage";
import { DEFAULT_BUCKET } from "pyric/storage/internal";
import { boundedFetch } from "../bounded-request.js";
import { HOSTED_METHOD_PATH } from "../serve/hosted/method-protocol.js";
import {
  fetchLoopbackTarget,
  resolveSessionTokenForTarget,
} from "../serve/local-session-token.js";
import {
  isStorageReference,
  parseStateFile,
  type PyricStateFile,
} from "../serve/state-file.js";
import { isLoopbackHost } from "./attachment.js";
import { defineOwn, getOwn, isUnsafeObjectKey } from "./derive-campaign-state.js";
import { decodeLiveStatePayload } from "./derive-live-state.js";
import {
  ASSURANCE_TARGET_SCHEMA,
  AssuranceInputError,
  type LocalFirebaseTarget,
  type StorageObjectFixture,
} from "./types.js";

export { isLoopbackHost };

const LOOPBACK_DEADLINE_MS = 1_500;
const MAX_CLONE_RESPONSE_BYTES = 64 * 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

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
    Record<string, { readonly rules: string; readonly rulesHash?: string } | null>
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

export function parseLoopbackOrigin(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AssuranceInputError(`'${rawUrl}' is not a valid absolute URL.`);
  }
  const validProtocol =
    parsed.protocol === "http:" || parsed.protocol === "https:";
  if (
    !validProtocol ||
    !isLoopbackHost(parsed.hostname) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new AssuranceInputError(
      "Assurance live attachment accepts only credential-free HTTP(S) loopback URLs.",
    );
  }
  return parsed;
}

async function requestLoopback(
  targetUrl: string,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    cwd?: string;
    customFetch?: typeof fetch;
  },
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  if (options.customFetch !== undefined) {
    const init: RequestInit = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(LOOPBACK_DEADLINE_MS),
    };
    if (options.body !== undefined) {
      init.body = options.body;
    }
    return options.customFetch(targetUrl, init);
  }

  if (targetUrl.startsWith("https://")) {
    const init: RequestInit = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(LOOPBACK_DEADLINE_MS),
    };
    if (options.body !== undefined) {
      init.body = options.body;
    }
    const res = await fetchLoopbackTarget(targetUrl, init, options.cwd);
    if (res.status >= 300 && res.status < 400) {
      throw new TypeError(`fetch failed: ${targetUrl} redirected`);
    }
    return res;
  }

  const boundedOpts: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    deadlineMs: number;
    maxBytes: number;
    redirect: "error";
  } = {
    method,
    headers,
    deadlineMs: LOOPBACK_DEADLINE_MS,
    maxBytes: MAX_CLONE_RESPONSE_BYTES,
    redirect: "error",
  };
  if (options.body !== undefined) {
    boundedOpts.body = options.body;
  }
  return boundedFetch(targetUrl, boundedOpts);
}

async function fetchHostedEvents(
  origin: string,
  instanceId: string | null | undefined,
  projectDir: string | undefined,
  effectiveCwd: string,
  customFetch: typeof fetch | undefined,
  sessionToken: string | undefined,
): Promise<SandboxHistoryEvent[]> {
  if (!instanceId || !projectDir) return [];
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sessionToken !== undefined && sessionToken.length > 0) {
      headers["x-pyric-session-token"] = sessionToken;
    }
    const reqOpts: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
      cwd: string;
      customFetch?: typeof fetch;
    } = {
      method: "POST",
      headers,
      body: JSON.stringify({
        instanceId,
        projectDir,
        key: "sandbox.events",
        args: { limit: 500 },
        allowProduction: false,
      }),
      cwd: effectiveCwd,
    };
    if (customFetch !== undefined) {
      reqOpts.customFetch = customFetch;
    }
    const res = await requestLoopback(`${origin}${HOSTED_METHOD_PATH}`, reqOpts);
    if (!res.ok) return [];
    const payload = (await res.json()) as {
      ok?: boolean;
      data?: { events?: unknown };
    };
    if (!payload.ok || !Array.isArray(payload.data?.events)) return [];
    const out: SandboxHistoryEvent[] = [];
    for (const item of payload.data.events) {
      if (item !== null && typeof item === "object" && Object.hasOwn(item, "kind")) {
        out.push(item as SandboxHistoryEvent);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function resolveLiveStorageBucketKey(
  rawBucket: unknown,
  namedBuckets: ReadonlySet<string>,
  defaultBucket: string | undefined,
): string {
  if (typeof rawBucket !== "string" || rawBucket.trim().length === 0) {
    return DEFAULT_SNAPSHOT_RESOURCE;
  }
  const normalized = parseResourcePattern("storage", "object", rawBucket).resourceId;
  if (isUnsafeObjectKey(normalized)) {
    return DEFAULT_SNAPSHOT_RESOURCE;
  }
  if (namedBuckets.has(normalized)) {
    return normalized;
  }
  if (
    normalized === DEFAULT_SNAPSHOT_RESOURCE ||
    normalized === "default" ||
    normalized === "default-bucket" ||
    normalized === "pyric-default" ||
    normalized === DEFAULT_BUCKET ||
    (defaultBucket !== undefined && normalized === defaultBucket) ||
    normalized.endsWith(".appspot.com") ||
    normalized.endsWith(".firebasestorage.app")
  ) {
    return DEFAULT_SNAPSHOT_RESOURCE;
  }
  return normalized;
}

export async function cloneLoopbackSandboxHttp(
  rawUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    projectDir?: string;
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
    initRes = await getLoopback(
      `${origin}/__pyric/init.json`,
      initialToken !== undefined ? { "x-pyric-session-token": initialToken } : {},
    );
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
  const effectiveToken =
    typeof initPayload.sessionToken === "string" && initPayload.sessionToken.length > 0
      ? initPayload.sessionToken
      : initialToken;
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
    const defaultInstName =
      typeof initDbInstances.defaultInstance === "string"
        ? initDbInstances.defaultInstance
        : undefined;
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
  const isDefaultStorageBucket = (bucketId: string): boolean =>
    bucketId === DEFAULT_SNAPSHOT_RESOURCE ||
    bucketId === DEFAULT_BUCKET ||
    (options.defaultBucket !== undefined && bucketId === options.defaultBucket);
  for (const configured of options.configuredBuckets ?? []) {
    const norm = parseResourcePattern("storage", "object", configured).resourceId;
    if (!isDefaultStorageBucket(norm) && !isUnsafeObjectKey(norm)) {
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
      const entryRules =
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && typeof entry.rules === "string"
            ? entry.rules
            : undefined;
      if (entryRules === undefined || entryRules.trim().length === 0) {
        continue;
      }
      const bucketId = parseResourcePattern("storage", "object", rawBucket).resourceId;
      if (isUnsafeObjectKey(bucketId)) continue;
      if (isDefaultStorageBucket(bucketId)) {
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

  const storageSnapshotsByBucket: Record<string, SnapshotStorageObject[]> = {
    [DEFAULT_SNAPSHOT_RESOURCE]: [],
  };
  const defaultStorageFixtures: StorageObjectFixture[] = [];
  const namedStorageFixtures: Record<string, StorageObjectFixture[]> = {};

  for (const entry of stateBody?.storage ?? []) {
    let base64 = "";
    let actualByteLength = entry.metadata.size;
    if (isStorageReference(entry)) {
      if (!SHA256_HEX_RE.test(entry.sha256)) {
        throw new AssuranceInputError(
          `Invalid Storage object sha256 digest '${entry.sha256}'.`,
        );
      }
      let objRes: Response;
      try {
        objRes = await getLoopback(
          `${origin}/__pyric/state/objects/${entry.sha256}`,
          headers,
        );
      } catch (error) {
        if (error instanceof AssuranceInputError) throw error;
        let detail = String(error);
        if (error instanceof Error) detail = error.message;
        throw new AssuranceInputError(
          `Unable to fetch Storage object '${entry.sha256}' from '${origin}': ${detail}`,
        );
      }
      if (objRes.status !== 200) {
        throw new AssuranceInputError(
          `Storage object '${entry.sha256}' returned HTTP ${objRes.status} at '${origin}'.`,
        );
      }
      const bytes = new Uint8Array(await objRes.arrayBuffer());
      if (bytes.byteLength !== entry.size) {
        throw new AssuranceInputError(
          `Storage object '${entry.sha256}' byte length mismatch: expected ${entry.size}, received ${bytes.byteLength}.`,
        );
      }
      const computedSha = createHash("sha256").update(bytes).digest("hex");
      if (computedSha !== entry.sha256) {
        throw new AssuranceInputError(
          `Storage object '${entry.sha256}' sha256 digest mismatch.`,
        );
      }
      actualByteLength = bytes.byteLength;
      base64 = encodeBytesToBase64(bytes);
    } else {
      base64 = entry.dataBase64;
    }

    const bucketKey = resolveLiveStorageBucketKey(
      entry.metadata.bucket,
      namedStorageBuckets,
      options.defaultBucket,
    );
    const fullPath = entry.metadata.fullPath;
    const snapObj: {
      path: string;
      contentBase64: string;
      size: number;
      generation?: string;
      metageneration?: string;
      contentType?: string;
      blobType?: string;
      cacheControl?: string;
      contentDisposition?: string;
      contentEncoding?: string;
      contentLanguage?: string;
      timeCreated?: string;
      updated?: string;
      downloadTokens?: string;
      md5Hash?: string;
      customMetadata?: Record<string, string>;
    } = {
      path: fullPath,
      contentBase64: base64,
      size: actualByteLength,
    };
    const fixObj: StorageObjectFixture = {
      path: fullPath,
      dataBase64: base64,
    };
    if (typeof entry.metadata.generation === "string") {
      snapObj.generation = entry.metadata.generation;
    }
    if (typeof entry.metadata.metageneration === "string") {
      snapObj.metageneration = entry.metadata.metageneration;
    }
    if (typeof entry.metadata.contentType === "string") {
      snapObj.contentType = entry.metadata.contentType;
      fixObj.contentType = entry.metadata.contentType;
    }
    if (
      typeof entry.blobType === "string" &&
      entry.blobType !== (entry.metadata.contentType ?? "")
    ) {
      snapObj.blobType = entry.blobType;
    }
    if (typeof entry.metadata.cacheControl === "string") {
      snapObj.cacheControl = entry.metadata.cacheControl;
      fixObj.cacheControl = entry.metadata.cacheControl;
    }
    if (typeof entry.metadata.contentDisposition === "string") {
      snapObj.contentDisposition = entry.metadata.contentDisposition;
      fixObj.contentDisposition = entry.metadata.contentDisposition;
    }
    if (typeof entry.metadata.contentEncoding === "string") {
      snapObj.contentEncoding = entry.metadata.contentEncoding;
      fixObj.contentEncoding = entry.metadata.contentEncoding;
    }
    if (typeof entry.metadata.contentLanguage === "string") {
      snapObj.contentLanguage = entry.metadata.contentLanguage;
      fixObj.contentLanguage = entry.metadata.contentLanguage;
    }
    if (typeof entry.metadata.timeCreated === "string") {
      snapObj.timeCreated = entry.metadata.timeCreated;
      fixObj.timeCreated = entry.metadata.timeCreated;
    }
    if (typeof entry.metadata.updated === "string") {
      snapObj.updated = entry.metadata.updated;
      fixObj.updated = entry.metadata.updated;
    }
    if (typeof entry.metadata.downloadTokens === "string") {
      snapObj.downloadTokens = entry.metadata.downloadTokens;
    }
    if (typeof entry.metadata.md5Hash === "string") {
      snapObj.md5Hash = entry.metadata.md5Hash;
    }
    if (entry.metadata.customMetadata) {
      const customCopy: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.metadata.customMetadata)) {
        if (typeof v === "string") defineOwn(customCopy, k, v);
      }
      snapObj.customMetadata = { ...customCopy };
      fixObj.customMetadata = { ...customCopy };
    }
    let bucketSnapshots = getOwn(storageSnapshotsByBucket, bucketKey);
    if (bucketSnapshots === undefined) {
      bucketSnapshots = [];
      defineOwn(storageSnapshotsByBucket, bucketKey, bucketSnapshots);
    }
    bucketSnapshots.push(snapObj);

    if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE) {
      defaultStorageFixtures.push(fixObj);
    } else {
      let bucketFixtures = getOwn(namedStorageFixtures, bucketKey);
      if (bucketFixtures === undefined) {
        bucketFixtures = [];
        defineOwn(namedStorageFixtures, bucketKey, bucketFixtures);
      }
      bucketFixtures.push(fixObj);
    }
  }

  const snapshot: SandboxSnapshot = {
    version: 1,
    rules: snapshotRules,
    auth: {
      users: decodedState.snapshotUsers,
      ...(decodedState.authProviders !== undefined
        ? { providers: { ...decodedState.authProviders } }
        : {}),
    },
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
    targetState.auth = {
      users: decodedState.fixtureUsers,
      ...(decodedState.authProviders !== undefined
        ? { providers: { ...decodedState.authProviders } }
        : {}),
    };
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
