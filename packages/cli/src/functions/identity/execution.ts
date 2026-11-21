/**
 * Execution host for discovered `firebase-functions/v2/identity` blocking
 * triggers: registers active blocking endpoints with the delivery channel,
 * dispatches matching Auth lifecycle invocations, and drains in-flight runs.
 */
import type {
  IdentityBlockingInvocationOutcome,
  IdentityBlockingInvocationRequest,
  IdentityBlockingRegistration,
  IdentityTriggerDelivery,
} from './delivery.js';
import {
  discoverIdentityTriggers,
  type DiscoveredIdentityTrigger,
  type IdentityBlockingEventType,
} from './discovery.js';
import type { BuildAuthBlockingEventOptions } from './event.js';
import {
  executeIdentityTrigger,
  type IdentityExecutionResult,
} from './response.js';

export interface IdentityTriggerExecutionOptions {
  exported: Record<string, unknown>;
  delivery: IdentityTriggerDelivery;
  activeEventTypes?: ReadonlySet<IdentityBlockingEventType>;
  ensureInitialized?: () => Promise<void>;
  nextEventId?(
    request: IdentityBlockingInvocationRequest,
    sequence: number,
    trigger: DiscoveredIdentityTrigger,
  ): string;
  onExecution?(
    result: IdentityExecutionResult,
    trigger: DiscoveredIdentityTrigger,
    request: IdentityBlockingInvocationRequest,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredIdentityTrigger): void;
}

export interface IdentityTriggerExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  idle(): Promise<void>;
  close(): void;
}

function buildExecutionInput(
  request: IdentityBlockingInvocationRequest,
  eventId: string,
): Omit<BuildAuthBlockingEventOptions, 'eventType' | 'blockingOptions'> {
  const input: Omit<BuildAuthBlockingEventOptions, 'eventType' | 'blockingOptions'> = {
    eventId,
    projectId: request.projectId,
    timestampMs: request.timestampMs,
  };
  if (request.signInMethod !== undefined) input.signInMethod = request.signInMethod;
  if (request.tenantId !== undefined) input.tenantId = request.tenantId;
  if (request.locale !== undefined) input.locale = request.locale;
  if (request.ipAddress !== undefined) input.ipAddress = request.ipAddress;
  if (request.userAgent !== undefined) input.userAgent = request.userAgent;
  if (request.recaptchaScore !== undefined) input.recaptchaScore = request.recaptchaScore;
  if (request.email !== undefined) input.email = request.email;
  if (request.phoneNumber !== undefined) input.phoneNumber = request.phoneNumber;
  if (request.emailType !== undefined) input.emailType = request.emailType;
  if (request.smsType !== undefined) input.smsType = request.smsType;
  if (request.rawUserInfo !== undefined) input.rawUserInfo = request.rawUserInfo;
  if (request.credential !== undefined) input.credential = request.credential;
  if (request.userRecord !== undefined) input.userRecord = request.userRecord;
  return input;
}

/** Register discovered Identity blocking triggers and handle live Auth requests. */
export function startIdentityTriggerExecution(
  options: IdentityTriggerExecutionOptions,
): IdentityTriggerExecutionHost {
  const discoveryOptions: { activeEventTypes?: ReadonlySet<IdentityBlockingEventType> } = {};
  if (options.activeEventTypes !== undefined) {
    discoveryOptions.activeEventTypes = options.activeEventTypes;
  }
  const triggers = discoverIdentityTriggers(options.exported, discoveryOptions);
  const byEventType = new Map<IdentityBlockingEventType, DiscoveredIdentityTrigger>();
  const registrations: IdentityBlockingRegistration[] = [];
  for (const trigger of triggers) {
    byEventType.set(trigger.eventType, trigger);
    const reg: IdentityBlockingRegistration = {
      exportName: trigger.exportName,
      eventType: trigger.eventType,
      options: trigger.options,
    };
    if (trigger.timeoutSeconds !== undefined) {
      reg.timeoutSeconds = trigger.timeoutSeconds;
    }
    registrations.push(reg);
  }

  let closed = false;
  let sequence = 0;
  let readySettled = false;
  const inFlight = new Set<Promise<void>>();
  const {
    promise: ready,
    resolve: markReady,
    reject: failReady,
  } = Promise.withResolvers<void>();

  if (triggers.length === 0) {
    readySettled = true;
    markReady();
    return {
      triggerCount: 0,
      ready,
      idle: () => Promise.resolve(),
      close() {
        closed = true;
      },
    };
  }

  const stopRegistration = options.delivery.register(
    registrations,
    async (request): Promise<IdentityBlockingInvocationOutcome> => {
      if (closed) {
        return {
          ok: false,
          error: {
            code: 'unavailable',
            status: 'UNAVAILABLE',
            httpStatus: 503,
            message: 'Auth blocking runtime is shutting down.',
          },
        };
      }
      const trigger = byEventType.get(request.eventType);
      if (trigger === undefined) {
        return {
          ok: false,
          error: {
            code: 'not-found',
            status: 'NOT_FOUND',
            httpStatus: 404,
            message: `No blocking trigger registered for ${request.eventType}.`,
          },
        };
      }
      const runSequence = ++sequence;
      let eventId = `${request.requestId}-${runSequence}`;
      if (options.nextEventId !== undefined) {
        eventId = options.nextEventId(request, runSequence, trigger);
      }
      const input = buildExecutionInput(request, eventId);
      const execOptions: { ensureInitialized?: () => Promise<void> } = {};
      if (options.ensureInitialized !== undefined) {
        execOptions.ensureInitialized = options.ensureInitialized;
      }

      let outcome: IdentityBlockingInvocationOutcome = {
        ok: false,
        error: {
          code: 'internal',
          status: 'INTERNAL',
          httpStatus: 500,
          message: 'An unexpected error occurred.',
        },
      };
      const tracked = (async () => {
        const result = await executeIdentityTrigger(trigger, input, execOptions);
        options.onExecution?.(result, trigger, request);
        if (result.status === 'fulfilled') {
          outcome = { ok: true, response: result.response };
        } else {
          outcome = { ok: false, error: result.error };
        }
      })();
      inFlight.add(tracked);
      try {
        await tracked;
      } finally {
        inFlight.delete(tracked);
      }
      return outcome;
    },
    () => {
      if (!readySettled) {
        readySettled = true;
        markReady();
      }
    },
    (error) => {
      if (!readySettled) {
        readySettled = true;
        failReady(error);
      }
      for (const trigger of triggers) {
        options.onDeliveryError?.(error, trigger);
      }
    },
  );

  return {
    triggerCount: triggers.length,
    ready,
    async idle() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      stopRegistration();
    },
  };
}
