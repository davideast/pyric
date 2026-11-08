/**
 * Read-only loopback HTTP state and event cloner for `deriveAssurance` and
 * `pyric assurance derive --port / --url`. Never mutates the running server.
 */
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  encodeBytesToBase64,
  type SandboxSnapshot,
  type SnapshotStorageObject,
} from "pyric/sandbox/internal";
import type { SandboxHistoryEvent } from "pyric/rules/internal/usage";
import { boundedFetch } from "../bounded-request.js";
import { HOSTED_METHOD_PATH } from "../serve/hosted/method-protocol.js";
import {
  isStorageReference,
  parseStateFile,
  type PyricStateFile,
} from "../serve/state-file.js";
import { isLoopbackHost } from "./attachment.js";
import { defineOwn } from "./derive-campaign-state.js";
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
  readonly storageRules?: string | null;
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

async function readStreamBase64(response: Response): Promise<string> {
  const buf = new Uint8Array(await response.arrayBuffer());
  return encodeBytesToBase64(buf);
}

async function fetchHostedEvents(
  origin: string,
  instanceId: string | null | undefined,
  projectDir: string | undefined,
  customFetch: typeof fetch | undefined,
): Promise<SandboxHistoryEvent[]> {
  if (!instanceId || !projectDir) return [];
  try {
    const reqOpts: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
      customFetch?: typeof fetch;
    } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId,
        projectDir,
        key: "sandbox.events",
        args: { limit: 500 },
        allowProduction: false,
      }),
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

export async function cloneLoopbackSandboxHttp(
  rawUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    projectDir?: string;
  } = {},
): Promise<LoopbackCloneResult> {
  const parsedUrl = parseLoopbackOrigin(rawUrl);
  const origin = parsedUrl.origin;
  const customFetch = options.fetchImpl;
  const getLoopback = async (
    targetUrl: string,
    headers: Record<string, string>,
  ): Promise<Response> => {
    const reqOpts: {
      method: "GET";
      headers: Record<string, string>;
      customFetch?: typeof fetch;
    } = {
      method: "GET",
      headers,
    };
    if (customFetch !== undefined) {
      reqOpts.customFetch = customFetch;
    }
    return requestLoopback(targetUrl, reqOpts);
  };

  let initRes: Response;
  try {
    initRes = await getLoopback(`${origin}/__pyric/init.json`, {});
  } catch (error) {
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
  if (
    typeof initPayload.sessionToken === "string" &&
    initPayload.sessionToken.length > 0
  ) {
    headers["x-pyric-session-token"] = initPayload.sessionToken;
  }

  let stateBody: PyricStateFile | null = null;
  let stateRes: Response | null = null;
  try {
    stateRes = await getLoopback(`${origin}/__pyric/state`, headers);
  } catch {
    stateRes = null;
  }

  if (stateRes !== null && stateRes.status === 200) {
    let rawState: unknown;
    try {
      rawState = await stateRes.json();
      stateBody = parseStateFile(rawState, "/__pyric/state");
    } catch (error) {
      let detail = String(error);
      if (error instanceof Error) detail = error.message;
      throw new AssuranceInputError(
        `Invalid Pyric state payload from '${origin}/__pyric/state': ${detail}`,
      );
    }
  }

  const decodedState = decodeLiveStatePayload(stateBody);
  const storageSnapshots: SnapshotStorageObject[] = [];
  const storageFixtures: StorageObjectFixture[] = [];

  for (const entry of stateBody?.storage ?? []) {
    let base64 = "";
    if (isStorageReference(entry)) {
      if (!SHA256_HEX_RE.test(entry.sha256)) {
        throw new AssuranceInputError(
          `Invalid Storage object sha256 digest '${entry.sha256}'.`,
        );
      }
      const objRes = await getLoopback(
        `${origin}/__pyric/state/objects/${entry.sha256}`,
        headers,
      );
      if (objRes.status === 200) {
        base64 = await readStreamBase64(objRes);
      }
    } else {
      base64 = entry.dataBase64;
    }

    const fullPath = entry.metadata.fullPath;
    const snapObj: {
      path: string;
      contentBase64: string;
      size: number;
      contentType?: string;
      customMetadata?: Record<string, string>;
    } = {
      path: fullPath,
      contentBase64: base64,
      size: entry.metadata.size,
    };
    const fixObj: StorageObjectFixture = {
      path: fullPath,
      dataBase64: base64,
    };
    if (typeof entry.metadata.contentType === "string") {
      snapObj.contentType = entry.metadata.contentType;
      fixObj.contentType = entry.metadata.contentType;
    }
    if (entry.metadata.customMetadata) {
      snapObj.customMetadata = { ...entry.metadata.customMetadata };
      fixObj.customMetadata = { ...entry.metadata.customMetadata };
    }
    storageSnapshots.push(snapObj);
    storageFixtures.push(fixObj);
  }

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
  if (initPayload.databaseRules?.rules) {
    rules.rtdb = { rules: { ...initPayload.databaseRules.rules } };
    defineOwn(
      rtdbRuleMap,
      DEFAULT_SNAPSHOT_RESOURCE,
      JSON.stringify(initPayload.databaseRules),
    );
  }
  for (const [instName, instRules] of Object.entries(
    decodedState.rtdbInstanceRules,
  )) {
    defineOwn(rtdbRuleMap, instName, JSON.stringify(instRules));
  }
  if (Object.keys(decodedState.rtdbInstanceRules).length > 0) {
    rules.rtdbInstances = { ...decodedState.rtdbInstanceRules };
  }
  if (Object.keys(rtdbRuleMap).length > 0) {
    snapshotRules.rtdb = rtdbRuleMap;
  }

  if (
    typeof initPayload.storageRules === "string" &&
    initPayload.storageRules.trim().length > 0
  ) {
    rules.storage = initPayload.storageRules;
    snapshotRules.storage = { [DEFAULT_SNAPSHOT_RESOURCE]: initPayload.storageRules };
  }

  const snapshot: SandboxSnapshot = {
    version: 1,
    rules: snapshotRules,
    auth: { users: decodedState.snapshotUsers },
    firestore: decodedState.firestoreByDb,
    rtdb: decodedState.rtdbByInstance,
    storage: { [DEFAULT_SNAPSHOT_RESOURCE]: storageSnapshots },
  };

  const targetState: LocalFirebaseTarget["state"] = {};
  if (Object.keys(decodedState.defaultTargetFirestore).length > 0) {
    targetState.firestore = decodedState.defaultTargetFirestore;
  }
  if (decodedState.defaultTargetRtdb !== undefined) {
    targetState.rtdb = decodedState.defaultTargetRtdb;
  }
  if (storageFixtures.length > 0) {
    targetState.storage = storageFixtures;
  }
  if (decodedState.fixtureUsers.length > 0) {
    targetState.auth = { users: decodedState.fixtureUsers };
  }

  const history = await fetchHostedEvents(
    origin,
    initPayload.instanceId,
    options.projectDir,
    customFetch,
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
