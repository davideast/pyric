import { EventEmitter } from 'node:events';
import type { IncomingMessage, RequestOptions, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import {
  type CapturedMessagingCallOutcome,
  captureMessagingCall,
  nameFacts,
  summarizeBatchResponse,
  type SummarizedBatchResponse,
} from './messaging-send-probe-session.ts';

const require = createRequire(import.meta.url);

export interface RetryConfigSnapshot {
  maxRetries: number;
  statusCodes: number[];
  ioErrorCodes: string[];
  backOffFactor: number;
  maxDelayInMillis: number;
}

export interface SendRetrySuccessCase {
  attempts: number;
  delaysMs: number[];
  nameFacts: {
    matchesProjectsMessagesFormat: boolean;
    projectSegmentMatchesProject: boolean;
  };
}

export interface SendRetryFailureCase {
  attempts: number;
  delaysMs: number[];
  outcome: CapturedMessagingCallOutcome;
}

export interface BatchRetryTransportOutcome {
  http1Requests: number;
  http2Requests: number;
  delaysMs: number[];
  batch: SummarizedBatchResponse;
}

export interface TransportRetryCoreBehavior {
  defaultRetryConfig: {
    http1: RetryConfigSnapshot;
    http2: RetryConfigSnapshot;
    configsEqual: boolean;
  };
  http1Send: {
    transient503TwiceThen200: SendRetrySuccessCase;
    retryAfterHeaderSeconds3Then200: SendRetrySuccessCase;
    retryAfterExceedsMaxDelay120s: SendRetryFailureCase;
    exhausted503FiveAttempts: SendRetryFailureCase;
    http500InternalNotRetried: SendRetryFailureCase;
    http429QuotaExceededNotRetried: SendRetryFailureCase;
    econnresetOnceThen200: SendRetrySuccessCase;
    etimedoutExhaustedFiveAttempts: SendRetryFailureCase;
    econnrefusedNotRetried: SendRetryFailureCase;
  };
  batchSendEach: {
    defaultHttp2: BatchRetryTransportOutcome;
    legacyHttp1: BatchRetryTransportOutcome;
    batchOutcomesMatch: boolean;
  };
}

type ScriptedStep =
  | {
      kind: 'http';
      status: number;
      headers?: Record<string, string>;
      body: Record<string, unknown>;
    }
  | {
      kind: 'io-error';
      code: 'ECONNRESET' | 'ETIMEDOUT' | 'ECONNREFUSED';
    };

interface InternalRetryClient {
  retry?: RetryConfigSnapshot;
  waitForRetry: (delayMillis: number) => Promise<void>;
}

interface InternalMessagingWithHandler {
  messagingRequestHandler: {
    httpClient: InternalRetryClient;
    http2Client: InternalRetryClient;
  };
}

function cloneRetryConfig(raw: RetryConfigSnapshot | undefined): RetryConfigSnapshot {
  if (raw === undefined) {
    throw new Error('Expected RetryConfig on firebase-admin RequestClient');
  }
  return {
    maxRetries: raw.maxRetries,
    statusCodes: [...raw.statusCodes],
    ioErrorCodes: [...raw.ioErrorCodes],
    backOffFactor: raw.backOffFactor,
    maxDelayInMillis: raw.maxDelayInMillis,
  };
}

function createSyntheticIoErrorRequest(code: string): EventEmitter & {
  aborted: boolean;
  destroyed: boolean;
  setTimeout: () => void;
  destroy: () => void;
  end: () => void;
} {
  const emitter = new EventEmitter() as EventEmitter & {
    aborted: boolean;
    destroyed: boolean;
    setTimeout: () => void;
    destroy: () => void;
    end: () => void;
  };
  emitter.aborted = false;
  emitter.destroyed = false;
  emitter.setTimeout = (): void => {};
  emitter.destroy = (): void => {
    emitter.destroyed = true;
  };
  emitter.end = (): void => {
    queueMicrotask(() => {
      const ioErr = Object.assign(new Error(`transport fault ${code}`), { code });
      emitter.emit('error', ioErr);
    });
  };
  return emitter;
}

function unavailableBody(): Record<string, unknown> {
  return {
    error: {
      code: 503,
      message: 'The service is currently unavailable.',
      status: 'UNAVAILABLE',
      details: [
        {
          '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          errorCode: 'UNAVAILABLE',
        },
      ],
    },
  };
}

function internalErrorBody(): Record<string, unknown> {
  return {
    error: {
      code: 500,
      message: 'Internal error encountered.',
      status: 'INTERNAL',
      details: [
        {
          '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          errorCode: 'INTERNAL',
        },
      ],
    },
  };
}

function quotaExceededBody(): Record<string, unknown> {
  return {
    error: {
      code: 429,
      message: 'Quota exceeded for quota metric.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          errorCode: 'QUOTA_EXCEEDED',
        },
      ],
    },
  };
}

