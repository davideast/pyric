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
  const parsed = TestCaseSchema.safeParse(value);
  if (!parsed.success) {
    return `Case refused: ${parsed.error.issues.map(describeIssue).join(' ')}`;
  }
  return createResourceRefusal(parsed.data);
}
