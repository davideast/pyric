import type { LocalSandbox, Sandbox } from "pyric/sandbox";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
} from "pyric/sandbox/internal";
import {
  ASSURANCE_TARGET_SCHEMA,
  AssuranceInputError,
  type AssuranceAttachmentInventory,
  type AssuranceAttachmentSource,
  type AssuranceCoverageGap,
  type AuthFixtureUser,
  type LocalFirebaseTarget,
  type StorageObjectFixture,
} from "./types.js";

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
}

export type {
  AssuranceAttachmentInventory,
  AssuranceAttachmentSource,
  AssuranceCoverageGap,
} from "./types.js";

interface PyricInitPayload {
  rules?: string | null;
  databaseRules?: { rules: Record<string, unknown> } | null;
  storageRules?: string | null;
  bridgeUrl?: string | null;
}

function isLoopbackHostname(hostname: string): boolean {
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
    !isLoopbackHostname(requested.hostname) ||
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

function hasRtdbState(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return true;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function resolveRuntimeOrigin(explicitOrigin: string | undefined): string {
  if (explicitOrigin !== undefined) return explicitOrigin;
  if (typeof globalThis.location !== "undefined") {
    return globalThis.location.origin;
  }
  return "";
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

    const response = await fetchImpl(`${origin}/__pyric/init.json`, {
      redirect: "error",
    });
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
    if (payload.databaseRules?.rules) rules.rtdb = payload.databaseRules;
    if (typeof payload.storageRules === "string" && payload.storageRules.trim()) {
      rules.storage = payload.storageRules;
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

/** The campaign target, inventory, and coverage gaps one sandbox's state produces. */
async function cloneSandboxTarget(
  sandbox: Sandbox,
  rules: LocalFirebaseTarget["rules"],
  source: AssuranceAttachmentSource,
): Promise<AssuranceAttachment> {
  const snapshot = await captureSandboxSnapshot(sandbox as LocalSandbox);
  const rawFirestoreDocs = snapshot.firestore[DEFAULT_SNAPSHOT_RESOURCE] ?? {};
  const firestoreDocs: Record<string, Record<string, unknown>> = {};
  for (const [docPath, encodedData] of Object.entries(rawFirestoreDocs)) {
    firestoreDocs[docPath] = { ...encodedData };
  }
  const rtdbState = snapshot.rtdb[DEFAULT_SNAPSHOT_RESOURCE] ?? null;
  const rawStorageObjects = snapshot.storage[DEFAULT_SNAPSHOT_RESOURCE] ?? [];

  const effectiveRules: LocalFirebaseTarget["rules"] = { ...rules };
  const activeStorageRules = snapshot.rules.storage?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (
    !effectiveRules.storage &&
    typeof activeStorageRules === "string" &&
    activeStorageRules.trim().length > 0
  ) {
    effectiveRules.storage = activeStorageRules;
  }

  const storageEntries: StorageObjectFixture[] = rawStorageObjects.map((item) => {
    const entry: StorageObjectFixture = {
      path: item.path,
      dataBase64: item.contentBase64,
    };
    if (item.contentType !== undefined) {
      entry.contentType = item.contentType;
    }
    if (item.customMetadata !== undefined) {
      entry.customMetadata = { ...item.customMetadata };
    }
    return entry;
  });

  const authUsers: AuthFixtureUser[] = snapshot.auth.users.map((user) => {
    const entry: AuthFixtureUser = { uid: user.uid };
    if (user.email !== undefined) {
      entry.email = user.email;
    }
    if (user.password !== undefined) {
      entry.password = user.password;
    }
    if (user.displayName !== undefined) {
      entry.displayName = user.displayName;
    }
    if (user.photoUrl !== undefined) {
      entry.photoUrl = user.photoUrl;
    }
    if (user.phoneNumber !== undefined) {
      entry.phoneNumber = user.phoneNumber;
    }
    if (user.tenantId !== undefined) {
      entry.tenantId = user.tenantId;
    }
    if (user.providerId !== undefined) {
      entry.providerId = user.providerId;
    }
    if (user.customClaims !== undefined) {
      entry.customClaims = { ...user.customClaims };
    }
    if (user.emailVerified === true) {
      entry.emailVerified = true;
    }
    if (user.disabled === true) {
      entry.disabled = true;
    }
    return entry;
  });

  const coverageGaps: AssuranceCoverageGap[] = [];
  if (!effectiveRules.firestore && Object.keys(firestoreDocs).length > 0) {
    coverageGaps.push({
      service: "firestore",
      code: "firestore-rules-unavailable",
      reason:
        "The running sandbox has Firestore data but no explicit project rules source.",
    });
  }
  if (!effectiveRules.rtdb && hasRtdbState(rtdbState)) {
    coverageGaps.push({
      service: "rtdb",
      code: "rtdb-rules-unavailable",
      reason:
        "The running sandbox has RTDB data but no explicit database rules source.",
    });
  }
  if (!effectiveRules.storage && storageEntries.length > 0) {
    coverageGaps.push({
      service: "storage",
      code: "storage-rules-unavailable",
      reason:
        "The running sandbox has Storage objects but no explicit Storage rules source.",
    });
  }

  const state: LocalFirebaseTarget["state"] = {
    firestore: firestoreDocs,
    auth: { users: authUsers },
  };
  if (effectiveRules.rtdb || hasRtdbState(rtdbState)) {
    state.rtdb = rtdbState;
  }
  if (storageEntries.length > 0) {
    state.storage = storageEntries;
  }

  return {
    target: {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules: effectiveRules,
      state,
    },
    source,
    inventory: {
      firestoreDocuments: Object.keys(firestoreDocs).length,
      rtdbPresent: hasRtdbState(rtdbState),
      authUsers: authUsers.length,
      storageObjects: storageEntries.length,
    },
    coverageGaps,
  };
}
