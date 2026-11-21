/**
 * HTTP Cloud Tasks request encoder and single-attempt runner for
 * `firebase-functions/v2/tasks` (`7.2.5`), matching `lib/v2/providers/tasks.js`
 * and `lib/common/providers/tasks.js` (`POST`, `application/json`, `{ data }`,
 * `X-CloudTasks-*` headers, OIDC `Authorization: Bearer <jwt>`, and `onInit()`).
 */
import type { DiscoveredTaskTrigger } from './discovery.js';

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface TaskAuthClaims {
  uid: string;
  token?: Record<string, unknown>;
}

interface TaskAuthContext {
  uid: string;
  token: Record<string, unknown>;
  rawToken: string;
}

interface TaskRequestPayload<Args = unknown> {
  queueName: string;
  id: string;
  retryCount: number;
  executionCount: number;
  scheduledTime: string;
  previousResponse?: number;
  retryReason?: string;
  headers: Record<string, string>;
  auth?: TaskAuthContext;
  data: Args;
}

export interface TaskDispatchAttemptOptions {
  queueName: string;
  taskId: string;
  data: unknown;
  scheduledTime: string;
  retryCount: number;
  executionCount: number;
  previousResponse?: number;
  retryReason?: string;
  headers?: Record<string, string>;
  auth?: TaskAuthClaims;
  projectId?: string;
}

export type TaskAttemptResult =
  | {
      status: 'fulfilled';
      statusCode: number;
      request: TaskRequestPayload;
      result: unknown;
    }
  | {
      status: 'rejected';
      statusCode: number;
      request: TaskRequestPayload;
      error: Error;
    };

interface MockTaskHttpRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: { data: unknown };
  header(name: string): string | undefined;
  get(name: string): string | undefined;
}

interface MockTaskHttpResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockTaskHttpResponse;
  send(payload?: unknown): MockTaskHttpResponse;
  end(payload?: unknown): MockTaskHttpResponse;
  json(payload?: unknown): MockTaskHttpResponse;
}

/** Normalize a task ETA (`string | Date | number | undefined`) into RFC3339 UTC `"Z"`. */
export function normalizeTaskScheduledTime(
  scheduleTime: string | Date | number | undefined,
  fallbackEpochMs: number,
): string {
  if (scheduleTime === undefined) {
    return new Date(fallbackEpochMs).toISOString();
  }
  if (scheduleTime instanceof Date) {
    const epochMs = scheduleTime.getTime();
    if (!Number.isFinite(epochMs)) {
      throw new Error('Invalid scheduleTime Date');
    }
    return new Date(epochMs).toISOString();
  }
  if (typeof scheduleTime === 'number') {
    if (!Number.isFinite(scheduleTime)) {
      throw new Error('Invalid scheduleTime epoch milliseconds');
    }
    return new Date(scheduleTime).toISOString();
  }
  if (typeof scheduleTime === 'string') {
    const trimmed = scheduleTime.trim();
    if (!ISO_TIMESTAMP_PATTERN.test(trimmed)) {
      throw new Error(
        `Invalid scheduleTime '${scheduleTime}': expected RFC3339 / ISO-8601 timestamp`,
      );
    }
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) {
      throw new Error(`Invalid scheduleTime '${scheduleTime}': calendar timestamp out of range`);
    }
    return new Date(parsedMs).toISOString();
  }
  throw new Error('Unsupported scheduleTime value');
}

/**
 * Round-trip task payload through JSON (`{ data }`) matching Cloud Tasks HTTP
 * wire serialization so `undefined` object keys are stripped and `.toJSON()` runs.
 */
