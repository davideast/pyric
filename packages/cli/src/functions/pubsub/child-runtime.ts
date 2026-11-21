/**
 * The v2 Cloud Pub/Sub trigger family inside the isolated Functions child:
 * hosts the in-memory Pub/Sub topic bus, delivers CloudEvents to discovered
 * `onMessagePublished` triggers, and handles host-to-child publish IPC.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { RemoteSandbox } from '../../remote/index.js';
import {
  isChildMessage,
  serializeError,
  type FunctionsChildEvent,
  type PublishPubSubChildResult,
  type PublishPubSubHostRequest,
} from '../child-protocol.js';
import {
  InMemoryPubSubTopicBus,
  type PubSubPublishResult,
  type PubSubWirePublishRequest,
} from './delivery.js';
import { normalizePubSubTopic } from './discovery.js';
import {
  encodePubSubPayloadToBase64,
  normalizePubSubPublishOptions,
  type PubSubExecutionResult,
  type PubSubPublishAttributesOrOptions,
} from './event.js';
import {
  startPubSubTriggerExecution,
  type PubSubTriggerExecutionHost,
} from './execution.js';

export interface PubSubChildRuntimeOptions {
  exported: Record<string, unknown>;
  sandbox?: RemoteSandbox;
  projectId: string;
  location: string;
  send(event: FunctionsChildEvent): void;
}

export interface PubSubChildRuntimeHost extends PubSubTriggerExecutionHost {
  publish(
    topic: string,
    payload?: unknown,
    attributesOrOptions?: PubSubPublishAttributesOrOptions,
  ): Promise<PubSubPublishResult>;
  publishWire(request: PubSubWirePublishRequest): Promise<PubSubPublishResult>;
  handleHostPublishRequest(
    request: PublishPubSubHostRequest,
  ): Promise<PublishPubSubChildResult>;
}

async function resolvePublishNowMs(sandbox?: RemoteSandbox): Promise<number> {
  if (sandbox === undefined) return Date.now();
  try {
    const read = (await sandbox.channel.op({ method: 'sandbox.clock' })) as {
      now?: unknown;
    };
    if (typeof read.now === 'number' && Number.isFinite(read.now)) {
      return read.now;
    }
  } catch {
    // Fall back to wall clock when sandbox clock RPC is unavailable during teardown.
  }
  return Date.now();
}

function executionEvent(
  result: PubSubExecutionResult,
  exportName: string,
  ref: string,
  topicId: string,
): FunctionsChildEvent {
  const params = { topic: topicId };
  if (result.status === 'fulfilled') {
    return {
      type: 'execution',
      exportName,
      ref,
      params,
      status: 'fulfilled',
    };
  }
  return {
    type: 'execution',
    exportName,
    ref,
    params,
    status: 'rejected',
    error: serializeError(result.error),
  };
}

/** Start the Pub/Sub topic bus and subscribe discovered `onMessagePublished` triggers. */
export function startPubSubChildRuntime(
  options: PubSubChildRuntimeOptions,
): PubSubChildRuntimeHost {
  const { exported, sandbox, projectId, location, send } = options;
  const bus = new InMemoryPubSubTopicBus({
    projectId,
    now: () => resolvePublishNowMs(sandbox),
  });

  const executionHost = startPubSubTriggerExecution({
    exported,
    delivery: bus,
    projectId,
    defaultLocation: location,
    eventOptions: (envelope, sequence) => ({
      id: `${randomUUID()}-${sequence}`,
      time: envelope.message.publishTime,
    }),
    onExecution(result, trigger, envelope) {
      send(
        executionEvent(
          result,
          trigger.exportName,
          envelope.topic.resourceName,
          envelope.topic.topicId,
        ),
      );
    },
    onDeliveryError(error, trigger) {
      send({
        type: 'delivery-error',
        exportName: trigger.exportName,
        error: serializeError(error),
      });
    },
  });

  const handleHostPublishRequest = async (
    request: PublishPubSubHostRequest,
  ): Promise<PublishPubSubChildResult> => {
    try {
      const wireRequest: PubSubWirePublishRequest = {
        topic: request.topic,
        dataBase64: request.dataBase64,
      };
      if (request.attributes !== undefined) {
        wireRequest.attributes = request.attributes;
      }
      if (request.orderingKey !== undefined) {
        wireRequest.orderingKey = request.orderingKey;
      }
      if (request.messageId !== undefined) {
        wireRequest.messageId = request.messageId;
      }
      if (request.publishTime !== undefined) {
        wireRequest.publishTime = request.publishTime;
      }
      const result = await bus.publishWire(wireRequest);
      return {
        type: 'publish-pubsub-result',
        requestId: request.requestId,
        outcome: 'published',
        result,
      };
    } catch (error) {
      return {
        type: 'publish-pubsub-result',
        requestId: request.requestId,
        outcome: 'invalid-argument',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    get triggerCount() {
      return executionHost.triggerCount;
    },
    get triggers() {
      return executionHost.triggers;
    },
    get ready() {
      return executionHost.ready;
    },
    idle: () => executionHost.idle(),
    close() {
      executionHost.close();
      bus.close();
    },
    publish(topic, payload, attributesOrOptions) {
      return bus.publish(topic, payload, attributesOrOptions);
    },
    publishWire(request) {
      return bus.publishWire(request);
    },
    handleHostPublishRequest,
  };
}

/**
 * Validate and base64-encode a Pub/Sub publish call on the host, send it over
 * IPC to the isolated Functions child, and await subscriber settlement.
 */
export function sendChildPublishPubSub(
  child: ChildProcess,
  topic: string,
  payload?: unknown,
  attributesOrOptions?: PubSubPublishAttributesOrOptions,
  defaultProjectId = 'demo-project',
): Promise<PubSubPublishResult> {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    typeof child.send !== 'function'
  ) {
    return Promise.reject(new Error('Functions child IPC channel is not connected'));
  }
  if (child.connected === false) {
    return Promise.reject(new Error('Functions child IPC channel is disconnected'));
  }

  let dataBase64: string;
  let normalizedOptions: ReturnType<typeof normalizePubSubPublishOptions>;
  try {
    normalizePubSubTopic(topic, defaultProjectId);
    normalizedOptions = normalizePubSubPublishOptions(attributesOrOptions);
    dataBase64 = encodePubSubPayloadToBase64(payload, normalizedOptions.dataBase64);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  const requestId = randomUUID();
  const request: PublishPubSubHostRequest = {
    type: 'publish-pubsub',
    requestId,
    topic,
    dataBase64,
  };
  if (normalizedOptions.attributes !== undefined) {
    request.attributes = normalizedOptions.attributes;
  }
  if (normalizedOptions.orderingKey !== undefined) {
    request.orderingKey = normalizedOptions.orderingKey;
  }
  if (normalizedOptions.messageId !== undefined) {
    request.messageId = normalizedOptions.messageId;
  }
  if (normalizedOptions.publishTime !== undefined) {
    request.publishTime = normalizedOptions.publishTime;
  }

  return new Promise<PubSubPublishResult>((resolveReply, rejectReply) => {
    let settled = false;
    const cleanup = (): void => {
      child.off('message', onMessage);
      child.off('close', onClose);
      child.off('disconnect', onDisconnect);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReply(error);
    };

    const onClose = (): void => {
      fail(new Error(`Functions child exited while publishing to Pub/Sub topic '${topic}'`));
    };

    const onDisconnect = (): void => {
      fail(
        new Error(
          `Functions child disconnected while publishing to Pub/Sub topic '${topic}'`,
        ),
      );
    };

    const onMessage = (raw: unknown): void => {
      if (!isChildMessage(raw)) return;
      if (raw.type !== 'publish-pubsub-result') return;
      if (raw.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      cleanup();

      if (raw.outcome === 'invalid-argument') {
        rejectReply(new Error(raw.message));
        return;
      }
      resolveReply(raw.result);
    };

    child.on('message', onMessage);
    child.once('close', onClose);
    child.once('disconnect', onDisconnect);
    child.send(request, (sendErr) => {
      if (sendErr) {
        fail(sendErr);
      }
    });
  });
}
