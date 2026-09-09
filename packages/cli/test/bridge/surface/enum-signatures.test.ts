/**
 * The enum-in-signature invariant: for every `args` schema field of a
 * service-tool method that is an enum, at any nesting depth, the method's
 * `signature` line names every value the field can take. An enum a model
 * cannot see before the first call is the failure mode the service-tool
 * design exists to avoid.
 */
import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';

import { TOOLS } from '../../../src/bridge/surface/methods/index.js';

/** Every enum's values reachable from a Zod schema, walking objects, arrays, and wrappers. */
function enumValues(schema: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): string[][] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case 'ZodEnum':
      return [[...(def.values as string[])]];
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      return Object.values(shape).flatMap((field) => enumValues(field, seen));
    }
    case 'ZodArray':
      return enumValues(def.type as z.ZodTypeAny, seen);
    case 'ZodRecord':
      return enumValues(def.valueType as z.ZodTypeAny, seen);
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return enumValues(def.innerType as z.ZodTypeAny, seen);
    default:
      return [];
  }
}

describe('enums appear in the signature line', () => {
  for (const tool of TOOLS) {
    for (const method of tool.methods) {
      const enums = enumValues(method.args);
      if (enums.length === 0) continue;
      it(`${tool.name}.${method.method}'s signature names every enum value`, () => {
        for (const values of enums) {
          for (const value of values) {
            expect(method.signature).toContain(value);
          }
        }
      });
    }
  }
});
