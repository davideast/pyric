import { z } from 'zod';
import type { Expr } from './types.js';
import { all, any, expr, fieldName as assertFieldName, lit } from './compose.js';
import { hasChild, hasChildren } from './atoms.js';
import { isSupportedRegexFlags } from '../grammar/type-rules.js';

export interface SchemaFieldRule {
  validate: Expr;
  children?: Record<string, SchemaFieldRule>;
}

export interface SchemaRulesResult {
  validate: Expr;
  children: Record<string, SchemaFieldRule>;
}

const EMAIL_PATTERN = '/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/';

/**
 * Generate RTDB validate rules from a Zod object schema.
 * Optional fieldConstraints are AND-composed with the schema type check.
 */
export function schemaRules(
  schema: z.ZodObject<any>,
  fieldConstraints?: Record<string, Expr[]>,
): SchemaRulesResult {
  if (!(schema instanceof z.ZodObject)) {
    const actualName = (schema as unknown as { constructor?: { name?: string } })?.constructor?.name ?? typeof schema;
    throw new Error(
      `Unsupported Zod schema for RTDB rules: expected ZodObject, got ${actualName}`,
    );
  }
  const def = schema._def;
  if (def.catchall && !(def.catchall instanceof z.ZodNever)) {
    throw new Error('Unsupported Zod object catchall for RTDB rules');
  }

  const shape = schema.shape;
  if (fieldConstraints) {
    for (const key of Object.keys(fieldConstraints)) {
      if (!(key in shape)) {
        throw new Error(`fieldConstraints: field "${key}" is not in schema.`);
      }
    }
  }

  const requiredFields: string[] = [];
  const children: SchemaRulesResult['children'] = {};

  for (const [key, rawType] of Object.entries(shape)) {
    assertFieldName('schemaRules', key);
    const zodType = rawType as z.ZodTypeAny;
    const isOptional = zodType instanceof z.ZodOptional;
    const innerType = isOptional ? (zodType as z.ZodOptional<any>).unwrap() : zodType;

    if (!isOptional) requiredFields.push(key);

    const constraints = fieldConstraints?.[key];

    if (innerType instanceof z.ZodObject) {
      const nested = schemaRules(innerType);
      const validateExpr =
        constraints && constraints.length > 0
          ? all(nested.validate, ...constraints)
          : nested.validate;
      children[key] = {
        validate: validateExpr,
        children: nested.children,
      };
    } else {
      const typeExpr = zodTypeToExpr(innerType, key);
      if (constraints && constraints.length > 0) {
        children[key] = { validate: all(typeExpr, ...constraints) };
      } else {
        children[key] = { validate: typeExpr };
      }
    }
  }

  if (def?.unknownKeys === 'strict') {
    children.$other = { validate: expr('false') };
  }

  // Parent validate: hasChildren + required fields
  const parentParts: Expr[] = [hasChildren()];
  for (const f of requiredFields) {
    parentParts.push(hasChild(f));
  }
  const validate = all(...parentParts);

  return { validate, children };
}

function zodStringToExpr(zodType: z.ZodString, fieldName: string): Expr {
  const parts: Expr[] = [expr('newData.isString()')];
  for (const check of zodType._def.checks) {
    if (check.kind === 'min') {
      parts.push(expr(`newData.val().length >= ${lit(check.value)}`));
    } else if (check.kind === 'max') {
      parts.push(expr(`newData.val().length <= ${lit(check.value)}`));
    } else if (check.kind === 'length') {
      parts.push(expr(`newData.val().length == ${lit(check.value)}`));
    } else if (check.kind === 'regex') {
      const re = check.regex;
      if (!isSupportedRegexFlags(re.flags)) {
        throw new Error(
          `Unsupported Zod regex flags "${re.flags}" on field "${fieldName}"; RTDB rules only support the "i" flag`,
        );
      }
      if (/[\r\n]/.test(re.source)) {
        throw new Error(`Unsupported Zod regex with newline on field "${fieldName}"`);
      }
      parts.push(expr(`newData.val().matches(/${re.source}/${re.flags})`));
    } else if (check.kind === 'email') {
      parts.push(expr(`newData.val().matches(${EMAIL_PATTERN})`));
    } else if (check.kind === 'startsWith') {
      parts.push(expr(`newData.val().beginsWith(${lit(check.value)})`));
    } else if (check.kind === 'endsWith') {
      parts.push(expr(`newData.val().endsWith(${lit(check.value)})`));
    } else if (check.kind === 'includes') {
      parts.push(expr(`newData.val().contains(${lit(check.value)})`));
    } else {
      throw new Error(
        `Unsupported Zod string check "${String(check.kind)}" for RTDB rules on field "${fieldName}"`,
      );
    }
  }
  return all(...parts);
}

function zodNumberToExpr(zodType: z.ZodNumber, fieldName: string): Expr {
  const parts: Expr[] = [expr('newData.isNumber()')];
  for (const check of zodType._def.checks) {
    if (check.kind === 'min') {
      const op = check.inclusive === false ? '>' : '>=';
      parts.push(expr(`newData.val() ${op} ${lit(check.value)}`));
    } else if (check.kind === 'max') {
      const op = check.inclusive === false ? '<' : '<=';
      parts.push(expr(`newData.val() ${op} ${lit(check.value)}`));
    } else if (check.kind === 'int') {
      parts.push(expr('newData.val() % 1 == 0'));
    } else if (check.kind === 'multipleOf') {
      parts.push(expr(`newData.val() % ${lit(check.value)} == 0`));
    } else {
      throw new Error(
        `Unsupported Zod number check "${String(check.kind)}" for RTDB rules on field "${fieldName}"`,
      );
    }
  }
  return all(...parts);
}

function zodTypeToExpr(zodType: z.ZodTypeAny, fieldName: string): Expr {
  if (zodType instanceof z.ZodString) {
    return zodStringToExpr(zodType, fieldName);
  }
  if (zodType instanceof z.ZodNumber) {
    return zodNumberToExpr(zodType, fieldName);
  }
  if (zodType instanceof z.ZodBoolean) {
    return expr('newData.isBoolean()');
  }
  if (zodType instanceof z.ZodEnum) {
    const values = (zodType as z.ZodEnum<any>).options as string[];
    return any(...values.map(v => expr(`newData.val() == ${lit(v)}`)));
  }
  if (zodType instanceof z.ZodLiteral) {
    const v = (zodType as z.ZodLiteral<any>).value;
    return expr(`newData.val() == ${lit(v)}`);
  }
  if (zodType instanceof z.ZodUnion) {
    const options = (zodType as z.ZodUnion<any>)._def.options as z.ZodTypeAny[];
    return any(...options.map(opt => zodTypeToExpr(opt, fieldName)));
  }
  if (zodType instanceof z.ZodObject) {
    // Handled separately in the caller — return hasChildren as placeholder
    return expr('newData.hasChildren()');
  }

  throw new Error(`Unsupported Zod type for RTDB rules: ${zodType.constructor.name} on field "${fieldName}"`);
}
