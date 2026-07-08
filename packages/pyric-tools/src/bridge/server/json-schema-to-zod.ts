/**
 * Tiny JSON-Schema → Zod shape converter. Handles only the shapes
 * pyric's tool factories actually produce (string, number, boolean,
 * object, array, enum, plus untyped catch-all). Anything outside this
 * grammar becomes `z.any()` — better to under-validate than refuse to
 * register a tool.
 *
 * The MCP SDK's `server.tool()` / `server.registerTool()` insist on
 * Zod schemas for input validation. Pyric's tool definitions are
 * plain JSON Schema (matching the inline shape in
 * `packages/pyric/src/rules/tools.ts`), so the bridge converts
 * just-in-time when registering each tool with the MCP server.
 */

import { z, type ZodRawShape, type ZodTypeAny } from 'zod';

type JsonSchemaObject = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchemaObject;
  [k: string]: unknown;
};

/**
 * Convert a JSON-Schema-of-an-object into a Zod raw shape suitable
 * for passing to `server.tool(name, description, shape, handler)`.
 *
 * Behaviour:
 *  - Empty / no `properties` returns `{}` (valid for parameterless tools).
 *  - Each property becomes a Zod schema chosen from its `type`.
 *  - Properties NOT in `required` are made `.optional()`.
 *  - Description metadata is attached via `.describe()` for MCP surfacing.
 */
export function jsonSchemaToZodShape(schema: JsonSchemaObject): ZodRawShape {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape: ZodRawShape = {};
  for (const [key, value] of Object.entries(properties)) {
    let zodSchema = jsonSchemaToZod(value);
    if (value.description) {
      zodSchema = zodSchema.describe(value.description);
    }
    if (!required.has(key)) {
      zodSchema = zodSchema.optional();
    }
    shape[key] = zodSchema;
  }
  return shape;
}

function jsonSchemaToZod(schema: JsonSchemaObject): ZodTypeAny {
  // Enum (irrespective of type)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((v): v is string => typeof v === 'string');
    if (values.length === schema.enum.length && values.length > 0) {
      return z.enum(values as [string, ...string[]]);
    }
    return z.union(schema.enum.map((v) => z.literal(v as never)) as never);
  }

  // oneOf / anyOf — a union of sub-schemas (e.g. `as: 'admin' | { uid, … }`).
  // Without this, a schema with no top-level `type` falls through to z.any(),
  // silently dropping the contract the agent is supposed to see.
  const variants = (schema.oneOf ?? schema.anyOf) as JsonSchemaObject[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    const members = variants.map((v) => jsonSchemaToZod(v));
    return members.length === 1
      ? members[0]
      : z.union(members as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = schema.items
        ? jsonSchemaToZod(schema.items)
        : z.any();
      return z.array(items);
    }
    case 'object': {
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        // Open object — pyric tools commonly use `additionalProperties: true`
        // here to mean "free-form payload" (e.g. `data` for a Firestore doc).
        return z.record(z.any());
      }
      const inner = jsonSchemaToZodShape(schema);
      return z.object(inner);
    }
    default:
      // Untyped (e.g. the `auth` field that pyric tools accept as
      // `null | { uid, token? }` without a `type` declaration) —
      // accept anything.
      return z.any();
  }
}
