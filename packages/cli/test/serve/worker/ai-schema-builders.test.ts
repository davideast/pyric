import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteApp, FirebaseError } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
  'ai-offline-schema-builders-and-guards.json',
);

interface SchemaBuildersBehavior {
  fetchCalls: number;
  schemaTypes: Record<string, string>;
  primitives: {
    stringInstance: boolean;
    stringJson: Record<string, unknown>;
    nullableStringJson: Record<string, unknown>;
    integerInstance: boolean;
    integerJson: Record<string, unknown>;
    numberInstance: boolean;
    numberJson: Record<string, unknown>;
    booleanInstance: boolean;
    booleanJson: Record<string, unknown>;
    enumStringJson: Record<string, unknown>;
    arrayInstance: boolean;
    arrayJson: Record<string, unknown>;
  };
  objectSchemas: {
    isObjectSchema: boolean;
    withOptionalJson: Record<string, unknown>;
    withOptionalPropertyKeysSorted: string[];
    emptyOptionalJson: Record<string, unknown>;
    orderedJson: Record<string, unknown>;
  };
  anyOfSchemas: {
    isAnyOfSchema: boolean;
    hasTopLevelType: boolean;
    anyOfJson: Record<string, unknown>;
    emptyAnyOfGuard: {
      threw: boolean;
      isAIError: boolean;
      isFirebaseError: boolean;
      code: string | null;
    };
  };
}

function loadSchemaObservation(): SchemaBuildersBehavior {
  const parsed = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as {
    behavior: SchemaBuildersBehavior;
  };
  return parsed.behavior;
}

