import { z } from 'zod';
import type { Expr } from './types.js';
import { all, any, expr } from './compose.js';
import { hasChild, hasChildren } from './atoms.js';

export interface SchemaRulesResult {
  validate: Expr;
  children: Record<string, { validate: Expr; children?: Record<string, { validate: Expr }> }>;
}

/**
 * Generate RTDB validate rules from a Zod object schema.
 * Optional fieldConstraints are AND-composed with the schema type check.
 */
export function schemaRules(
  schema: z.ZodObject<any>,
  fieldConstraints?: Record<string, Expr[]>,
): SchemaRulesResult {
  const shape = schema.shape;
  const requiredFields: string[] = [];
  const children: SchemaRulesResult['children'] = {};

  for (const [key, rawType] of Object.entries(shape)) {
    const zodType = rawType as z.ZodTypeAny;
    const isOptional = zodType instanceof z.ZodOptional;
    const innerType = isOptional ? (zodType as z.ZodOptional<any>).unwrap() : zodType;

    if (!isOptional) requiredFields.push(key);

    const typeExpr = zodTypeToExpr(innerType, key);

    // Merge with field constraints if present
    const constraints = fieldConstraints?.[key];
    if (constraints && constraints.length > 0) {
      children[key] = { validate: all(typeExpr, ...constraints) };
    } else {
      children[key] = { validate: typeExpr };
    }

    // Nested objects produce children
    if (innerType instanceof z.ZodObject) {
      const nested = schemaRules(innerType);
      children[key] = {
        validate: nested.validate,
        children: nested.children as any,
      };
    }
  }

  // Parent validate: hasChildren + required fields
  const parentParts: Expr[] = [hasChildren()];
  for (const f of requiredFields) {
    parentParts.push(hasChild(f));
  }
  const validate = all(...parentParts);

  return { validate, children };
}

function zodTypeToExpr(zodType: z.ZodTypeAny, fieldName: string): Expr {
  if (zodType instanceof z.ZodString) {
    return expr('newData.isString()');
  }
  if (zodType instanceof z.ZodNumber) {
    return expr('newData.isNumber()');
  }
  if (zodType instanceof z.ZodBoolean) {
    return expr('newData.isBoolean()');
  }
  if (zodType instanceof z.ZodEnum) {
    const values = (zodType as z.ZodEnum<any>).options as string[];
    return expr(values.map(v => `newData.val() == "${v}"`).join(' || '));
  }
  if (zodType instanceof z.ZodLiteral) {
    const v = (zodType as z.ZodLiteral<any>).value;
    if (typeof v === 'string') return expr(`newData.val() == "${v}"`);
    return expr(`newData.val() == ${v}`);
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
