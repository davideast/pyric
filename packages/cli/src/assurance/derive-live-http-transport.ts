/**
 * Loopback URL validation, bounded HTTP/HTTPS request execution, and hosted
 * `sandbox.events` retrieval for `derive-live-http.ts`.
 */
import type { SandboxHistoryEvent } from "pyric/rules/internal/usage";
import { boundedFetch } from "../bounded-request.js";
import { HOSTED_METHOD_PATH } from "../serve/hosted/method-protocol.js";
import { fetchLoopbackTarget } from "../serve/local-session-token.js";
import { isLoopbackHost } from "./attachment.js";
import { AssuranceInputError } from "./types.js";

const LOOPBACK_DEADLINE_MS = 1_500;
const MAX_CLONE_RESPONSE_BYTES = 64 * 1024 * 1024;

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

export async function requestLoopback(
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

export async function fetchHostedEvents(
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
