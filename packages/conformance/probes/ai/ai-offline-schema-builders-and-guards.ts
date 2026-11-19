import { FirebaseError } from 'firebase/app';
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
} from 'firebase/ai';
import type { Probe } from '../../rigs/types.ts';

function serializeSchema(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: 'ai#schema-object-tojson',
  rowIds: [
    'ai#schema-object-tojson',
    'ai#schema-string-enum',
    'ai#schema-primitives',
    'ai#schema-anyof',
  ],
  description:
    'Pure offline firebase/ai Schema.object, primitive/array/enumString builders, and Schema.anyOf serialization and empty-anyOf AIError guard with zero network calls.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in offline AI probe');
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const strSchema = Schema.string({ description: 'label' });
      const nullableStrSchema = Schema.string({ nullable: true });
      const intSchema = Schema.integer();
      const numSchema = Schema.number();
      const boolSchema = Schema.boolean();
      const enumSchema = Schema.enumString({ enum: ['red', 'green', 'blue'] });
      const arrSchema = Schema.array({ items: Schema.string() });

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

      const anyOfSchema = Schema.anyOf({
        anyOf: [Schema.string(), Schema.integer()],
      });
      const anyOfJson = serializeSchema(anyOfSchema);

      let emptyAnyOfThrew = false;
      let emptyAnyOfIsAIError = false;
      let emptyAnyOfIsFirebaseError = false;
      let emptyAnyOfCode: string | null = null;
      try {
        Schema.anyOf({ anyOf: [] });
      } catch (err) {
        emptyAnyOfThrew = true;
        emptyAnyOfIsAIError = err instanceof AIError;
        emptyAnyOfIsFirebaseError = err instanceof FirebaseError;
        if (err && typeof err === 'object') {
          const record = err as { code?: unknown };
          if (typeof record.code === 'string') {
            emptyAnyOfCode = record.code;
          }
        }
      }

      const objectWithOptionalJson = serializeSchema(objectWithOptional);
      const objectEmptyOptionalJson = serializeSchema(objectEmptyOptional);
      const objectOrderedJson = serializeSchema(objectOrdered);

      return {
        fetchCalls,
        schemaTypes: {
          STRING: SchemaType.STRING,
          NUMBER: SchemaType.NUMBER,
          INTEGER: SchemaType.INTEGER,
          BOOLEAN: SchemaType.BOOLEAN,
          ARRAY: SchemaType.ARRAY,
          OBJECT: SchemaType.OBJECT,
        },
        primitives: {
          stringInstance: strSchema instanceof StringSchema,
          stringJson: serializeSchema(strSchema),
          nullableStringJson: serializeSchema(nullableStrSchema),
          integerInstance: intSchema instanceof IntegerSchema,
          integerJson: serializeSchema(intSchema),
          numberInstance: numSchema instanceof NumberSchema,
          numberJson: serializeSchema(numSchema),
          booleanInstance: boolSchema instanceof BooleanSchema,
          booleanJson: serializeSchema(boolSchema),
          enumStringJson: serializeSchema(enumSchema),
          arrayInstance: arrSchema instanceof ArraySchema,
          arrayJson: serializeSchema(arrSchema),
        },
        objectSchemas: {
          isObjectSchema: objectWithOptional instanceof ObjectSchema,
          withOptionalJson: objectWithOptionalJson,
          withOptionalPropertyKeysSorted: Object.keys(
            objectWithOptionalJson.properties as Record<string, unknown>,
          ).sort(),
          emptyOptionalJson: objectEmptyOptionalJson,
          orderedJson: objectOrderedJson,
        },
        anyOfSchemas: {
          isAnyOfSchema: anyOfSchema instanceof AnyOfSchema,
          hasTopLevelType: 'type' in anyOfJson,
          anyOfJson,
          emptyAnyOfGuard: {
            threw: emptyAnyOfThrew,
            isAIError: emptyAnyOfIsAIError,
            isFirebaseError: emptyAnyOfIsFirebaseError,
            code: emptyAnyOfCode,
          },
        },
      };
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
};
