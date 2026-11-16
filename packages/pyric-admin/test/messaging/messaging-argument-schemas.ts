/**
 * Declarative Messaging method schemas and local/remote sandbox arm builders
 * for generative Admin SDK argument differential testing.
 *
 * Uses only public package entrypoints (`pyric/sandbox`,
 * `pyric/messaging/internal`, `pyric-admin/app`, `pyric-admin/messaging`) and
 * general schema/grammar combinators -- zero hand-listed defect vectors.
 */

import {
  REMOTE_SANDBOX,
  initializeSandbox,
  type RemoteSandbox,
  type RemoteSandboxChannel,
  type Sandbox,
  type SandboxEvent,
} from 'pyric/sandbox';
import {
  BrokerSendError,
  getMessagingBroker,
  type BrokerMessage,
} from 'pyric/messaging/internal';
import {
  deleteApp,
  initializeApp,
  type PyricAdminApp,
} from 'pyric-admin/app';
import {
  getMessaging,
  type Messaging,
} from 'pyric-admin/messaging';

import {
  booleanClauseExpressionSchema,
  boundedArraySchema,
  makeCandidate,
  methodSchema,
  objectSchema,
  prefixedIdentifierSchema,
  scalarSchema,
  stringMapSchema,
  type FieldSchema,
  type MethodSchema,
} from '../argument-generator/argument-combinators.js';

export interface MessagingSandboxArm {
  readonly label: 'local' | 'remote';
  readonly app: PyricAdminApp;
  readonly svc: Messaging;
  readonly activeToken: string;
  readonly unregisteredToken: string;
  readonly mintTokens: (count: number) => string[];
  readonly history: () => readonly SandboxEvent[];
  readonly dispose: () => Promise<void>;
}

let armSequence = 0;

function overJsonWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

function createJsonRelayRemoteSandbox(hostSandbox: Sandbox): RemoteSandbox {
  const hostBroker = getMessagingBroker(hostSandbox);
  const channel: RemoteSandboxChannel = {
    async op(rawOp) {
      const wireOp = overJsonWire(rawOp);
      try {
        if (wireOp.method === 'messaging.send') {
          const sendRes = hostBroker.send(wireOp.message as BrokerMessage, {
            validateOnly: wireOp.validateOnly === true,
          });
          return overJsonWire(sendRes);
        }
        if (wireOp.method === 'messaging.subscribeToTopic') {
          const subRes = hostBroker.subscribeToTopic(
            wireOp.tokens as string[],
            wireOp.topic as string,
          );
          return overJsonWire(subRes);
        }
        if (wireOp.method === 'messaging.unsubscribeFromTopic') {
          const unsubRes = hostBroker.unsubscribeFromTopic(
            wireOp.tokens as string[],
            wireOp.topic as string,
          );
          return overJsonWire(unsubRes);
        }
        throw new Error(`Unsupported remote messaging op: ${wireOp.method}`);
      } catch (error) {
        if (error instanceof BrokerSendError) {
          const relayed = new Error(error.envelope.error.message) as Error & {
            code: string;
            envelope: unknown;
          };
          relayed.code = error.envelope.error.status;
          relayed.envelope = overJsonWire(error.envelope);
          throw relayed;
        }
        throw error;
      }
    },
    subscribe() {
      return () => {};
    },
  };

  return {
    ...hostSandbox,
    [REMOTE_SANDBOX]: true,
    serveUrl: 'http://localhost:5000',
    channel,
  };
}

export function createMessagingArm(kind: 'local' | 'remote'): MessagingSandboxArm {
  const hostSandbox = initializeSandbox({ projectId: 'demo-project' });
  const broker = getMessagingBroker(hostSandbox);
  const activeToken = broker.getTokenFor('active-reg');
  const unregisteredToken = broker.getTokenFor('deleted-reg');
  broker.deleteTokenFor('deleted-reg');

  let targetSandbox: Sandbox = hostSandbox;
  if (kind === 'remote') {
    targetSandbox = createJsonRelayRemoteSandbox(hostSandbox);
  }
  const app = initializeApp(
    { sandbox: targetSandbox, projectId: 'demo-project' },
    `msg-gen-${kind}-${++armSequence}`,
  );

  let mintedCounter = 0;
  return {
    label: kind,
    app,
    svc: getMessaging(app),
    activeToken,
    unregisteredToken,
    mintTokens(count: number): string[] {
      const tokens: string[] = [];
      for (let i = 0; i < count; i++) {
        tokens.push(broker.getTokenFor(`batch-reg-${++mintedCounter}`));
      }
      return tokens;
    },
    history(): readonly SandboxEvent[] {
      return hostSandbox.history();
    },
    async dispose(): Promise<void> {
      await deleteApp(app).catch(() => {});
      hostSandbox.dispose();
    },
  };
}

