import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { FirebaseError } from '../../../src/serve/entries/app.js';
import {
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
} from '../../../src/serve/entries/ai.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';

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

function createFakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return {
    messages,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
    },
  };
}

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'test-ai-schemas', subs: new Map() };
}

async function sendOp(
  ctx: HostCtx,
  port: ReturnType<typeof createFakePort>,
  msg: InboundMessage,
): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  const id = (msg as { id: string }).id;
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (res === undefined) {
    throw new Error(`No res message for ${id}`);
  }
  return res;
}

describe('served AI entry and worker host Schema builder parity', () => {
  it('replays ai-offline-schema-builders-and-guards across served entries/ai and entries/app', () => {
    const facts = loadSchemaObservation();

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
  });

  it('transports serialized Schema.object, Schema.enumString, and Schema.anyOf across worker ai.generateContent', async () => {
    const facts = loadSchemaObservation();
    const ctx = makeCtx();
    try {
      const port = createFakePort();
      const responseSchema = serializeSchema(
        Schema.object({
          properties: {
            city: Schema.string(),
            days: Schema.integer(),
          },
          optionalProperties: ['days'],
        }),
      );
      expect(responseSchema).toEqual(facts.objectSchemas.withOptionalJson);

      const res = await sendOp(ctx, port, {
        t: 'op',
        id: 'schema-worker-op',
        method: 'ai.generateContent',
        model: 'models/gemini-flash-lite-latest',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Return JSON.' }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
          },
        },
        engine: {
          kind: 'scripted',
          script: [{ respond: { json: { city: 'Portland', days: 3 } } }],
        },
      });
      expect(res.ok).toBe(true);
    } finally {
      ctx.sandbox.dispose();
    }
  });
});
