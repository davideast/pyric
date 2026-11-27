/**
 * Browser-safe bridge client for the Pyric Studio Functions inspector.
 *
 * Consumes existing read-only CLI surfaces:
 *   - POST /__pyric/hosted/method (`functions.listTriggers`, `functions.executions`,
 *     `functions.fire`, and family-specific manual fire methods when exposed)
 *   - Local Functions HTTP / Callable gateway endpoints (`/{projectId}/{region}/{exportName}`)
 *
 * Degrades cleanly when Studio runs without a Node-hosted bridge (SharedWorker
 * mode, static builds, dev-seed, or unreachable host).
 */

import { studioSessionHeaders } from '../../shell/serve-init.js';
import {
  asDiscoveredTriggers,
  asExecutions,
  asUnsupportedTriggers,
  cleanSubpath,
  parseResponseBody,
} from './bridge-parse.js';
import {
  DEFAULT_FUNCTION_REGION,
  DEFAULT_PROJECT_ID,
  classifyTriggerFamily,
  fireCapability,
  triggerRegions,
} from './model.js';
import type {
  DiscoveredTrigger,
  FireOutcome,
  FireTriggerInput,
  FunctionsApi,
  FunctionsApiResult,
} from './types.js';

export { resolveBridgeMetadata } from './bridge-parse.js';

const HOSTED_METHOD_PATH = '/__pyric/hosted/method';
const HEALTH_PATH = '/__pyric/health';

export interface FunctionsBridgeConfig {
  baseUrl?: string;
  instanceId?: string | null;
  projectDir?: string | null;
  projectId?: string | null;
  sessionToken?: string | null;
  fetchImpl?: typeof fetch;
}

interface HostedMethodResponse {
  ok: boolean;
  summary: string;
  data?: unknown;
}

