/**
 * The check a Firestore rules case passes before either engine runs it.
 *
 * A case is one request. The simulator (`simulate()`, the MCP
 * `firestore_simulate_rules` tool) and the production Rules Test API
 * (`firestore_test_rules`, `TestFirestoreRulesHandler`) take the same case, so a
 * case either engine would read as a different request is refused here, with a
 * reason naming the field, instead of answering a different question
 * (FS2-CON-2, FS2-CON-3, FS2-CON-12).
 */
import type { ZodIssue } from 'zod';
import { TestCaseSchema } from './spec.js';
import { createResourceRefusal, ISO_INSTANT_FORM } from './case-refusals.js';
import { normalizeAuthState } from '../auth/auth-state.js';
import { RulesValue } from '../simulator/wrappers/base.js';
import { FirestoreSet } from '../simulator/firestore-set.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateCasePayloadValue(
  value: unknown,
  field: string,
  ancestors = new WeakSet<object>(),
): string | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  ) {
    return undefined;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return `Case refused: ${field} cannot contain ${typeof value} values.`;
  }
  if (
    value instanceof RulesValue ||
    value instanceof FirestoreSet ||
    value instanceof Date ||
    value instanceof Uint8Array
  ) {
    return undefined;
  }
  const obj = value as object;
  if (ancestors.has(obj)) {
    return `Case refused: ${field} cannot contain circular references.`;
  }
  if (Array.isArray(value)) {
    ancestors.add(obj);
    try {
      for (let i = 0; i < value.length; i++) {
        const err = validateCasePayloadValue(value[i], `${field}[${i}]`, ancestors);
        if (err !== undefined) return err;
      }
      return undefined;
    } finally {
      ancestors.delete(obj);
    }
  }
  if (!isPlainObject(value)) {
    return `Case refused: ${field} must contain plain objects, arrays, primitives, or Rules value wrappers.`;
  }
  ancestors.add(obj);
  try {
    for (const [k, v] of Object.entries(value)) {
      const err = validateCasePayloadValue(v, `${field}.${k}`, ancestors);
      if (err !== undefined) return err;
    }
    return undefined;
  } finally {
    ancestors.delete(obj);
  }
}

function describeIssue(issue: ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    const fields = issue.keys.map((key) => `'${key}'`).join(', ');
    const accepted = Object.keys(TestCaseSchema.shape).join(', ');
    return `unknown field ${fields}; a Firestore rules case takes ${accepted}.`;
  }
  const field = issue.path.join('.');
  if (field === 'requestTime') return `requestTime is not ${ISO_INSTANT_FORM}.`;
  const where = field === '' ? 'the case' : field;
  return `${where}: ${issue.message}.`;
}

/**
 * Why `value` is not a case both engines read as the same request, or
 * `undefined` when it is.
 */
export function caseShapeRefusal(value: unknown): string | undefined {
  let parsed: ReturnType<typeof TestCaseSchema.safeParse>;
  try {
    parsed = TestCaseSchema.safeParse(value);
  } catch (error) {
    return `Case refused: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!parsed.success) {
    return `Case refused: ${parsed.error.issues.map(describeIssue).join(' ')}`;
  }
  const createRefusal = createResourceRefusal(parsed.data);
  if (createRefusal !== undefined) return createRefusal;

  if (parsed.data.auth !== undefined && parsed.data.auth !== null) {
    try {
      normalizeAuthState(parsed.data.auth);
    } catch (error) {
      return `Case refused: auth.token: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (parsed.data.data !== undefined) {
    const err = validateCasePayloadValue(parsed.data.data, 'data');
    if (err !== undefined) return err;
  }
  if (parsed.data.resource !== undefined) {
    const err = validateCasePayloadValue(parsed.data.resource, 'resource');
    if (err !== undefined) return err;
  }
  if (parsed.data.functionMocks !== undefined) {
    for (let i = 0; i < parsed.data.functionMocks.length; i++) {
      const mock = parsed.data.functionMocks[i]!;
      if (typeof mock.result !== 'boolean') {
        const err = validateCasePayloadValue(mock.result, `functionMocks[${i}].result`);
        if (err !== undefined) return err;
      }
    }
  }
  return undefined;
}
