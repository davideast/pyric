import { FirebaseError } from 'pyric/app';

export function isMessageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireShape(valid: boolean, field: string): asserts valid {
  const isInvalid = !valid;
  if (isInvalid) throw new FirebaseError('invalid-argument', `Invalid sandbox operation field: ${field}.`);
}

export function requireRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  const isRecord = isMessageRecord(value);
  requireShape(isRecord, field);
}

export function requireString(value: unknown, field: string): void {
  const isString = typeof value === 'string';
  requireShape(isString, field);
}

export function requireOptionalString(value: unknown, field: string): void {
  const hasValidShape = value === undefined || typeof value === 'string';
  requireShape(hasValidShape, field);
}

export function requireOptionalBoolean(value: unknown, field: string): void {
  const hasValidShape = value === undefined || typeof value === 'boolean';
  requireShape(hasValidShape, field);
}

export function requireOptionalRecord(value: unknown, field: string): void {
  const hasValidShape = value === undefined || isMessageRecord(value);
  requireShape(hasValidShape, field);
}

export function requireNumber(value: unknown, field: string): void {
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  requireShape(isNumber, field);
}

export function requireOptionalNumber(value: unknown, field: string): void {
  const hasValidShape = value === undefined || (typeof value === 'number' && Number.isFinite(value));
  requireShape(hasValidShape, field);
}
