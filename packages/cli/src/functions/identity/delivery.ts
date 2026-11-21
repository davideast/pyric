/**
 * Blocking trigger delivery seam for Cloud Functions v2 Identity triggers:
 * deterministic in-memory request/response broker for unit tests and remote
 * worker-channel adapter (`authBlocking` sub + `auth.blockingRespond` op) for
 * isolated child processes.
 */
import type { WorkerOpPayload, WorkerSubPayload } from '../../bridge/protocol.js';
import type { RemoteSandboxChannel } from '../../remote/index.js';
import type {
  AuthBlockingInvokeSnapWire,
  AuthBlockingOutcomeWire,
  AuthBlockingTriggerWire,
} from '../../serve/worker/protocol/auth.js';
import type { IdentityBlockingEventType, IdentityBlockingOptions } from './discovery.js';
import type {
  IdentityEmailType,
  IdentityRawCredentialInput,
  IdentitySmsType,
  IdentityUserRecordInput,
} from './event.js';
import type {
  IdentityBlockingResponsePayload,
  NormalizedBlockingHttpsError,
} from './response.js';

export interface IdentityBlockingRegistration {
  exportName: string;
  eventType: IdentityBlockingEventType;
  options: IdentityBlockingOptions;
  timeoutSeconds?: number;
}

export interface IdentityBlockingInvocationRequest {
  requestId: string;
  eventType: IdentityBlockingEventType;
  projectId: string;
  timestampMs: number;
  signInMethod?: string;
  tenantId?: string | null;
  locale?: string;
  ipAddress?: string;
  userAgent?: string;
  recaptchaScore?: number;
  email?: string;
  phoneNumber?: string;
  emailType?: IdentityEmailType;
  smsType?: IdentitySmsType;
  rawUserInfo?: string | Record<string, unknown>;
  credential?: IdentityRawCredentialInput;
  userRecord?: IdentityUserRecordInput;
}

export type IdentityBlockingInvocationOutcome =
  | { ok: true; response: IdentityBlockingResponsePayload }
  | { ok: false; error: NormalizedBlockingHttpsError };

export interface IdentityTriggerDelivery {
  register(
    triggers: readonly IdentityBlockingRegistration[],
    handler: (
      request: IdentityBlockingInvocationRequest,
    ) => Promise<IdentityBlockingInvocationOutcome>,
    onReady?: () => void,
    onError?: (error: unknown) => void,
  ): () => void;
}

/** Deterministic in-memory Identity blocking broker for unit tests. */
export class InMemoryIdentityTriggerDelivery implements IdentityTriggerDelivery {
  #registrations = new Map<
    IdentityBlockingEventType,
    {
      registration: IdentityBlockingRegistration;
      handler: (
        request: IdentityBlockingInvocationRequest,
      ) => Promise<IdentityBlockingInvocationOutcome>;
    }
  >();

  hasTrigger(eventType: IdentityBlockingEventType): boolean {
    return this.#registrations.has(eventType);
  }

  registrationFor(
    eventType: IdentityBlockingEventType,
  ): IdentityBlockingRegistration | undefined {
    return this.#registrations.get(eventType)?.registration;
  }

  async invoke(
    request: IdentityBlockingInvocationRequest,
  ): Promise<IdentityBlockingInvocationOutcome | undefined> {
    const active = this.#registrations.get(request.eventType);
    if (active === undefined) return undefined;
    return active.handler(structuredClone(request));
  }

  register(
    triggers: readonly IdentityBlockingRegistration[],
    handler: (
      request: IdentityBlockingInvocationRequest,
    ) => Promise<IdentityBlockingInvocationOutcome>,
    onReady?: () => void,
  ): () => void {
    const ownedEventTypes: IdentityBlockingEventType[] = [];
    for (const trigger of triggers) {
      ownedEventTypes.push(trigger.eventType);
      this.#registrations.set(trigger.eventType, {
        registration: structuredClone(trigger),
        handler,
      });
    }
    onReady?.();
    return () => {
      for (const eventType of ownedEventTypes) {
        const current = this.#registrations.get(eventType);
        if (current?.handler === handler) {
          this.#registrations.delete(eventType);
        }
      }
    };
  }
}

function isAuthBlockingSnap(value: unknown): value is AuthBlockingInvokeSnapWire {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'ready' || kind === 'invoke';
}

function toWireTrigger(trigger: IdentityBlockingRegistration): AuthBlockingTriggerWire {
  const wire: AuthBlockingTriggerWire = {
    exportName: trigger.exportName,
    eventType: trigger.eventType,
    options: {
      idToken: trigger.options.idToken,
      accessToken: trigger.options.accessToken,
      refreshToken: trigger.options.refreshToken,
    },
  };
  if (trigger.timeoutSeconds !== undefined) {
    wire.timeoutSeconds = trigger.timeoutSeconds;
  }
  return wire;
}

function toWireOutcome(outcome: IdentityBlockingInvocationOutcome): AuthBlockingOutcomeWire {
  if (outcome.ok) {
    return {
      ok: true,
      response: structuredClone(outcome.response) as Record<string, unknown>,
    };
  }
  return {
    ok: false,
    error: structuredClone(outcome.error),
  };
}

/** Remote sandbox channel adapter backed by `authBlocking` sub + `auth.blockingRespond` op. */
export class RemoteIdentityTriggerDelivery implements IdentityTriggerDelivery {
  readonly #channel: Pick<RemoteSandboxChannel, 'op' | 'subscribe'>;

  constructor(channel: Pick<RemoteSandboxChannel, 'op' | 'subscribe'>) {
    this.#channel = channel;
  }

  register(
    triggers: readonly IdentityBlockingRegistration[],
    handler: (
      request: IdentityBlockingInvocationRequest,
    ) => Promise<IdentityBlockingInvocationOutcome>,
    onReady?: () => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const wireTriggers = triggers.map(toWireTrigger);
    const subPayload = {
      target: 'authBlocking',
      triggers: wireTriggers,
      actAs: { mode: 'admin' },
    } as unknown as WorkerSubPayload;
    let readyReported = false;
    let closed = false;

    const unsubscribe = this.#channel.subscribe(
      subPayload,
      (rawSnap) => {
        if (closed || !isAuthBlockingSnap(rawSnap)) return;
        if (rawSnap.kind === 'ready') {
          if (!readyReported) {
            readyReported = true;
            onReady?.();
          }
          return;
        }
        const request = rawSnap.request as unknown as IdentityBlockingInvocationRequest;
        void (async () => {
          let outcome: IdentityBlockingInvocationOutcome;
          try {
            outcome = await handler(request);
          } catch {
            outcome = {
              ok: false,
              error: {
                code: 'internal',
                status: 'INTERNAL',
                httpStatus: 500,
                message: 'An unexpected error occurred.',
              },
            };
          }
          if (closed) return;
          const respondOp = {
            method: 'auth.blockingRespond',
            requestId: request.requestId,
            outcome: toWireOutcome(outcome),
            actAs: { mode: 'admin' },
          } as unknown as WorkerOpPayload;
          await this.#channel.op(respondOp).catch((replyError: unknown) => {
            if (!closed) {
              onError?.(replyError);
            }
          });
        })();
      },
      (err) => {
        onError?.(err);
      },
    );

    return () => {
      closed = true;
      unsubscribe();
    };
  }
}