export function serializeTaskPayloadWire(rawData: unknown): unknown {
  const normalized = rawData === undefined ? null : rawData;
  try {
    const encoded = JSON.stringify({ data: normalized });
    const parsed = JSON.parse(encoded) as { data?: unknown };
    return parsed.data === undefined ? null : parsed.data;
  } catch (err: unknown) {
    if (err instanceof TypeError) {
      throw new Error(`Task data cannot be serialized as JSON: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Build a 3-segment base64url JWT accepted by `firebase-functions`
 * `unsafeDecodeIdToken` (`JWT_REGEX` + `decoded.uid = decoded.sub`).
 */
function buildEmulatedTaskOidcJwt(
  projectId: string,
  authClaims?: TaskAuthClaims,
): { rawToken: string; decodedToken: Record<string, unknown>; uid: string } {
  const defaultUid = `${projectId}@appspot.gserviceaccount.com`;
  const uid = authClaims?.uid ?? defaultUid;
  const headerSegment = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
    'utf8',
  ).toString('base64url');

  const payloadObject: Record<string, unknown> = {
    iss: 'https://accounts.google.com',
    aud: projectId,
    email: uid,
  };
  if (authClaims?.token !== undefined) {
    for (const [key, value] of Object.entries(authClaims.token)) {
      payloadObject[key] = value;
    }
  }
  payloadObject.sub = uid;

  const payloadSegment = Buffer.from(JSON.stringify(payloadObject), 'utf8').toString('base64url');
  const rawToken = `${headerSegment}.${payloadSegment}.emulatedsig`;
  const decodedToken: Record<string, unknown> = {
    ...payloadObject,
    uid,
  };
  return { rawToken, decodedToken, uid };
}

function buildHeadersAndAuth(options: TaskDispatchAttemptOptions): {
  headers: Record<string, string>;
  auth?: TaskAuthContext;
} {
  const effectiveProject = options.projectId ?? process.env.GCLOUD_PROJECT ?? 'demo-project';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  let callerAuthHeader: string | undefined;
  if (options.headers !== undefined) {
    for (const [rawKey, rawValue] of Object.entries(options.headers)) {
      const lower = rawKey.toLowerCase();
      if (lower === 'content-type') continue;
      if (lower.startsWith('x-cloudtasks-')) continue;
      if (lower === 'authorization') {
        callerAuthHeader = rawValue;
        continue;
      }
      headers[lower] = rawValue;
    }
  }

  headers['x-cloudtasks-queuename'] = options.queueName;
  headers['x-cloudtasks-taskname'] = options.taskId;
  headers['x-cloudtasks-taskretrycount'] = String(options.retryCount);
  headers['x-cloudtasks-taskexecutioncount'] = String(options.executionCount);
  headers['x-cloudtasks-tasketa'] = options.scheduledTime;
  if (options.previousResponse !== undefined) {
    headers['x-cloudtasks-taskpreviousresponse'] = String(options.previousResponse);
  }
  if (options.retryReason !== undefined) {
    headers['x-cloudtasks-taskretryreason'] = options.retryReason;
  }

  if (options.auth !== undefined || callerAuthHeader === undefined) {
    const minted = buildEmulatedTaskOidcJwt(effectiveProject, options.auth);
    headers.authorization = `Bearer ${minted.rawToken}`;
    if (!process.env.FUNCTIONS_EMULATOR) {
      return {
        headers,
        auth: {
          uid: minted.uid,
          token: minted.decodedToken,
          rawToken: minted.rawToken,
        },
      };
    }
    return { headers };
  }

  headers.authorization = callerAuthHeader;
  return { headers };
}

function buildTaskRequestPayload(
  options: TaskDispatchAttemptOptions,
  wireData: unknown,
  headers: Record<string, string>,
  auth: TaskAuthContext | undefined,
): TaskRequestPayload {
  const context: Omit<TaskRequestPayload, 'data'> = {
    queueName: options.queueName,
    id: options.taskId,
    retryCount: options.retryCount,
    executionCount: options.executionCount,
    scheduledTime: options.scheduledTime,
    headers: { ...headers },
  };
  if (options.previousResponse !== undefined) {
    context.previousResponse = options.previousResponse;
  }
  if (options.retryReason !== undefined) {
    context.retryReason = options.retryReason;
  }
  if (auth !== undefined) {
    context.auth = auth;
  }

  const request: TaskRequestPayload = {
    ...context,
    data: wireData,
  };
  Object.defineProperty(request, 'context', {
    get: () => context,
    enumerable: false,
    configurable: true,
  });
  return request;
}

function createMockRequest(
  headers: Record<string, string>,
  wireData: unknown,
): MockTaskHttpRequest {
  const lookup = (name: string): string | undefined => headers[name.toLowerCase()];
  return {
    method: 'POST',
    headers,
    body: { data: wireData },
    header: lookup,
    get: lookup,
  };
}

function createMockResponse(): MockTaskHttpResponse {
  const response: MockTaskHttpResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    send(payload?: unknown) {
      if (payload !== undefined) {
        response.body = payload;
      }
      return response;
    },
    end(payload?: unknown) {
      if (payload !== undefined) {
        response.body = payload;
      }
      return response;
    },
    json(payload?: unknown) {
      response.body = payload;
      return response;
    },
  };
  return response;
}

function extractHttpErrorDetail(statusCode: number, exportName: string, body: unknown): Error {
  if (typeof body === 'object' && body !== null) {
    const outer = body as { error?: unknown };
    if (typeof outer.error === 'object' && outer.error !== null) {
      const inner = outer.error as { message?: unknown; status?: unknown };
      if (typeof inner.message === 'string' && inner.message.length > 0) {
        const statusTag = typeof inner.status === 'string' ? ` (${inner.status})` : '';
        return new Error(
          `Task function ${exportName} failed with HTTP ${statusCode}${statusTag}: ${inner.message}`,
        );
      }
    }
  }
  if (typeof body === 'string' && body.length > 0) {
    return new Error(`Task function ${exportName} failed with HTTP ${statusCode}: ${body}`);
  }
  return new Error(`Task function ${exportName} failed with HTTP ${statusCode}`);
}

/**
 * Execute a single dispatch attempt against an `onTaskDispatched` endpoint.
 * Real `firebase-functions/v2/tasks` exports wrap an Express `(req, res)`
 * handler (`onDispatchHandler`) that runs `onInit()` and writes `204` or `>=400`.
 */
export async function executeTaskTriggerAttempt(
  trigger: DiscoveredTaskTrigger,
  options: TaskDispatchAttemptOptions,
): Promise<TaskAttemptResult> {
  const wireData = serializeTaskPayloadWire(options.data);
  const { headers, auth } = buildHeadersAndAuth(options);
  const requestPayload = buildTaskRequestPayload(options, wireData, headers, auth);
  const isExpressWrapped = typeof trigger.callable.run === 'function';

  if (!isExpressWrapped) {
    try {
      const result = await trigger.callable(requestPayload);
      return {
        status: 'fulfilled',
        statusCode: 204,
        request: requestPayload,
        result,
      };
    } catch (err: unknown) {
      const normalizedError = err instanceof Error ? err : new Error(String(err));
      return {
        status: 'rejected',
        statusCode: 500,
        request: requestPayload,
        error: normalizedError,
      };
    }
  }

  const req = createMockRequest(headers, wireData);
  const res = createMockResponse();
  try {
    await trigger.callable(req, res);
  } catch (err: unknown) {
    const normalizedError = err instanceof Error ? err : new Error(String(err));
    return {
      status: 'rejected',
      statusCode: 500,
      request: requestPayload,
      error: normalizedError,
    };
  }

  if (res.statusCode >= 400) {
    return {
      status: 'rejected',
      statusCode: res.statusCode,
      request: requestPayload,
      error: extractHttpErrorDetail(res.statusCode, trigger.exportName, res.body),
    };
  }

  return {
    status: 'fulfilled',
    statusCode: res.statusCode,
    request: requestPayload,
    result: res.body,
  };
}
