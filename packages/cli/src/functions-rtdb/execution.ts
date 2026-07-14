import { discoverOnValueCreated, type DiscoveredOnValueCreated } from './discovery.js';
import type { RtdbTriggerDelivery } from './delivery.js';
import {
  executeOnValueCreated,
  type CreatedEventOptions,
  type CreatedExecutionResult,
} from './event.js';
import {
  projectValueCreates,
  watchPath,
  type CreatedValueProjection,
} from './projection.js';

export interface OnValueCreatedExecutionOptions {
  exported: Record<string, unknown>;
  delivery: RtdbTriggerDelivery;
  eventOptions(
    projection: CreatedValueProjection,
    sequence: number,
    trigger: DiscoveredOnValueCreated,
  ): CreatedEventOptions;
  onExecution?(
    result: CreatedExecutionResult,
    trigger: DiscoveredOnValueCreated,
    projection: CreatedValueProjection,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredOnValueCreated): void;
}

export interface OnValueCreatedExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  idle(): Promise<void>;
  close(): void;
}

/** Subscribe discovered functions and serialize their snapshot executions. */
export function startOnValueCreatedExecution(
  options: OnValueCreatedExecutionOptions,
): OnValueCreatedExecutionHost {
  const triggers = discoverOnValueCreated(options.exported);
  const unsubscribe: Array<() => void> = [];
  let closed = false;
  let sequence = 0;
  let tail = Promise.resolve();
  let baselinesRemaining = triggers.length;
  let readinessFailed = false;
  let markReady!: () => void;
  let failReady!: (error: unknown) => void;
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
          for (const projection of projectValueCreates(trigger.reference, {
            path,
            before,
            after: next,
          })) {
            const deliverySequence = ++sequence;
            tail = tail.then(async () => {
              const result = await executeOnValueCreated(
                trigger,
                projection,
                options.eventOptions(projection, deliverySequence, trigger),
              );
              options.onExecution?.(result, trigger, projection);
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
