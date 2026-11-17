import { deleteApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { FirebaseMessagingError, type BatchResponse } from 'firebase-admin/messaging';
import {
  loadMessagingServiceAccount,
  messagingAccessToken,
  messagingSendEndpoint,
} from './messaging-credential.ts';
import { oracleAppOptions, type OracleServiceAccount } from './oracle-credential.ts';

interface RawSendPayload {
  validate_only: boolean;
  message: Record<string, unknown>;
}

export type RawSendFn = (
  payload: RawSendPayload,
) => Promise<{ status: number; body: Record<string, unknown> }>;

interface NameFacts {
  matchesProjectsMessagesFormat: boolean;
  projectSegmentMatchesProject: boolean;
}

/** Strip run-specific noise: message ids vary per send; the resource-name format is the fact. */
export function nameFacts(name: string, projectId: string): NameFacts {
  const match = /^projects\/([^/]+)\/messages\/([^/]+)$/.exec(name);
  return {
    matchesProjectsMessagesFormat: match !== null,
    projectSegmentMatchesProject: match?.[1] === projectId,
  };
}

export type AcceptedSendPairOutcome = {
  realSend: NameFacts;
  dryRunSend: NameFacts;
  dryRunSameShapeAsReal: boolean;
};

export async function captureAcceptedSendPair(
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>,
  projectId: string,
  message: Record<string, unknown>,
): Promise<AcceptedSendPairOutcome> {
  const realName = await sendClient(structuredClone(message), false);
  const dryName = await sendClient(structuredClone(message), true);
  const realFacts = nameFacts(realName, projectId);
  const dryFacts = nameFacts(dryName, projectId);
  return {
    realSend: realFacts,
    dryRunSend: dryFacts,
    dryRunSameShapeAsReal:
      realFacts.matchesProjectsMessagesFormat === dryFacts.matchesProjectsMessagesFormat &&
      realFacts.projectSegmentMatchesProject === dryFacts.projectSegmentMatchesProject,
  };
}

export function assertFcmProbeHttpStatus(status: number, body: unknown): void {
  if (status === 401 || status === 403 || status >= 500) {
    throw new Error(
      `FCM probe HTTP ${status} infrastructure/IAM failure (refusing to record as observation): ${JSON.stringify(body)}`,
    );
  }
}

export interface ExtractedMessagingErrorDetails {
  code: string | null;
  message: string;
  isFirebaseMessagingError: boolean;
  name: string | null;
}

export type CapturedMessagingCallOutcome = ExtractedMessagingErrorDetails & {
  threw: boolean;
};

export function extractMessagingErrorDetails(error: unknown): ExtractedMessagingErrorDetails {
  let code: string | null = null;
  let message = '';
  let name: string | null = null;
  const isFirebaseMessagingError = error instanceof FirebaseMessagingError;

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
    if (typeof candidate.code === 'string') {
      code = candidate.code;
    }
    if (typeof candidate.message === 'string') {
      message = candidate.message;
    }
    if (typeof candidate.name === 'string') {
      name = candidate.name;
    }
  } else {
    message = String(error);
  }

  return {
    code,
    message,
    isFirebaseMessagingError,
    name,
  };
}

export async function captureMessagingCall(
  invoke: () => Promise<unknown>,
): Promise<CapturedMessagingCallOutcome> {
  try {
    await invoke();
    return {
      threw: false,
      code: null,
      message: '',
      isFirebaseMessagingError: false,
      name: null,
    };
  } catch (err) {
    return {
      threw: true,
      ...extractMessagingErrorDetails(err),
    };
  }
}

interface SummarizedSendResponseItem {
  index: number;
  success: boolean;
  hasMessageId: boolean;
  nameFacts: NameFacts | null;
  hasError: boolean;
  error: ExtractedMessagingErrorDetails | null;
}

export interface SummarizedBatchResponse {
  successCount: number;
  failureCount: number;
  responseCount: number;
  responses: SummarizedSendResponseItem[];
}

export function summarizeBatchResponse(
  batch: BatchResponse,
  projectId: string,
): SummarizedBatchResponse {
  const responses: SummarizedSendResponseItem[] = batch.responses.map((entry, index) => {
    const hasMessageId = typeof entry.messageId === 'string' && entry.messageId.length > 0;
    let facts: NameFacts | null = null;
    if (typeof entry.messageId === 'string') {
      facts = nameFacts(entry.messageId, projectId);
    }

    const hasError = entry.error !== undefined;
    let errorDetails: ExtractedMessagingErrorDetails | null = null;
    if (entry.error !== undefined) {
      errorDetails = extractMessagingErrorDetails(entry.error);
    }

    return {
      index,
      success: entry.success,
      hasMessageId,
      nameFacts: facts,
      hasError,
      error: errorDetails,
    };
  });

  return {
    successCount: batch.successCount,
    failureCount: batch.failureCount,
    responseCount: responses.length,
    responses,
  };
}

export type ErrorEnvelopeParityOutcome = {
  status: number;
  error: unknown;
  realStatus: number;
  realSendEnvelopeIdentical: boolean;
};

export interface MessagingSendProbeSession {
  app: App;
  projectId: string;
  sa: OracleServiceAccount;
  rawSend: RawSendFn;
  errorEnvelopeParity: (message: Record<string, unknown>) => Promise<ErrorEnvelopeParityOutcome>;
}

let sessionCounter = 0;

export function createRawSendFunctions(sa: OracleServiceAccount): {
  rawSend: RawSendFn;
  errorEnvelopeParity: (message: Record<string, unknown>) => Promise<ErrorEnvelopeParityOutcome>;
} {
  const endpoint = messagingSendEndpoint(sa);

  const rawSend: RawSendFn = async (payload) => {
    const accessToken = await messagingAccessToken(sa);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as Record<string, unknown>;
    assertFcmProbeHttpStatus(res.status, body);
    return { status: res.status, body };
  };

  const errorEnvelopeParity = async (
    message: Record<string, unknown>,
  ): Promise<ErrorEnvelopeParityOutcome> => {
    const dry = await rawSend({ validate_only: true, message });
    const real = await rawSend({ validate_only: false, message });
    return {
      status: dry.status,
      error: dry.body.error,
      realStatus: real.status,
      realSendEnvelopeIdentical:
        dry.status === real.status &&
        JSON.stringify(dry.body.error) === JSON.stringify(real.body.error),
    };
  };

  return { rawSend, errorEnvelopeParity };
}

export async function withMessagingSendProbeSession<T>(
  run: (session: MessagingSendProbeSession) => Promise<T>,
): Promise<T> {
  const sa = await loadMessagingServiceAccount();
  const preExistingApps = new Set(getApps().map((existing) => existing.name));
  sessionCounter += 1;
  const appName = `messaging-send-modular-${Date.now()}-${sessionCounter}`;
  const app = initializeApp(oracleAppOptions(sa), appName);
  const { rawSend, errorEnvelopeParity } = createRawSendFunctions(sa);

  try {
    return await run({
      app,
      projectId: sa.project_id,
      sa,
      rawSend,
      errorEnvelopeParity,
    });
  } finally {
    for (const candidate of getApps()) {
      if (!preExistingApps.has(candidate.name)) {
        await deleteApp(candidate).catch(() => undefined);
      }
    }
  }
}
