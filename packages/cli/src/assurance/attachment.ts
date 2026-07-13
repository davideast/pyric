import { getAuth, sandbox as authSandbox } from "pyric/auth";
import {
  getAdminDatabase,
  sandbox as rtdbSandbox,
} from "pyric/database";
import type { Sandbox } from "pyric/sandbox";
import {
  ASSURANCE_TARGET_SCHEMA,
  AssuranceInputError,
  type AssuranceAttachmentInventory,
  type AssuranceAttachmentSource,
  type AssuranceCoverageGap,
  type LocalFirebaseTarget,
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
  bridgeUrl?: string | null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  )
    return true;
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
    const runtimeOrigin =
      options.origin ??
      (typeof globalThis.location !== "undefined"
        ? globalThis.location.origin
        : "");
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

    const snapshot = sandbox.snapshot();
    const rtdbState = rtdbSandbox.snapshotState(getAdminDatabase(sandbox));
    const authUsers = authSandbox.exportUsers(getAuth(sandbox));
    const rules: LocalFirebaseTarget["rules"] = {};
    if (typeof payload.rules === "string" && payload.rules.trim()) {
      rules.firestore = payload.rules;
    }
    if (payload.databaseRules?.rules) rules.rtdb = payload.databaseRules;

    const coverageGaps: AssuranceCoverageGap[] = [
      {
        service: "storage",
        code: "storage-attachment-unavailable",
        reason:
          "The served runtime does not yet expose Storage rules or complete object enumeration; provide explicit Storage rules and objects in a fixture campaign.",
      },
    ];
    if (!rules.firestore && Object.keys(snapshot.firestore).length > 0) {
      coverageGaps.push({
        service: "firestore",
        code: "firestore-rules-unavailable",
        reason:
          "The running sandbox has Firestore data but no explicit project rules source.",
      });
    }
    if (!rules.rtdb && hasRtdbState(rtdbState)) {
      coverageGaps.push({
        service: "rtdb",
        code: "rtdb-rules-unavailable",
        reason:
          "The running sandbox has RTDB data but no explicit database rules source.",
      });
    }

    return {
      target: {
        schema: ASSURANCE_TARGET_SCHEMA,
        network: "forbid",
        rules,
        state: {
          firestore: snapshot.firestore,
          ...(rules.rtdb || hasRtdbState(rtdbState) ? { rtdb: rtdbState } : {}),
          auth: {
            users: authUsers.map((user) => ({
              uid: user.uid,
              email: user.email,
              password: user.password,
              ...(user.customClaims ? { customClaims: user.customClaims } : {}),
            })),
          },
        },
      },
      source: {
        requestedUrl: url,
        origin,
        transport: "same-origin-shared-worker",
        readOnly: true,
        studioUrl: `${origin}/__pyric/ui/assurance`,
      },
      inventory: {
        firestoreDocuments: Object.keys(snapshot.firestore).length,
        rtdbPresent: hasRtdbState(rtdbState),
        authUsers: authUsers.length,
        storageObjects: 0,
      },
      coverageGaps,
    };
  };
}
