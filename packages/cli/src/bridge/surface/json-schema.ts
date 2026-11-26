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

function definitionOf(schema: z.ZodTypeAny): { type: string } & Record<string, unknown> {
  return schema._zod.def as unknown as { type: string } & Record<string, unknown>;
}

function described(schema: z.ZodTypeAny, converted: JsonSchema): JsonSchema {
  if (schema.description === undefined) return converted;
  return { ...converted, description: schema.description };
}

function hasCustomCheck(def: Record<string, unknown>): boolean {
  const checks = def.checks;
  if (!Array.isArray(checks)) return false;
  return checks.some((entry) => {
    const checkDef = (entry as { _zod?: { def?: { check?: string } } })._zod?.def;
    return checkDef?.check === 'custom';
  });
}

/** Convert one Zod schema to JSON Schema. Throws on a construct outside the authored subset. */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = definitionOf(schema);
  if (hasCustomCheck(def)) {
    throw new Error("unsupported parameter construct 'custom'");
  }
  switch (def.type) {
    case 'string':
      return described(schema, { type: 'string' });
    case 'number':
      return described(schema, { type: 'number' });
    case 'boolean':
      return described(schema, { type: 'boolean' });
    case 'literal': {
      const values = def.values as readonly unknown[];
      if (values.length === 1) return described(schema, { const: values[0] });
      return described(schema, { enum: [...values] });
    }
    case 'enum': {
      const entries = def.entries as Record<string, string | number>;
      return described(schema, {
        type: 'string',
        enum: Array.from(new Set(Object.values(entries))),
      });
    }
    case 'array':
      return described(schema, {
        type: 'array',
        items: toJsonSchema(def.element as z.ZodTypeAny),
      });
    case 'record':
      return described(schema, {
        type: 'object',
        additionalProperties: toJsonSchema(def.valueType as z.ZodTypeAny),
      });
    case 'object':
      return described(schema, objectSchema(schema as z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig>));
    case 'union':
      return described(schema, {
        anyOf: (def.options as z.ZodTypeAny[]).map(toJsonSchema),
      });
    case 'null':
      return described(schema, { type: 'null' });
    case 'unknown':
    case 'any':
      return described(schema, {});
    case 'optional':
    case 'nullable':
    case 'default':
      return described(schema, toJsonSchema(def.innerType as z.ZodTypeAny));
    default:
      throw new Error(`unsupported parameter construct '${def.type}'`);
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const type = definitionOf(schema).type;
  return type === 'optional' || type === 'default';
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig>): JsonSchema {
  const shape = schema.shape;
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const field = value as z.ZodTypeAny;
    properties[key] = toJsonSchema(field);
    if (!isOptional(field)) required.push(key);
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
