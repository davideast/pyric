import {
  CREATED_EVENT_TYPE,
  discoverOnValueCreated,
  discoverRtdbValueTriggers,
  type DiscoveredOnValueCreated,
  type DiscoveredRtdbValueTrigger,
} from './discovery.js';
import type { RtdbTriggerDelivery } from './delivery.js';
import {
  executeRtdbValueTrigger,
  type CreatedEventOptions,
  type CreatedExecutionResult,
  type RtdbEventOptions,
  type RtdbExecutionResult,
} from './event.js';
import {
  projectRtdbValueTransitions,
  watchPath,
  type CreatedValueProjection,
  type RtdbValueProjection,
} from './projection.js';

export interface RtdbValueExecutionOptions {
  exported: Record<string, unknown>;
  delivery: RtdbTriggerDelivery;
  eventOptions(
    projection: RtdbValueProjection,
    sequence: number,
    trigger: DiscoveredRtdbValueTrigger,
  ): RtdbEventOptions | Promise<RtdbEventOptions>;
  onExecution?(
    result: RtdbExecutionResult,
    trigger: DiscoveredRtdbValueTrigger,
    projection: RtdbValueProjection,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredRtdbValueTrigger): void;
}

export interface OnValueCreatedExecutionOptions {
  exported: Record<string, unknown>;
  delivery: RtdbTriggerDelivery;
  /**
   * The CloudEvent envelope for one delivery. Awaited, because `time` is the
   * instant the sandbox that produced the write reports, and a sandbox behind a
   * transport answers that asynchronously.
   */
  eventOptions(
    projection: CreatedValueProjection,
    sequence: number,
    trigger: DiscoveredOnValueCreated,
  ): CreatedEventOptions | Promise<CreatedEventOptions>;
  onExecution?(
    result: CreatedExecutionResult,
    trigger: DiscoveredOnValueCreated,
    projection: CreatedValueProjection,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredOnValueCreated): void;
}

export interface RtdbValueExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  idle(): Promise<void>;
  close(): void;
}

export type OnValueCreatedExecutionHost = RtdbValueExecutionHost;

function startExecutionForTriggers(
  triggers: readonly DiscoveredRtdbValueTrigger[],
  options: Omit<RtdbValueExecutionOptions, 'exported'>,
): RtdbValueExecutionHost {
  const unsubscribe: Array<() => void> = [];
  let closed = false;
  let sequence = 0;
  let tail = Promise.resolve();
  let baselinesRemaining = triggers.length;
  let readinessFailed = false;
  let markReady: () => void = () => {};
  let failReady: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  if (baselinesRemaining === 0) markReady();

  for (const trigger of triggers) {
    const path = watchPath(trigger.reference);
    let hasBaseline = false;
    let previous: unknown;
    unsubscribe.push(
      options.delivery.subscribe(
        path,
        (next) => {
          if (closed) return;
          if (!hasBaseline) {
            previous = next;
            hasBaseline = true;
            baselinesRemaining -= 1;
            if (baselinesRemaining === 0 && !readinessFailed) markReady();
            return;
          }
          const before = previous;
          previous = next;
          const projections = projectRtdbValueTransitions(
            trigger.eventType,
            trigger.reference,
            { path, before, after: next },
          );
          for (const projection of projections) {
            const deliverySequence = ++sequence;
            tail = tail.then(async () => {
              if (closed) return;
              try {
                const eventOptions = await options.eventOptions(
                  projection,
                  deliverySequence,
                  trigger,
                );
                if (closed) return;
                const result = await executeRtdbValueTrigger(
                  trigger,
                  projection,
                  eventOptions,
                );
                options.onExecution?.(result, trigger, projection);
              } catch (error) {
                if (!closed) {
                  options.onDeliveryError?.(error, trigger);
                }
              }
            });
          }
        },
        (error) => {
          if (!hasBaseline && !readinessFailed) {
            readinessFailed = true;
            failReady(error);
          }
          options.onDeliveryError?.(error, trigger);
        },
      ),
    );
  }

  return {
    triggerCount: triggers.length,
    ready,
    idle: () => tail,
    close() {
      if (closed) return;
      closed = true;
      for (const stop of unsubscribe.splice(0)) stop();
    },
  };
}

/** Subscribe discovered v2 RTDB triggers (`created`, `updated`, `deleted`, `written`) and serialize executions. */
export function startRtdbValueExecution(
  options: RtdbValueExecutionOptions,
): RtdbValueExecutionHost {
  const triggers = discoverRtdbValueTriggers(options.exported);
  return startExecutionForTriggers(triggers, options);
}

/** Subscribe discovered `onValueCreated` functions and serialize their snapshot executions. */
export function startOnValueCreatedExecution(
  options: OnValueCreatedExecutionOptions,
): OnValueCreatedExecutionHost {
  const triggers: DiscoveredRtdbValueTrigger[] = discoverOnValueCreated(
    options.exported,
  ).map((trigger): DiscoveredRtdbValueTrigger => ({
    ...trigger,
    eventType: CREATED_EVENT_TYPE,
  }));
  return startExecutionForTriggers(triggers, {
    delivery: options.delivery,
    eventOptions: (projection, sequence, trigger) => {
      const createdProjection: CreatedValueProjection = {
        ref: projection.ref,
        params: projection.params,
        value: projection.after,
      };
      return options.eventOptions(createdProjection, sequence, trigger);
    },
    onExecution: (result, trigger, projection) => {
      options.onExecution?.(result, trigger, {
        ref: projection.ref,
        params: projection.params,
        value: projection.after,
      });
    },
    onDeliveryError: (error, trigger) => {
      options.onDeliveryError?.(error, trigger);
    },
  });
}
