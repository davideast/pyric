/**
 * Zod to JSON Schema for the operation parameter subset.
 *
 * The operation records author real nested objects, never JSON-encoded
 * strings, and never nest more than two object levels below the root. That
 * subset is small enough to convert here without a dependency, and small
 * enough that an unsupported construct is an authoring mistake worth throwing
 * on rather than degrading to `{}`.
 */
import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

function definitionOf(schema: z.ZodTypeAny): { typeName: string } & Record<string, unknown> {
  return schema._def as { typeName: string } & Record<string, unknown>;
}

function described(schema: z.ZodTypeAny, converted: JsonSchema): JsonSchema {
  if (schema.description === undefined) return converted;
  return { ...converted, description: schema.description };
}

/** Convert one Zod schema to JSON Schema. Throws on a construct outside the authored subset. */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = definitionOf(schema);
  switch (def.typeName) {
    case 'ZodString':
      return described(schema, { type: 'string' });
    case 'ZodNumber':
      return described(schema, { type: 'number' });
    case 'ZodBoolean':
      return described(schema, { type: 'boolean' });
    case 'ZodLiteral':
      return described(schema, { const: def.value });
    case 'ZodEnum':
      return described(schema, { type: 'string', enum: [...(def.values as string[])] });
    case 'ZodArray':
      return described(schema, {
        type: 'array',
        items: toJsonSchema(def.type as z.ZodTypeAny),
      });
    case 'ZodRecord':
      return described(schema, {
        type: 'object',
        additionalProperties: toJsonSchema(def.valueType as z.ZodTypeAny),
      });
    case 'ZodObject':
      return described(schema, objectSchema(schema as z.ZodObject<z.ZodRawShape>));
    case 'ZodUnion':
      return described(schema, {
        anyOf: (def.options as z.ZodTypeAny[]).map(toJsonSchema),
      });
    case 'ZodNull':
      return described(schema, { type: 'null' });
    case 'ZodUnknown':
    case 'ZodAny':
      return described(schema, {});
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return described(schema, toJsonSchema(def.innerType as z.ZodTypeAny));
    default:
      throw new Error(`unsupported parameter construct '${def.typeName}'`);
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = definitionOf(schema).typeName;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const shape = schema.shape;
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = toJsonSchema(value);
    if (!isOptional(value)) required.push(key);
  }
  if (required.length === 0) return { type: 'object', properties };
  return { type: 'object', properties, required };
}

/**
 * How many object levels a JSON Schema nests below its root. A root object of
 * scalars is depth 0; one nested object, or an array of objects, is depth 1.
 */
export function schemaDepth(schema: JsonSchema): number {
  const nested: JsonSchema[] = [];
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (properties) nested.push(...Object.values(properties));
  const items = schema.items as JsonSchema | undefined;
  if (items) nested.push(items);
  const additional = schema.additionalProperties as JsonSchema | undefined;
  if (additional && typeof additional === 'object') nested.push(additional);
  const alternatives = schema.anyOf as JsonSchema[] | undefined;
  if (alternatives) nested.push(...alternatives);

  let deepest = 0;
  for (const child of nested) {
    const childIsObject = child.type === 'object';
    const below = schemaDepth(child);
    deepest = Math.max(deepest, childIsObject ? below + 1 : below);
  }
  return deepest;
}
