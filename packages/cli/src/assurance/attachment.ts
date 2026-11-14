import type { Sandbox } from "pyric/sandbox";
import { DEFAULT_SNAPSHOT_RESOURCE } from "pyric/sandbox/internal";
import { stampedSessionToken } from "../serve/runtime/hosted-target.js";
import {
  cloneOwnRecord,
  cloneSandboxTarget,
  setOwn,
} from "./attachment-target-clone.js";
import {
  AssuranceInputError,
  type AssuranceAttachmentInventory,
  type AssuranceAttachmentSource,
  type AssuranceCoverageGap,
  type LocalFirebaseTarget,
} from "./types.js";
import { normalizeStorageBucketInstance } from "./validation-target.js";

export interface AssuranceAttachmentInput {
  url: string;
}

export interface AssuranceAttachment {
  target: LocalFirebaseTarget;
  source: AssuranceAttachmentSource;
  inventory: AssuranceAttachmentInventory;
  coverageGaps: AssuranceCoverageGap[];
}

export type AssuranceAttachmentProvider = (
  input: AssuranceAttachmentInput,
) => Promise<AssuranceAttachment>;

export interface SandboxAttachmentProviderOptions {
  origin?: string;
  fetchImpl?: typeof fetch;
  sessionToken?: string;
}

export type {
  AssuranceAttachmentInventory,
  AssuranceAttachmentSource,
  AssuranceCoverageGap,
} from "./types.js";

interface PyricInitPayload {
  rules?: string | null;
  databaseRules?: { rules: Record<string, unknown> } | null;
  databaseInstances?: {
    defaultInstance?: string;
    projectId?: string;
    rules?: Record<string, { rules: Record<string, unknown> } | null>;
  } | null;
  storageRules?: string | null;
  storageBucketRules?: Record<
    string,
    string | { rules: string; rulesHash?: string } | null
  > | null;
  bridgeUrl?: string | null;
}

function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  ) {
    return true;
  }
  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function parseLocalOrigin(rawUrl: string, runtimeOrigin: string): URL {
  let requested: URL;
  let current: URL;
  try {
    requested = new URL(rawUrl);
    current = new URL(runtimeOrigin);
  } catch {
    throw new AssuranceInputError(
      `'${rawUrl}' is not a valid absolute Pyric URL.`,
    );
  }
  if (
    (requested.protocol !== "http:" && requested.protocol !== "https:") ||
    !isLoopbackHost(requested.hostname) ||
    requested.username ||
    requested.password
  ) {
    throw new AssuranceInputError(
      "firebase_assurance_attach accepts only credential-free HTTP(S) loopback URLs.",
    );
  }
  if (requested.origin !== current.origin) {
    throw new AssuranceInputError(
      `attachment URL origin '${requested.origin}' does not match the connected Pyric sandbox origin '${current.origin}'.`,
    );
  }
  return requested;
}

function resolveRuntimeOrigin(explicitOrigin: string | undefined): string {
  if (explicitOrigin !== undefined) return explicitOrigin;
  if (typeof globalThis.location !== "undefined") {
    return globalThis.location.origin;
  }
  return "";
}

function extractBucketRulesText(
  entry: string | { rules: string; rulesHash?: string } | null,
): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.rules === "string") {
    return entry.rules;
  }
  return undefined;
}

/**
 * Clone the sandbox currently hosting the connected bridge peer. The URL is an
 * origin assertion and source for explicit rules metadata; no arbitrary host is
 * contacted and the returned campaign target itself keeps networking forbidden.
 */
