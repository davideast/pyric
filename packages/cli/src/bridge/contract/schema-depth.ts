import { z } from 'zod';

/**
 * Unwraps ZodOptional, ZodNullable, ZodDefault, and ZodEffects to inspect the inner schema type.
 */
function unwrapZodType(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  isOptional: boolean;
} {
  let current = schema;
  let isOptional = false;

  while (current) {
    if (current instanceof z.ZodOptional) {
      isOptional = true;
      current = current._def.innerType;
    } else if (current instanceof z.ZodNullable) {
      isOptional = true;
      current = current._def.innerType;
    } else if (current instanceof z.ZodDefault) {
      isOptional = true;
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = current._def.schema;
    } else {
      break;
    }
  }

  return { inner: current, isOptional };
}

/**
 * Runtime and compile-time validator enforcing flat parameter schemas:
 * - Root object is Level 0
 * - Top-level properties are Level 1
 * - Nested object/array item fields are Level 2
 * - Level 3 objects are prohibited (throws SchemaDepthExceeded error)
 * - Open-ended `z.record(...)` is prohibited
 */
export function assertFlatSchema(
  schema: z.ZodTypeAny,
  maxDepth = 2,
  currentDepth = 0,
  path = 'root'
): void {
  const { inner } = unwrapZodType(schema);

  if (inner instanceof z.ZodRecord) {
    throw new Error(
      `Schema validation failed at "${path}": open-ended z.record(...) is prohibited; all tool schemas must use explicit properties and closed enums.`
    );
  }

  if (inner instanceof z.ZodObject) {
    if (currentDepth > maxDepth) {
      throw new Error(
        `Schema validation failed at "${path}": maximum nesting depth ${maxDepth} exceeded (found object at level ${currentDepth}).`
      );
    }
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    for (const [key, propSchema] of Object.entries(shape)) {
      const nextDepth = currentDepth + 1;
      const { inner: innerProp } = unwrapZodType(propSchema);
      if (innerProp instanceof z.ZodObject && nextDepth >= maxDepth) {
        // An object at depth 2 has fields at depth 3 -> disallowed!
        const subShape = innerProp.shape as Record<string, z.ZodTypeAny>;
        for (const [subKey] of Object.entries(subShape)) {
          throw new Error(
            `Schema validation failed at "${path}.${key}.${subKey}": maximum nesting depth ${maxDepth} exceeded (field at level ${nextDepth + 1}).`
          );
        }
      }
      assertFlatSchema(propSchema, maxDepth, nextDepth, `${path}.${key}`);
    }
    return;
  }

  if (inner instanceof z.ZodArray) {
    const elementSchema = inner._def.type as z.ZodTypeAny;
    const { inner: innerElem } = unwrapZodType(elementSchema);
    if (innerElem instanceof z.ZodObject) {
      if (currentDepth >= maxDepth) {
        throw new Error(
          `Schema validation failed at "${path}[]": maximum nesting depth ${maxDepth} exceeded (array of objects at level ${currentDepth}).`
        );
      }
      const shape = innerElem.shape as Record<string, z.ZodTypeAny>;
      for (const [key, propSchema] of Object.entries(shape)) {
        const nextDepth = currentDepth + 1;
        const { inner: innerProp } = unwrapZodType(propSchema);
        if (innerProp instanceof z.ZodObject && nextDepth >= maxDepth) {
          throw new Error(
            `Schema validation failed at "${path}[].${key}": maximum nesting depth ${maxDepth} exceeded (nested object inside array item).`
          );
        }
        assertFlatSchema(propSchema, maxDepth, nextDepth, `${path}[].${key}`);
      }
    } else {
      assertFlatSchema(elementSchema, maxDepth, currentDepth, `${path}[]`);
    }
    return;
  }
}

/**
 * Converts a flat Zod schema (depth <= 2) into a JSON Schema object for MCP tool metadata.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { inner } = unwrapZodType(schema);
  const description = schema.description ?? inner.description;

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    for (const [key, propSchema] of Object.entries(shape)) {
      const { isOptional } = unwrapZodType(propSchema);
      properties[key] = zodToJsonSchema(propSchema);
      if (!isOptional) {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = {
      type: 'object',
      properties,
      additionalProperties: false,
    };
    if (required.length > 0) {
      result.required = required;
    }
    if (description) {
      result.description = description;
    }
    return result;
  }

  if (inner instanceof z.ZodArray) {
    const result: Record<string, unknown> = {
      type: 'array',
      items: zodToJsonSchema(inner._def.type),
    };
    if (description) {
      result.description = description;
    }
    return result;
  }

  if (inner instanceof z.ZodEnum) {
    const result: Record<string, unknown> = {
      type: 'string',
      enum: inner._def.values,
    };
    if (description) {
      result.description = description;
    }
    return result;
  }

  if (inner instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: 'string' };
    if (description) {
      result.description = description;
    }
    return result;
  }

  if (inner instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: 'number' };
    if (description) {
      result.description = description;
    }
    return result;
  }

  if (inner instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: 'boolean' };
    if (description) {
      result.description = description;
    }
    return result;
  }

  return { type: 'string' };
}