export interface MessagingSchemaTokens {
  readonly activeToken: string;
  readonly unregisteredToken: string;
  readonly tokenAt: (index: number) => string;
}

const TOPIC_PREFIX_FORMS = ['', '/topics/', '/topics/' + '/topics/', 'topics/'] as const;
const TOPIC_BODY_ATOMS = ['', 'alerts', 'bad topic!', 'a/b'] as const;

function buildTopicFieldSchema(mutuallyExclusiveWith: readonly string[] = []): FieldSchema {
  return prefixedIdentifierSchema({
    prefixes: TOPIC_PREFIX_FORMS,
    bodies: TOPIC_BODY_ATOMS,
    mutuallyExclusiveWith,
  });
}

function buildConditionFieldSchema(mutuallyExclusiveWith: readonly string[] = []): FieldSchema {
  return booleanClauseExpressionSchema({
    clauseCounts: [1, 2, 3, 4, 5, 6],
    operators: ['&&', '||'],
    keywordSeparators: [' ', '', '\t'],
    clauseShapes: [
      { label: 'quoted', render: (idx, ws) => `'t${idx}'${ws}in${ws}topics` },
      { label: 'unquoted', render: (idx, ws) => `t${idx}${ws}in${ws}topics` },
      { label: 'mismatched-quote', render: (idx, ws) => `'t${idx}"${ws}in${ws}topics` },
      { label: 'prefixed-quote', render: (idx, ws) => `'/topics/t${idx}'${ws}in${ws}topics` },
    ],
    mutuallyExclusiveWith,
  });
}

function buildBaseMessageOptionFields(): Record<string, FieldSchema> {
  const fcmOptionsField = objectSchema({
    validBase: () => ({}),
    fields: {
      analyticsLabel: scalarSchema(),
    },
  });

  return {
    data: stringMapSchema({
      sampleKey: 'item',
      validValue: 'ok',
      maxByteLength: 4506,
    }),
    notification: objectSchema({
      validBase: () => ({ title: 'Alert' }),
      fields: {
        imageUrl: scalarSchema({
          extraCandidates: () => [
            makeCandidate('valid-https', () => 'https://example.com/item.png'),
            makeCandidate('non-url-text', () => 'not-a-valid-url'),
            makeCandidate('ftp-scheme', () => 'ftp://example.com/item.png'),
          ],
        }),
      },
    }),
    webpush: objectSchema({
      validBase: () => ({}),
      fields: {
        headers: stringMapSchema({ sampleKey: 'TTL', validValue: '3600' }),
        data: stringMapSchema({ sampleKey: 'item', validValue: 'ok' }),
      },
    }),
    android: objectSchema({
      validBase: () => ({}),
      fields: {
        ttl: scalarSchema({
          extraCandidates: () => [
            makeCandidate('-1', () => -1),
            makeCandidate('3600000', () => 3_600_000),
          ],
        }),
        data: stringMapSchema({ sampleKey: 'item', validValue: 'ok' }),
        notification: objectSchema({ validBase: () => ({}), fields: {} }),
        fcmOptions: fcmOptionsField,
      },
    }),
    apns: objectSchema({
      validBase: () => ({}),
      fields: {
        liveActivityToken: scalarSchema(),
        headers: stringMapSchema({ sampleKey: 'apns-priority', validValue: '10' }),
        payload: objectSchema({
          validBase: () => ({}),
          fields: {
            aps: objectSchema({ validBase: () => ({}), fields: {} }),
          },
        }),
        fcmOptions: fcmOptionsField,
      },
    }),
    fcmOptions: fcmOptionsField,
  };
}

