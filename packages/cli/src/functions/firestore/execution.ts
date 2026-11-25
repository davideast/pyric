/**
 * Execution host for discovered `firebase-functions/v2/firestore` document triggers.
 */
import type {
  FirestoreMutationRecord,
  FirestoreTriggerDelivery,
} from './delivery.js';
import {
  discoverFirestoreTriggers,
  type DiscoveredFirestoreTrigger,
  type InspectFirestoreTriggersOptions,
} from './discovery.js';
import {
  classifyDocumentTransition,
  triggerMatchesTransitionKind,
} from './document-change.js';
import {
  matchFirestoreDocument,
  normalizeFirestoreDocumentPath,
} from './document-pattern.js';
import {
  executeFirestoreTrigger,
  type FirestoreEventBuildInput,
  type FirestoreTriggerExecutionResult,
} from './event.js';

interface MatchedFirestoreTriggerDelivery {
  readonly document: string;
  readonly params: Record<string, string>;
  readonly mutation: FirestoreMutationRecord;
}

interface FirestoreTriggerEnvelopeOptions {
  readonly id: string;
  readonly time: string;
  readonly projectId: string;
  readonly location: string;
}

export interface FirestoreTriggerExecutionOptions {
  readonly exported: Record<string, unknown>;
  readonly delivery: FirestoreTriggerDelivery;
  readonly discoveryOptions?: InspectFirestoreTriggersOptions;
  envelopeOptions(
    matched: MatchedFirestoreTriggerDelivery,
    sequence: number,
    trigger: DiscoveredFirestoreTrigger,
  ): FirestoreTriggerEnvelopeOptions | Promise<FirestoreTriggerEnvelopeOptions>;
  onExecution?(
    result: FirestoreTriggerExecutionResult,
    trigger: DiscoveredFirestoreTrigger,
    matched: MatchedFirestoreTriggerDelivery,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredFirestoreTrigger): void;
}

export interface FirestoreTriggerExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  idle(): Promise<void>;
  close(): void;
}

/** Subscribe discovered Firestore triggers by database and serialize handler runs. */
export function startFirestoreTriggerExecution(
  options: FirestoreTriggerExecutionOptions,
): FirestoreTriggerExecutionHost {
  const triggers = discoverFirestoreTriggers(
    options.exported,
    options.discoveryOptions,
  );
  const byDatabase = new Map<string, DiscoveredFirestoreTrigger[]>();
  for (const trigger of triggers) {
    let group = byDatabase.get(trigger.database);
    if (group === undefined) {
      group = [];
      byDatabase.set(trigger.database, group);
    }
    group.push(trigger);
  }

  const unsubscribes: Array<() => void> = [];
  let closed = false;
  let sequence = 0;
  let tail = Promise.resolve();
  let databasesRemaining = byDatabase.size;
  let readinessFailed = false;

  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  if (databasesRemaining === 0) {
    resolveReady();
  }

  for (const [database, dbTriggers] of byDatabase) {
    let dbReady = false;
    unsubscribes.push(
      options.delivery.subscribe(database, {
        onReady() {
          if (closed || dbReady) return;
          dbReady = true;
          databasesRemaining -= 1;
          if (databasesRemaining === 0 && !readinessFailed) {
            resolveReady();
          }
        },
        onMutation(mutation) {
          if (closed) return;
          if (mutation.database !== database) return;
          const net = classifyDocumentTransition(
            mutation.before?.fields ?? null,
            mutation.after?.fields ?? null,
          );
          if (net.kind === 'noop') return;
          let computedUpdateMask = mutation.updateMask;
          if (computedUpdateMask === undefined && net.kind === 'updated') {
            computedUpdateMask = net.updateMask;
          }
          const normalizedDoc = normalizeFirestoreDocumentPath(mutation.document);
          for (const trigger of dbTriggers) {
            if (!triggerMatchesTransitionKind(trigger.eventType, net.kind)) continue;
            const params = matchFirestoreDocument(trigger.document, normalizedDoc);
            if (params === null) continue;
            const matched: MatchedFirestoreTriggerDelivery = {
              document: normalizedDoc,
              params,
              mutation,
            };
            const deliverySequence = (sequence += 1);
            tail = tail.then(async () => {
              if (closed) return;
              try {
                const envelope = await options.envelopeOptions(
                  matched,
                  deliverySequence,
                  trigger,
                );
                if (closed) return;
                const eventInput: FirestoreEventBuildInput = {
                  id: envelope.id,
                  time: envelope.time,
                  projectId: envelope.projectId,
                  location: envelope.location,
                  database: trigger.database,
                  namespace: trigger.namespace,
                  document: normalizedDoc,
                  before: mutation.before,
                  after: mutation.after,
                  updateMask: computedUpdateMask,
                  authType: mutation.authType,
                  authId: mutation.authId,
                };
                const result = await executeFirestoreTrigger(trigger, eventInput);
                options.onExecution?.(result, trigger, matched);
              } catch (error) {
                if (!closed) {
                  options.onDeliveryError?.(error, trigger);
                }
              }
            });
          }
        },
        onError(error) {
          if (!dbReady && !readinessFailed) {
            readinessFailed = true;
            rejectReady(error);
          }
          for (const trigger of dbTriggers) {
            options.onDeliveryError?.(error, trigger);
          }
        },
      }),
    );
  }

  return {
    triggerCount: triggers.length,
    ready,
    idle: () => tail,
    close() {
      if (closed) return;
      closed = true;
      for (const stop of unsubscribes.splice(0)) {
        stop();
      }
    },
  };
}
