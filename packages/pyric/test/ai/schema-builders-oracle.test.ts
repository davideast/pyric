/**
 * Oracle conformance replay for `ai-offline-schema-builders-and-guards`:
 *   - `ai#schema-object-tojson` (AI-SCHEMA-OBJECT)
 *   - `ai#schema-string-enum` (AI-SCHEMA-ENUM, documented `format: 'enum'` delta)
 *   - `ai#schema-primitives` (AI-SCHEMA-PRIMITIVES)
 *   - `ai#schema-anyof` (AI-SCHEMA-ANYOF)
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirebaseError } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
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
  getAI,
  getGenerativeModel,
} from 'pyric/ai';
import { script } from 'pyric/ai/scripting';

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

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
  'ai-offline-schema-builders-and-guards.json',
);

function loadSchemaObservation(): SchemaBuildersBehavior {
  const parsed = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as {
    behavior: SchemaBuildersBehavior;
  };
  return parsed.behavior;
}

function serializeSchema(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

describe('oracle replay: ai-offline-schema-builders-and-guards', () => {
  it('replays SchemaType and primitive/array builders with zero outbound fetches (ai#schema-primitives)', () => {
    const facts = loadSchemaObservation();
    expect(facts.fetchCalls).toBe(0);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in schema builder replay');
      },
      { preconnect: originalFetch.preconnect },
    );

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
      expect(arrSchema instanceof ArraySchema).toBe(facts.primitives.arrayInstance);
      expect(serializeSchema(arrSchema)).toEqual(facts.primitives.arrayJson);
      expect(fetchCalls).toBe(facts.fetchCalls);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('replays Schema.enumString and pins the documented format: enum delta vs firebase 12.19.0 (ai#schema-string-enum)', () => {
    const facts = loadSchemaObservation();
    expect('format' in facts.primitives.enumStringJson).toBe(false);

    const enumSchema = Schema.enumString({ enum: ['red', 'green', 'blue'] });
    expect(enumSchema instanceof StringSchema).toBe(true);
    expect(serializeSchema(enumSchema)).toEqual({
      ...facts.primitives.enumStringJson,
      format: 'enum',
    });
  });

  it('replays Schema.object optionalProperties, empty optionalProperties, and propertyOrdering (ai#schema-object-tojson)', async () => {
    const facts = loadSchemaObservation();

    const objectWithOptional = Schema.object({
      properties: {
        city: Schema.string(),
        days: Schema.integer(),
      },
      optionalProperties: ['days'],
    });
    const objectEmptyOptional = Schema.object({
      properties: {
        alpha: Schema.string(),
        beta: Schema.integer(),
      },
      optionalProperties: [],
    });
    const objectOrdered = Schema.object({
      title: 'Profile',
      properties: {
        name: Schema.string(),
        age: Schema.integer(),
        email: Schema.string(),
      },
      propertyOrdering: ['name', 'email', 'age'],
    });

    const withOptionalJson = serializeSchema(objectWithOptional);
    const propsRecord = withOptionalJson.properties as Record<string, unknown>;
    const sortedKeys = Object.keys(propsRecord).sort();

    expect(objectWithOptional instanceof ObjectSchema).toBe(facts.objectSchemas.isObjectSchema);
    expect(withOptionalJson).toEqual(facts.objectSchemas.withOptionalJson);
    expect(sortedKeys).toEqual(facts.objectSchemas.withOptionalPropertyKeysSorted);
    expect(serializeSchema(objectEmptyOptional)).toEqual(facts.objectSchemas.emptyOptionalJson);
    expect(serializeSchema(objectOrdered)).toEqual(facts.objectSchemas.orderedJson);

    const sandbox = initializeSandbox();
    try {
      const ai = getAI(sandbox);
      let seenSchema: unknown;
      script(ai, [
        {
          match: (req) => {
            seenSchema = req.generationConfig?.responseSchema;
            return true;
          },
          respond: { json: { city: 'Seattle' } },
        },
      ]);
      const model = getGenerativeModel(ai, { model: 'gemini-flash-lite-latest' });
      const res = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'Pick a city.' }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: objectWithOptional,
        },
      });
      expect(seenSchema).toEqual(facts.objectSchemas.withOptionalJson);
      expect(JSON.parse(res.response.text())).toEqual({ city: 'Seattle' });
    } finally {
      sandbox.dispose();
    }
  });

  it('replays Schema.anyOf serialization and empty-anyOf AIError / FirebaseError guard (ai#schema-anyof)', () => {
    const facts = loadSchemaObservation();
    const anyOfSchema = Schema.anyOf({
      anyOf: [Schema.string(), Schema.integer()],
    });
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
});
