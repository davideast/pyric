/** Validation results for the harness's file shapes: the value, or one line per problem naming its field. */
import type { ZodError, ZodType, ZodTypeDef } from 'zod';

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function schemaErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '(top level)' : issue.path.join('.');
    return `${path}: ${issue.message}`;
  });
}

export function parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): Parsed<T> {
  const result = schema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: schemaErrors(result.error) };
}

/** JSON text, parsed, or the parse error as a problem line. */
export function parseJsonText(text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, errors: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