function acceptedMessageBody(projectId: string, suffix: string): Record<string, unknown> {
  return {
    name: `projects/${projectId}/messages/${suffix}`,
  };
}

function readAuthorizationHeader(headers: RequestOptions['headers']): string | undefined {
  if (headers === undefined || Array.isArray(headers)) {
    return undefined;
  }
  const record = headers as Record<string, unknown>;
  if (typeof record.Authorization === 'string') {
    return record.Authorization;
  }
  if (typeof record.authorization === 'string') {
    return record.authorization;
  }
  return undefined;
}

function readRequestTopicFromBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { message?: { topic?: unknown } };
    if (typeof parsed.message?.topic === 'string') {
      return parsed.message.topic;
    }
  } catch {
    // Ignore malformed test body.
  }
  return '';
}

export async function observeFirebaseAdminTransportRetry(
  projectId: string,
): Promise<TransportRetryCoreBehavior> {
  const http = require('http') as typeof import('node:http');
  const https = require('https') as typeof import('node:https');
  const http2 = require('http2') as typeof import('node:http2');

  let activeSteps: ScriptedStep[] = [];
  let topicSteps = new Map<string, ScriptedStep[]>();
  let http1Requests = 0;
  let http2Requests = 0;

  function popStepForTopic(topic: string): ScriptedStep {
    const perTopic = topicSteps.get(topic);
    if (perTopic !== undefined && perTopic.length > 0) {
      const nextTopicStep = perTopic.shift();
      if (nextTopicStep !== undefined) {
        return nextTopicStep;
      }
    }
    const nextStep = activeSteps.shift();
    if (nextStep !== undefined) {
      return nextStep;
    }
    return {
      kind: 'http',
      status: 200,
      body: acceptedMessageBody(projectId, 'fallback-ok'),
    };
  }

  const h1Server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      http1Requests += 1;
      const raw = Buffer.concat(chunks).toString('utf8');
      const topic = readRequestTopicFromBody(raw);
      const step = popStepForTopic(topic);
      if (step.kind === 'io-error') {
        req.socket.destroy();
        return;
      }
      const responseHeaders: Record<string, string> = {
        'content-type': 'application/json',
        ...(step.headers ?? {}),
      };
      res.writeHead(step.status, responseHeaders);
      res.end(JSON.stringify(step.body));
    });
  });

  const h2Server = http2.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      http2Requests += 1;
      const raw = Buffer.concat(chunks).toString('utf8');
      const topic = readRequestTopicFromBody(raw);
      const step = popStepForTopic(topic);
      if (step.kind === 'io-error') {
        req.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
        return;
      }
      const responseHeaders: Record<string, string> = {
        'content-type': 'application/json',
        ...(step.headers ?? {}),
      };
      res.writeHead(step.status, responseHeaders);
      res.end(JSON.stringify(step.body));
    });
  });

  await new Promise<void>((resolve) => h1Server.listen(0, '127.0.0.1', () => resolve()));
  await new Promise<void>((resolve) => h2Server.listen(0, '127.0.0.1', () => resolve()));

  const h1Port = (h1Server.address() as AddressInfo).port;
  const h2Port = (h2Server.address() as AddressInfo).port;
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const probeAccessToken = `pyric-retry-probe-token-${runId}`;
  let interceptHttp2 = false;

  const originalHttpsRequest = https.request;
  const originalHttp2Connect = http2.connect;
  const callOriginalHttpsRequest = originalHttpsRequest as unknown as (
    ...args: unknown[]
  ) => ReturnType<typeof https.request>;
  const callOriginalHttp2Connect = originalHttp2Connect as unknown as (
    ...args: unknown[]
  ) => ReturnType<typeof http2.connect>;

  https.request = function patchedHttpsRequest(
    optionsOrUrl: string | URL | RequestOptions,
    callback?: (res: IncomingMessage) => void,
  ) {
    if (typeof optionsOrUrl === 'object' && !(optionsOrUrl instanceof URL)) {
      const authHeader = readAuthorizationHeader(optionsOrUrl.headers);
      if (authHeader === `Bearer ${probeAccessToken}`) {
        const nextHead = activeSteps[0];
        if (nextHead?.kind === 'io-error') {
          activeSteps.shift();
          http1Requests += 1;
          return createSyntheticIoErrorRequest(nextHead.code) as unknown as ReturnType<
            typeof https.request
          >;
        }
        const loopbackOptions: RequestOptions = {
          ...optionsOrUrl,
          protocol: 'http:',
          hostname: '127.0.0.1',
          port: h1Port,
          agent: false,
        };
        return http.request(loopbackOptions, callback);
      }
    }
    return callOriginalHttpsRequest.call(https, optionsOrUrl, callback);
  } as typeof https.request;

  http2.connect = function patchedHttp2Connect(
    authority: string | URL,
    options?: unknown,
    listener?: unknown,
  ) {
    if (interceptHttp2 && String(authority) === 'https://fcm.googleapis.com') {
      if (typeof options === 'function') {
        return callOriginalHttp2Connect.call(http2, `http://127.0.0.1:${h2Port}`, options);
      }
      return callOriginalHttp2Connect.call(
        http2,
        `http://127.0.0.1:${h2Port}`,
        undefined,
        listener,
      );
    }
    return callOriginalHttp2Connect.call(http2, authority, options, listener);
  } as typeof http2.connect;

  const h2App = initializeApp(
    {
      projectId,
      credential: {
        getAccessToken: async () => ({ access_token: probeAccessToken, expires_in: 3600 }),
      },
    },
    `messaging-retry-h2-${runId}`,
  );
  const legacyApp = initializeApp(
    {
      projectId,
      credential: {
        getAccessToken: async () => ({ access_token: probeAccessToken, expires_in: 3600 }),
      },
    },
    `messaging-retry-h1-${runId}`,
  );

  try {
    const svc = getMessaging(h2App);
    const legacySvc = getMessaging(legacyApp);
    legacySvc.enableLegacyHttpTransport();

    const internalHandler = (svc as unknown as InternalMessagingWithHandler)
      .messagingRequestHandler;
    const legacyInternalHandler = (legacySvc as unknown as InternalMessagingWithHandler)
      .messagingRequestHandler;

    const http1Config = cloneRetryConfig(internalHandler.httpClient.retry);
    const http2Config = cloneRetryConfig(internalHandler.http2Client.retry);

    const delaysMs: number[] = [];
    const recordDelay = async (ms: number): Promise<void> => {
      delaysMs.push(ms);
    };
    internalHandler.httpClient.waitForRetry = recordDelay;
    internalHandler.http2Client.waitForRetry = recordDelay;
    legacyInternalHandler.httpClient.waitForRetry = recordDelay;
    legacyInternalHandler.http2Client.waitForRetry = recordDelay;

    const probeMessage: Message = {
      topic: 'pyric-oracle-messaging-probe',
      data: { item: '1' },
    };

    const runSuccessSend = async (steps: ScriptedStep[]): Promise<SendRetrySuccessCase> => {
      activeSteps = [...steps];
      topicSteps = new Map();
      http1Requests = 0;
      delaysMs.length = 0;
      const name = await svc.send(probeMessage, true);
      return {
        attempts: http1Requests,
        delaysMs: [...delaysMs],
        nameFacts: nameFacts(name, projectId),
      };
    };

    const runFailureSend = async (steps: ScriptedStep[]): Promise<SendRetryFailureCase> => {
      activeSteps = [...steps];
      topicSteps = new Map();
      http1Requests = 0;
      delaysMs.length = 0;
      const outcome = await captureMessagingCall(() => svc.send(probeMessage, true));
      return {
        attempts: http1Requests,
        delaysMs: [...delaysMs],
        outcome,
      };
    };

    const transient503TwiceThen200 = await runSuccessSend([
      { kind: 'http', status: 503, body: unavailableBody() },
      { kind: 'http', status: 503, body: unavailableBody() },
      { kind: 'http', status: 200, body: acceptedMessageBody(projectId, 'ok-after-503') },
    ]);

    const retryAfterHeaderSeconds3Then200 = await runSuccessSend([
      {
        kind: 'http',
        status: 503,
        headers: { 'retry-after': '3' },
        body: unavailableBody(),
      },
      { kind: 'http', status: 200, body: acceptedMessageBody(projectId, 'ok-retry-after') },
    ]);

    const retryAfterExceedsMaxDelay120s = await runFailureSend([
      {
        kind: 'http',
        status: 503,
        headers: { 'retry-after': '120' },
        body: unavailableBody(),
      },
    ]);

    const exhausted503FiveAttempts = await runFailureSend([
      { kind: 'http', status: 503, body: unavailableBody() },
      { kind: 'http', status: 503, body: unavailableBody() },
      { kind: 'http', status: 503, body: unavailableBody() },
      { kind: 'http', status: 503, body: unavailableBody() },
      { kind: 'http', status: 503, body: unavailableBody() },
    ]);

    const http500InternalNotRetried = await runFailureSend([
      { kind: 'http', status: 500, body: internalErrorBody() },
    ]);

    const http429QuotaExceededNotRetried = await runFailureSend([
      { kind: 'http', status: 429, body: quotaExceededBody() },
    ]);

    const econnresetOnceThen200 = await runSuccessSend([
      { kind: 'io-error', code: 'ECONNRESET' },
      { kind: 'http', status: 200, body: acceptedMessageBody(projectId, 'ok-after-reset') },
    ]);

    const etimedoutExhaustedFiveAttempts = await runFailureSend([
      { kind: 'io-error', code: 'ETIMEDOUT' },
      { kind: 'io-error', code: 'ETIMEDOUT' },
      { kind: 'io-error', code: 'ETIMEDOUT' },
      { kind: 'io-error', code: 'ETIMEDOUT' },
      { kind: 'io-error', code: 'ETIMEDOUT' },
    ]);

    const econnrefusedNotRetried = await runFailureSend([
      { kind: 'io-error', code: 'ECONNREFUSED' },
    ]);

    const buildBatchSteps = (): Map<string, ScriptedStep[]> =>
      new Map<string, ScriptedStep[]>([
        [
          'batch-item-recover',
          [
            { kind: 'http', status: 503, body: unavailableBody() },
            { kind: 'http', status: 200, body: acceptedMessageBody(projectId, 'batch-ok-0') },
          ],
        ],
        [
          'batch-item-exhaust',
          [
            { kind: 'http', status: 503, body: unavailableBody() },
            { kind: 'http', status: 503, body: unavailableBody() },
            { kind: 'http', status: 503, body: unavailableBody() },
            { kind: 'http', status: 503, body: unavailableBody() },
            { kind: 'http', status: 503, body: unavailableBody() },
          ],
        ],
      ]);

    const batchMessages: Message[] = [
      { topic: 'batch-item-recover', data: { item: '0' } },
      { topic: 'batch-item-exhaust', data: { item: '1' } },
    ];

    activeSteps = [];
    topicSteps = buildBatchSteps();
    http1Requests = 0;
    http2Requests = 0;
    delaysMs.length = 0;
    interceptHttp2 = true;
    const h2RawBatch = await svc.sendEach(batchMessages, true);
    interceptHttp2 = false;
    const defaultHttp2: BatchRetryTransportOutcome = {
      http1Requests,
      http2Requests,
      delaysMs: [...delaysMs].sort((a, b) => a - b),
      batch: summarizeBatchResponse(h2RawBatch, projectId),
    };

    activeSteps = [];
    topicSteps = buildBatchSteps();
    http1Requests = 0;
    http2Requests = 0;
    delaysMs.length = 0;
    const legacyRawBatch = await legacySvc.sendEach(batchMessages, true);
    const legacyHttp1: BatchRetryTransportOutcome = {
      http1Requests,
      http2Requests,
      delaysMs: [...delaysMs].sort((a, b) => a - b),
      batch: summarizeBatchResponse(legacyRawBatch, projectId),
    };

    return {
      defaultRetryConfig: {
        http1: http1Config,
        http2: http2Config,
        configsEqual: JSON.stringify(http1Config) === JSON.stringify(http2Config),
      },
      http1Send: {
        transient503TwiceThen200,
        retryAfterHeaderSeconds3Then200,
        retryAfterExceedsMaxDelay120s,
        exhausted503FiveAttempts,
        http500InternalNotRetried,
        http429QuotaExceededNotRetried,
        econnresetOnceThen200,
        etimedoutExhaustedFiveAttempts,
        econnrefusedNotRetried,
      },
      batchSendEach: {
        defaultHttp2,
        legacyHttp1,
        batchOutcomesMatch:
          JSON.stringify(defaultHttp2.batch) === JSON.stringify(legacyHttp1.batch),
      },
    };
  } finally {
    interceptHttp2 = false;
    https.request = originalHttpsRequest;
    http2.connect = originalHttp2Connect;
    await deleteApp(h2App).catch(() => undefined);
    await deleteApp(legacyApp).catch(() => undefined);
    await new Promise<void>((resolve) => h1Server.close(() => resolve()));
    await new Promise<void>((resolve) => h2Server.close(() => resolve()));
  }
}