export function buildMessagingMethodSchemas(tokens: MessagingSchemaTokens): {
  readonly enableLegacyHttpTransport: MethodSchema;
  readonly send: MethodSchema;
  readonly sendEach: MethodSchema;
  readonly sendEachForMulticast: MethodSchema;
  readonly subscribeToTopic: MethodSchema;
  readonly unsubscribeFromTopic: MethodSchema;
} {
  const tokenField = scalarSchema({
    mutuallyExclusiveWith: ['topic', 'condition'],
    extraCandidates: () => [
      makeCandidate('active-token', () => tokens.activeToken),
      makeCandidate('deleted-token', () => tokens.unregisteredToken),
      makeCandidate('unminted-token', () => 'aaaa:APA91bUNMINTED'),
      makeCandidate('malformed-token', () => 'not-a-valid-token'),
    ],
  });

  const baseOptionFields = buildBaseMessageOptionFields();

  const sendSchema = methodSchema({
    name: 'send',
    parameters: [
      {
        name: 'message',
        validValue: () => ({ topic: 'alerts', data: { item: '1' } }),
        schema: objectSchema({
          validBase: () => ({ topic: 'alerts' }),
          fields: {
            topic: buildTopicFieldSchema(['token', 'condition']),
            condition: buildConditionFieldSchema(['topic', 'token']),
            token: tokenField,
            ...baseOptionFields,
          },
        }),
      },
      {
        name: 'dryRun',
        validValue: () => undefined,
        omitTrailingUndefined: true,
        schema: scalarSchema(),
      },
    ],
  });

  const batchItemSchema = objectSchema({
    validBase: () => ({ topic: 'alerts' }),
    fields: {
      topic: buildTopicFieldSchema(['condition']),
      condition: buildConditionFieldSchema(['topic']),
      data: stringMapSchema({ sampleKey: 'item', validValue: 'ok' }),
      notification: objectSchema({ validBase: () => ({ title: 'Alert' }), fields: {} }),
    },
  });

  const sendEachSchema = methodSchema({
    name: 'sendEach',
    parameters: [
      {
        name: 'messages',
        validValue: () => [{ topic: 'alerts', data: { item: '1' } }],
        schema: boundedArraySchema({
          createValidElement: (index) => ({ topic: 'alerts', data: { idx: String(index) } }),
          maxLength: 500,
          itemSchema: batchItemSchema,
        }),
      },
      {
        name: 'dryRun',
        validValue: () => undefined,
        omitTrailingUndefined: true,
        schema: scalarSchema(),
      },
    ],
  });

  const sendEachForMulticastSchema = methodSchema({
    name: 'sendEachForMulticast',
    parameters: [
      {
        name: 'message',
        validValue: () => ({ tokens: [tokens.activeToken], data: { item: '1' } }),
        schema: objectSchema({
          validBase: () => ({ tokens: [tokens.activeToken] }),
          fields: {
            tokens: boundedArraySchema({
              createValidElement: (index) => tokens.tokenAt(index),
              maxLength: 500,
            }),
            ...baseOptionFields,
          },
        }),
      },
      {
        name: 'dryRun',
        validValue: () => undefined,
        omitTrailingUndefined: true,
        schema: scalarSchema(),
      },
    ],
  });

  const buildTopicManagementSchema = (name: 'subscribeToTopic' | 'unsubscribeFromTopic'): MethodSchema =>
    methodSchema({
      name,
      parameters: [
        {
          name: 'registrationTokens',
          validValue: () => [tokens.activeToken],
          schema: boundedArraySchema({
            createValidElement: (index) => tokens.tokenAt(index),
            maxLength: 1000,
            allowSingleScalarElement: true,
            itemSchema: tokenField,
          }),
        },
        {
          name: 'topic',
          validValue: () => 'alerts',
          schema: buildTopicFieldSchema(),
        },
      ],
    });

  return {
    enableLegacyHttpTransport: methodSchema({
      name: 'enableLegacyHttpTransport',
      parameters: [],
    }),
    send: sendSchema,
    sendEach: sendEachSchema,
    sendEachForMulticast: sendEachForMulticastSchema,
    subscribeToTopic: buildTopicManagementSchema('subscribeToTopic'),
    unsubscribeFromTopic: buildTopicManagementSchema('unsubscribeFromTopic'),
  };
}