export function createSandboxAttachmentProvider(
  sandbox: Sandbox,
  options: SandboxAttachmentProviderOptions = {},
): AssuranceAttachmentProvider {
  return async ({ url }) => {
    const runtimeOrigin = resolveRuntimeOrigin(options.origin);
    if (!runtimeOrigin) {
      throw new AssuranceInputError(
        "localhost attachment is available only inside a served Pyric sandbox peer.",
      );
    }
    const requested = parseLocalOrigin(url, runtimeOrigin);
    const origin = requested.origin;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new AssuranceInputError(
        "localhost attachment requires the Fetch API.",
      );
    }

    const token = options.sessionToken ?? stampedSessionToken();
    const requestInit: RequestInit = { redirect: "error" };
    if (token !== undefined) {
      requestInit.headers = { "x-pyric-session-token": token };
    }
    const response = await fetchImpl(`${origin}/__pyric/init.json`, requestInit);
    if (!response.ok) {
      throw new AssuranceInputError(
        `Pyric initialization metadata returned HTTP ${response.status} at '${origin}'.`,
      );
    }
    const payload = (await response.json()) as PyricInitPayload;
    if (!payload || typeof payload !== "object" || !payload.bridgeUrl) {
      throw new AssuranceInputError(
        `No active Pyric bridge was advertised by '${origin}/__pyric/init.json'.`,
      );
    }

    const rules: LocalFirebaseTarget["rules"] = {};
    if (typeof payload.rules === "string" && payload.rules.trim()) {
      rules.firestore = payload.rules;
    }
    if (payload.databaseRules?.rules) {
      rules.rtdb = { rules: cloneOwnRecord(payload.databaseRules.rules) };
    }
    if (
      payload.databaseInstances &&
      typeof payload.databaseInstances === "object" &&
      !Array.isArray(payload.databaseInstances) &&
      payload.databaseInstances.rules &&
      typeof payload.databaseInstances.rules === "object" &&
      !Array.isArray(payload.databaseInstances.rules)
    ) {
      let defaultInst: string | undefined;
      if (typeof payload.databaseInstances.defaultInstance === "string") {
        defaultInst = payload.databaseInstances.defaultInstance;
      }
      const rtdbInstances: Record<string, { rules: Record<string, unknown> }> =
        {};
      for (const [instName, wrapper] of Object.entries(
        payload.databaseInstances.rules,
      )) {
        if (isUnsafeKey(instName)) continue;
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
        const cloned = { rules: cloneOwnRecord(wrapper.rules) };
        if (
          instName === DEFAULT_SNAPSHOT_RESOURCE ||
          (defaultInst !== undefined && instName === defaultInst)
        ) {
          if (rules.rtdb === undefined) {
            rules.rtdb = cloned;
          }
        } else {
          setOwn(rtdbInstances, instName, cloned);
        }
      }
      if (Object.keys(rtdbInstances).length > 0) {
        rules.rtdbInstances = rtdbInstances;
      }
    }
    if (typeof payload.storageRules === "string" && payload.storageRules.trim()) {
      rules.storage = payload.storageRules;
    }
    if (
      payload.storageBucketRules &&
      typeof payload.storageBucketRules === "object" &&
      !Array.isArray(payload.storageBucketRules)
    ) {
      const storageBuckets: Record<string, string> = {};
      for (const [rawBucket, entry] of Object.entries(
        payload.storageBucketRules,
      )) {
        const rawSource = extractBucketRulesText(entry);
        if (typeof rawSource !== "string" || !rawSource.trim()) continue;
        const normalizedBucket = normalizeStorageBucketInstance(rawBucket);
        if (normalizedBucket === undefined) {
          if (rules.storage === undefined) {
            rules.storage = rawSource;
          }
        } else if (!isUnsafeKey(normalizedBucket)) {
          setOwn(storageBuckets, normalizedBucket, rawSource);
        }
      }
      if (Object.keys(storageBuckets).length > 0) {
        rules.storageBuckets = storageBuckets;
      }
    }

    return cloneSandboxTarget(sandbox, rules, {
      requestedUrl: url,
      origin,
      transport: "same-origin-shared-worker",
      readOnly: true,
      studioUrl: `${origin}/__pyric/ui/assurance`,
    });
  };
}

/**
 * Clone the sandbox this process owns, with no origin to assert and nothing
 * to contact.
 */
export function createOwnedSandboxAttachmentProvider(
  sandbox: Sandbox,
  rules: LocalFirebaseTarget["rules"],
  studioUrl: string,
): AssuranceAttachmentProvider {
  return async ({ url }) =>
    cloneSandboxTarget(sandbox, rules, {
      requestedUrl: url,
      origin: url,
      transport: "in-process-sandbox",
      readOnly: true,
      studioUrl,
    });
}