function joinBase(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

interface HealthMetadata {
  instanceId: string | null;
  projectId: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function resolveHealthMetadata(
  fetchImpl: typeof fetch,
  baseUrl: string,
  sessionToken: string | null | undefined,
  signal?: AbortSignal,
): Promise<{ ok: boolean; meta: HealthMetadata }> {
  try {
    const headers = studioSessionHeaders(sessionToken);
    const res = await fetchImpl(joinBase(baseUrl, HEALTH_PATH), {
      cache: 'no-store',
      signal,
      ...(headers ? { headers } : {}),
    });
    if (!res.ok) return { ok: false, meta: { instanceId: null, projectId: null } };
    const body = (await res.json()) as { instanceId?: unknown; project?: unknown };
    return {
      ok: true,
      meta: {
        instanceId: nonEmptyString(body.instanceId),
        projectId: nonEmptyString(body.project),
      },
    };
  } catch {
    return { ok: false, meta: { instanceId: null, projectId: null } };
  }
}

function sanitizeUnknownMethodMessage(
  rawMessage: string,
  familyLabel: string,
  triggerName: string,
): string {
  if (/unknown surface method/i.test(rawMessage)) {
    return `Manual fire for ${familyLabel} triggers (${triggerName}) is not exposed by this CLI host yet.`;
  }
  return rawMessage;
}

/**
 * Create a {@link FunctionsApi} backed by the served Pyric host's
 * `/__pyric/hosted/method` bridge endpoint and local Functions HTTP gateway.
 */
export function createFunctionsBridgeApi(config: FunctionsBridgeConfig): FunctionsApi {
  const baseUrl = config.baseUrl ?? '';
  const fetchImpl = config.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
  let cachedInstanceId = config.instanceId ?? null;
  let cachedProjectId = config.projectId ?? null;
  let healthHydrated = false;
  let inflightHealth: Promise<void> | null = null;
  const projectDir = config.projectDir ?? null;
  const sessionToken = config.sessionToken ?? null;
  const origin =
    baseUrl || (typeof window !== 'undefined' && window.location ? window.location.origin : '');

  async function ensureHealthMetadata(signal?: AbortSignal): Promise<void> {
    if (!fetchImpl || healthHydrated) return;
    if (inflightHealth) {
      await inflightHealth;
      return;
    }
    const pending = (async () => {
      const result = await resolveHealthMetadata(fetchImpl, baseUrl, sessionToken, signal);
      if (result.meta.instanceId && !cachedInstanceId) {
        cachedInstanceId = result.meta.instanceId;
      }
      if (result.meta.projectId && !cachedProjectId) {
        cachedProjectId = result.meta.projectId;
      }
      if (result.ok || !signal?.aborted) {
        healthHydrated = true;
      }
    })();
    inflightHealth = pending;
    try {
      await pending;
    } finally {
      if (inflightHealth === pending) {
        inflightHealth = null;
      }
    }
  }

  async function callHostedMethod(
    key: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<FunctionsApiResult<HostedMethodResponse>> {
    if (!fetchImpl) {
      return {
        ok: false,
        failure: { kind: 'no-bridge', message: 'Fetch is unavailable in this environment.' },
      };
    }
    if (!projectDir) {
      return {
        ok: false,
        failure: {
          kind: 'shared-worker-fallback',
          message: 'Functions bridge methods require a Node-hosted sandbox (pyric sandbox).',
        },
      };
    }
    if (!cachedInstanceId) {
      await ensureHealthMetadata(signal);
    }
    if (!cachedInstanceId) {
      return {
        ok: false,
        failure: {
          kind: 'shared-worker-fallback',
          message:
            'Functions bridge methods are unavailable on this host (no Node host instanceId).',
        },
      };
    }

    const authHeaders = studioSessionHeaders(sessionToken);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(authHeaders ?? {}),
    };

    let res: Response;
    try {
      res = await fetchImpl(joinBase(baseUrl, HOSTED_METHOD_PATH), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          instanceId: cachedInstanceId,
          projectDir,
          key,
          args,
          allowProduction: false,
        }),
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        failure: { kind: 'error', message: `Bridge request failed: ${message}` },
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        failure: {
          kind: 'shared-worker-fallback',
          message:
            'This host is running without the Node-hosted method endpoint. Start with pyric sandbox to inspect and fire Functions triggers.',
        },
      };
    }
    if (res.status === 409) {
      cachedInstanceId = null;
      healthHydrated = false;
      return {
        ok: false,
        failure: {
          kind: 'stale-instance',
          message: 'The host restarted with a new instance id. Click Refresh to reconnect.',
        },
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        failure: {
          kind: 'unauthorized',
          message: `Functions bridge request refused (HTTP ${res.status}). Reload Studio to refresh your session token.`,
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return {
        ok: false,
        failure: {
          kind: 'error',
          message: `Functions bridge returned HTTP ${res.status} with non-JSON body.`,
        },
      };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return {
        ok: false,
        failure: { kind: 'error', message: 'Functions bridge returned an invalid payload.' },
      };
    }
    const body = parsed as Partial<HostedMethodResponse>;
    if (!res.ok && body.ok !== false) {
      return {
        ok: false,
        failure: {
          kind: 'error',
          message:
            typeof body.summary === 'string' && body.summary.length > 0
              ? body.summary
              : `Functions bridge returned HTTP ${res.status}.`,
        },
      };
    }
    return {
      ok: true,
      data: {
        ok: body.ok === true,
        summary: typeof body.summary === 'string' ? body.summary : '',
        data: body.data,
      },
    };
  }

  async function fireViaGatewayHttp(
    trigger: DiscoveredTrigger,
    input: FireTriggerInput,
    signal?: AbortSignal,
  ): Promise<FireOutcome> {
    if (!fetchImpl) {
      return { ok: false, summary: 'Fetch is unavailable in this environment.' };
    }
    if (!cachedProjectId && !healthHydrated) {
      await ensureHealthMetadata(signal);
    }
    const region = input.region ?? triggerRegions(trigger)[0] ?? DEFAULT_FUNCTION_REGION;
    const resolvedProject = cachedProjectId ?? DEFAULT_PROJECT_ID;
    const family = classifyTriggerFamily(trigger.eventType);
    const subpath = family === 'http' ? cleanSubpath(input.path) : '';
    const url = joinBase(baseUrl, `/${resolvedProject}/${region}/${trigger.exportName}${subpath}`);
    const method = family === 'callable' ? 'POST' : (input.httpMethod ?? 'POST');
    const headers: Record<string, string> = {};
    let body: string | undefined;

    if (family === 'callable') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({ data: input.payload ?? {} });
    } else if (method !== 'GET' && input.payload !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(input.payload);
    }

    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const res = await fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
      });
      const elapsed =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
      const responseBody = await parseResponseBody(res);
      if (family === 'callable') {
        const envelope =
          typeof responseBody === 'object' && responseBody !== null
            ? (responseBody as { result?: unknown; error?: { message?: string } })
            : null;
        if (!res.ok || envelope?.error) {
          const errMessage =
            envelope?.error?.message ??
            (typeof responseBody === 'string' && responseBody.length > 0
              ? responseBody
              : `Callable responded HTTP ${res.status}`);
          return {
            ok: false,
            summary: `${trigger.exportName} failed (HTTP ${res.status}): ${errMessage}`,
            statusCode: res.status,
            durationMs: Math.round(elapsed),
            error: errMessage,
            result: responseBody,
          };
        }
        return {
          ok: true,
          summary: `Called ${trigger.exportName} (HTTP ${res.status})`,
          statusCode: res.status,
          durationMs: Math.round(elapsed),
          result: envelope && 'result' in envelope ? envelope.result : responseBody,
        };
      }

      if (!res.ok) {
        return {
          ok: false,
          summary: `${method} ${trigger.exportName}${subpath} responded HTTP ${res.status}`,
          statusCode: res.status,
          durationMs: Math.round(elapsed),
          error:
            typeof responseBody === 'string' && responseBody.length > 0
              ? responseBody
              : `HTTP ${res.status}`,
          result: responseBody,
        };
      }
      return {
        ok: true,
        summary: `${method} ${trigger.exportName}${subpath} responded HTTP ${res.status}`,
        statusCode: res.status,
        durationMs: Math.round(elapsed),
        result: responseBody,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `Failed to reach ${trigger.exportName}: ${message}`,
        error: message,
      };
    }
  }

  async function fireViaHostedMethod(
    key: string,
    args: Record<string, unknown>,
    familyLabel: string,
    triggerName: string,
    signal?: AbortSignal,
  ): Promise<FireOutcome> {
    const response = await callHostedMethod(key, args, signal);
    if (!response.ok) {
      const message = sanitizeUnknownMethodMessage(
        response.failure.message,
        familyLabel,
        triggerName,
      );
      return { ok: false, summary: message, error: message };
    }
    const payload = response.data;
    const detail =
      typeof payload.data === 'object' && payload.data !== null
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const executionId = typeof detail?.executionId === 'string' ? detail.executionId : undefined;
    const event =
      typeof detail?.event === 'object' && detail.event !== null
        ? (detail.event as Record<string, unknown>)
        : undefined;
    if (!payload.ok) {
      const rawMessage = payload.summary || `${familyLabel} fire failed for ${triggerName}.`;
      const message = sanitizeUnknownMethodMessage(rawMessage, familyLabel, triggerName);
      return {
        ok: false,
        summary: message,
        executionId,
        event,
        error: message,
      };
    }
    return {
      ok: true,
      summary: payload.summary || `Fired ${triggerName}.`,
      executionId,
      event,
      result: detail && 'result' in detail ? detail.result : payload.data,
    };
  }

  return {
    get projectId() {
      return cachedProjectId;
    },
    origin,

    async listTriggers(signal) {
      const res = await callHostedMethod('functions.listTriggers', {}, signal);
      if (!res.ok) return res;
      if (!res.data.ok) {
        return {
          ok: false,
          failure: { kind: 'error', message: res.data.summary || 'functions.listTriggers failed.' },
        };
      }
      if (!cachedProjectId && !healthHydrated) {
        await ensureHealthMetadata(signal);
      }
      const data = (res.data.data ?? {}) as { triggers?: unknown; unsupported?: unknown };
      return {
        ok: true,
        data: {
          triggers: asDiscoveredTriggers(data.triggers),
          unsupported: asUnsupportedTriggers(data.unsupported),
          summary: res.data.summary,
          projectId: cachedProjectId,
        },
      };
    },

    async listExecutions(since, signal) {
      const args: Record<string, unknown> = since === undefined ? {} : { since };
      const res = await callHostedMethod('functions.executions', args, signal);
      if (!res.ok) return res;
      if (!res.data.ok) {
        return {
          ok: false,
          failure: { kind: 'error', message: res.data.summary || 'functions.executions failed.' },
        };
      }
      const data = (res.data.data ?? {}) as { executions?: unknown };
      return { ok: true, data: asExecutions(data.executions) };
    },

    async fireTrigger(trigger, input, signal) {
      const capability = fireCapability(trigger);
      if (!capability.fireable) {
        return {
          ok: false,
          summary: `${trigger.exportName} is triggered automatically by sandbox mutations.`,
        };
      }
      if (capability.mode === 'http' || capability.mode === 'callable') {
        return fireViaGatewayHttp(trigger, input, signal);
      }
      if (capability.mode === 'rtdb-fire') {
        const args: Record<string, unknown> = {
          trigger: trigger.exportName,
          path: input.path ?? '',
          value: input.payload === undefined ? null : input.payload,
        };
        if (input.timeoutMs !== undefined) args.timeoutMs = input.timeoutMs;
        return fireViaHostedMethod('functions.fire', args, 'RTDB', trigger.exportName, signal);
      }
      if (capability.mode === 'scheduler') {
        const options =
          typeof input.payload === 'object' &&
          input.payload !== null &&
          !Array.isArray(input.payload)
            ? (input.payload as Record<string, unknown>)
            : {};
        return fireViaHostedMethod(
          'functions.triggerScheduled',
          { ...options, trigger: trigger.exportName },
          'Scheduler',
          trigger.exportName,
          signal,
        );
      }
      if (capability.mode === 'pubsub') {
        const args: Record<string, unknown> = {
          trigger: trigger.exportName,
          topic: trigger.topic ?? trigger.topicResource ?? trigger.exportName,
          payload: input.payload ?? {},
        };
        if (input.attributes !== undefined) args.attributes = input.attributes;
        return fireViaHostedMethod(
          'functions.publishPubSub',
          args,
          'Pub/Sub',
          trigger.exportName,
          signal,
        );
      }
      if (capability.mode === 'tasks') {
        return fireViaHostedMethod(
          'functions.enqueueTask',
          { trigger: trigger.exportName, data: input.payload ?? {} },
          'Tasks',
          trigger.exportName,
          signal,
        );
      }
      return { ok: false, summary: `Manual fire is not supported for ${trigger.exportName}.` };
    },
  };
}