function serializeSchema(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

let appSeq = 0;

describe('served AI entry and SharedWorker Schema builder parity', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  async function setupServedAi() {
    const ctx = await makeHostCtx();
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };
    const servedAi = await import('../../../src/serve/entries/ai.js');
    return { ctx, servedAi };
  }

  it('replays ai-offline-schema-builders-and-guards across served entries/ai', async () => {
    const facts = loadSchemaObservation();
    const { ctx, servedAi } = await setupServedAi();
    const {
      AIError,
      AnyOfSchema,
      ArraySchema,
      BooleanSchema,
      IntegerSchema,
      NumberSchema,
      ObjectSchema,
      Schema,
      SchemaType,
      StringSchema,
    } = servedAi;

    try {
      expect({
        STRING: SchemaType.STRING,
        NUMBER: SchemaType.NUMBER,
        INTEGER: SchemaType.INTEGER,
        BOOLEAN: SchemaType.BOOLEAN,
        ARRAY: SchemaType.ARRAY,
        OBJECT: SchemaType.OBJECT,
      }).toEqual(facts.schemaTypes);

      const strSchema = Schema.string({ description: 'label' });
      const nullableStrSchema = Schema.string({ nullable: true });
      const intSchema = Schema.integer();
      const numSchema = Schema.number();
      const boolSchema = Schema.boolean();
      const enumSchema = Schema.enumString({ enum: ['red', 'green', 'blue'] });
      const arrSchema = Schema.array({ items: Schema.string() });

      expect(strSchema instanceof StringSchema).toBe(facts.primitives.stringInstance);
      expect(serializeSchema(strSchema)).toEqual(facts.primitives.stringJson);
      expect(serializeSchema(nullableStrSchema)).toEqual(facts.primitives.nullableStringJson);
      expect(intSchema instanceof IntegerSchema).toBe(facts.primitives.integerInstance);
      expect(serializeSchema(intSchema)).toEqual(facts.primitives.integerJson);
      expect(numSchema instanceof NumberSchema).toBe(facts.primitives.numberInstance);
      expect(serializeSchema(numSchema)).toEqual(facts.primitives.numberJson);
      expect(boolSchema instanceof BooleanSchema).toBe(facts.primitives.booleanInstance);
      expect(serializeSchema(boolSchema)).toEqual(facts.primitives.booleanJson);
      expect(serializeSchema(enumSchema)).toEqual({
        ...facts.primitives.enumStringJson,
        format: 'enum',
      });
      expect(arrSchema instanceof ArraySchema).toBe(facts.primitives.arrayInstance);
      expect(serializeSchema(arrSchema)).toEqual(facts.primitives.arrayJson);

      const objectWithOptional = Schema.object({
        properties: { city: Schema.string(), days: Schema.integer() },
        optionalProperties: ['days'],
      });
      const objectEmptyOptional = Schema.object({
        properties: { alpha: Schema.string(), beta: Schema.integer() },
        optionalProperties: [],
      });
      const objectOrdered = Schema.object({
        title: 'Profile',
        properties: { name: Schema.string(), age: Schema.integer(), email: Schema.string() },
        propertyOrdering: ['name', 'email', 'age'],
      });
      expect(objectWithOptional instanceof ObjectSchema).toBe(facts.objectSchemas.isObjectSchema);
      expect(serializeSchema(objectWithOptional)).toEqual(facts.objectSchemas.withOptionalJson);
      expect(serializeSchema(objectEmptyOptional)).toEqual(facts.objectSchemas.emptyOptionalJson);
      expect(serializeSchema(objectOrdered)).toEqual(facts.objectSchemas.orderedJson);

      const anyOfSchema = Schema.anyOf({ anyOf: [Schema.string(), Schema.integer()] });
      const anyOfJson = serializeSchema(anyOfSchema);
      expect(anyOfSchema instanceof AnyOfSchema).toBe(facts.anyOfSchemas.isAnyOfSchema);
      expect('type' in anyOfJson).toBe(facts.anyOfSchemas.hasTopLevelType);
      expect(anyOfJson).toEqual(facts.anyOfSchemas.anyOfJson);

      let threw = false;
      let isAIError = false;
      let isFirebaseError = false;
      let code: string | null = null;
      try {
        Schema.anyOf({ anyOf: [] });
      } catch (err) {
        threw = true;
        isAIError = err instanceof AIError;
        isFirebaseError = err instanceof FirebaseError;
        if (err && typeof err === 'object') {
          const record = err as { code?: unknown };
          if (typeof record.code === 'string') {
            code = record.code;
          }
        }
      }
      expect({ threw, isAIError, isFirebaseError, code }).toEqual(
        facts.anyOfSchemas.emptyAnyOfGuard,
      );
    } finally {
      ctx.sandbox.dispose();
    }
  });

  it('transports Schema.object across SharedWorker client and worker host ai.generateContent', async () => {
    const facts = loadSchemaObservation();
    const { ctx, servedAi } = await setupServedAi();
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-ai-schema', appId: '1:123456789012:web:abcdef' },
      `served-ai-schema-${++appSeq}`,
    );
    try {
      const validClaim = await mintAppCheckToken(
        { appId: '1:123456789012:web:abcdef', projectId: 'demo-ai-schema' },
        3600,
      );
      const responseSchema = servedAi.Schema.object({
        properties: {
          city: servedAi.Schema.string(),
          days: servedAi.Schema.integer(),
        },
        optionalProperties: ['days'],
      });
      expect(serializeSchema(responseSchema)).toEqual(facts.objectSchemas.withOptionalJson);

      let resId = '';
      let resOk = false;
      let resValue: unknown = null;
      const hostPort: PortLike & { messages: OutboundMessage[] } = {
        messages: [],
        postMessage(msg: OutboundMessage) {
          this.messages.push(msg);
          if (msg.t === 'res') {
            resId = msg.id;
            resOk = msg.ok;
            if (msg.ok) {
              resValue = msg.value;
            }
          }
        },
      };
      await handleMessage(ctx, hostPort, {
        t: 'op',
        id: 'schema-worker-op',
        method: 'ai.generateContent',
        model: 'models/gemini-flash-lite-latest',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Return JSON.' }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: serializeSchema(responseSchema),
          },
        },
        appCheck: { token: validClaim.token },
        engine: {
          kind: 'scripted',
          script: [{ respond: { json: { city: 'Portland', days: 3 } } }],
        },
      });
      expect(resId).toBe('schema-worker-op');
      expect(resOk).toBe(true);
      const candidates = (resValue as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;
      const firstPartText = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      expect(JSON.parse(firstPartText)).toEqual({ city: 'Portland', days: 3 });
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });
});
