/**
 * The enum-in-signature invariant, in two halves.
 *
 * The first half: for every `args` schema field of a service-tool method that
 * is an enum, at any nesting depth, the method's `signature` line names every
 * value the field can take. An enum a model cannot see before the first call is
 * the failure mode the service-tool design exists to avoid.
 *
 * The second half exists because the first passes vacuously for an argument
 * declared `z.string()` whose values are in fact a closed set enforced by hand.
 * That is the same failure with the enum hidden one level deeper: the signature
 * spells nothing, and the model learns the values from a rejection.
 *
 * The rule this file chose for detecting that case, stated so a reader can hold
 * the validator to it: an argument is a closed set when its own rejection tells
 * the caller what the allowed values are. Concretely, each string argument is
 * probed with a value nothing accepts; if the validator rejects that argument
 * and its message enumerates values (a comma-separated run after `one of`,
 * `evaluates`, or `exist for`), and two or more of those values are then
 * accepted at that argument, the argument has a closed set and its schema must
 * carry a `ZodEnum`. An argument whose rejection names no values, such as a
 * path whose segment parity is wrong or a payload that is not base64, states no
 * closed set and is not held to this rule.
 */
import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';

import { validateArguments } from '../../../src/bridge/surface/method-validation.js';
import { TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import type { Args, Method } from '../../../src/bridge/surface/method-types.js';

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

/** A value no argument of any record accepts, used to draw out a rejection. */
const PROBE = '__pyric_probe__';

/** The connectives a rejection uses when it enumerates the values it accepts. */
const ENUMERATION = /(?:one of|evaluates|exist for) ([a-z][a-z0-9_-]*(?:, [a-z][a-z0-9_-]*)+)/g;

/** The values one rejection message names, or none when it names no set. */
function enumeratedValues(summary: string): string[] {
  const found = new Set<string>();
  for (const match of summary.matchAll(ENUMERATION)) {
    for (const value of match[1]!.split(', ')) found.add(value);
  }
  return [...found];
}

/** Whether the validator rejects this argument, by name, for this value. */
function rejectsField(method: Method, name: string, value: string): boolean {
  const args: Args = { ...method.example, [name]: value };
  const rejection = validateArguments(method, args);
  return rejection !== null && rejection.data.field === name;
}

/** The values a rejection named that the argument then accepts. */
function acceptedFromRejection(method: Method, name: string): string[] {
  const args: Args = { ...method.example, [name]: PROBE };
  const rejection = validateArguments(method, args);
  if (rejection === null || rejection.data.field !== name) return [];
  return enumeratedValues(rejection.summary).filter(
    (value) => !rejectsField(method, name, value),
  );
}

/** Whether one field of a method's schema carries an enum. */
function hasEnum(method: Method, name: string): boolean {
  const field = (method.args.shape as Record<string, z.ZodTypeAny>)[name];
  if (field === undefined) return false;
  return enumValues(field).length > 0;
}

/** The names of a method's own string-shaped arguments, enums included. */
function stringArguments(method: Method): string[] {
  const shape = method.args.shape as Record<string, z.ZodTypeAny>;
  return Object.keys(shape).filter((name) => {
    const def = unwrapped(shape[name]!)._def as { typeName: string };
    return def.typeName === 'ZodString' || def.typeName === 'ZodEnum';
  });
}

/** The innermost schema of a wrapper chain, past optional, nullable, and default. */
function unwrapped(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = schema._def as { typeName: string; innerType?: z.ZodTypeAny };
  if (def.innerType === undefined) return schema;
  if (['ZodOptional', 'ZodNullable', 'ZodDefault'].includes(def.typeName)) {
    return unwrapped(def.innerType);
  }
  return schema;
}

describe('an argument with a closed set declares it as an enum', () => {
  for (const tool of TOOLS) {
    for (const method of tool.methods) {
      for (const name of stringArguments(method)) {
        it(`${tool.name}.${method.method}'s '${name}' declares any closed set it enforces`, () => {
          const accepted = acceptedFromRejection(method, name);
          if (accepted.length < 2) return;
          expect(hasEnum(method, name)).toBe(true);
          for (const value of accepted) expect(method.signature).toContain(value);
        });
      }
    }
  }
});

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

/** Whether a schema field is optional, past the wrapper chain. */
function isOptional(schema: z.ZodTypeAny): boolean {
  const def = schema._def as { typeName: string; innerType?: z.ZodTypeAny };
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') return true;
  if (def.typeName === 'ZodNullable' && def.innerType !== undefined) {
    return isOptional(def.innerType);
  }
  return false;
}

/**
 * Whether a signature marks one argument optional, or null when the signature
 * does not name the argument at all.
 */
function markedOptional(signature: string, name: string): boolean | null {
  const token = new RegExp(`(?:^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`);
  const found = signature.match(token);
  if (found === null) return null;
  return found[1] === '?';
}

/**
 * `confirm` on a destructive or a production method is required by the effect
 * enforcement rather than by the schema, which declares it optional so a call
 * that omits it is refused by the enforcement's own message.
 */
function isEnforcedConfirm(method: Method, name: string): boolean {
  if (name !== 'confirm') return false;
  return method.effect === 'destructive' || method.effect === 'production';
}

describe('the signature line states which arguments are optional', () => {
  for (const tool of TOOLS) {
    for (const method of tool.methods) {
      const shape = method.args.shape as Record<string, z.ZodTypeAny>;
      for (const name of Object.keys(shape)) {
        it(`${tool.name}.${method.method} marks '${name}' the way its schema declares it`, () => {
          const marked = markedOptional(method.signature, name);
          expect(marked).not.toBeNull();
          const required = isEnforcedConfirm(method, name) || !isOptional(shape[name]!);
          expect(marked).toBe(!required);
        });
      }
    }
  }
});
