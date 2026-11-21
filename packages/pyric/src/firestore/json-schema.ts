import { FirebaseError } from '../sandbox/internal/firebase-error.js';

interface JsonFieldSchema {
  readonly typeString: 'string' | 'number' | 'boolean' | 'object';
  readonly expectedValue?: string;
}

export type JsonObjectSchema = Readonly<Record<string, JsonFieldSchema>>;

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates a serialized Firestore value JSON object against the SDK's schema
 * (`@firebase/firestore` `validateJSON`), throwing `FirebaseError` with code
 * `'invalid-argument'` on any mismatch.
 */
export function validateFirestoreJson(
  json: unknown,
  schema: JsonObjectSchema,
): Record<string, unknown> {
  if (!isPlainJsonRecord(json)) {
    throw new FirebaseError('invalid-argument', 'JSON must be an object');
  }
  for (const key of Object.keys(schema)) {
    const fieldSpec = schema[key];
    if (fieldSpec === undefined) continue;
    if (!(key in json)) {
      throw new FirebaseError('invalid-argument', `JSON missing required field: '${key}'`);
    }
    const fieldValue = json[key];
    if (typeof fieldValue !== fieldSpec.typeString) {
      throw new FirebaseError(
        'invalid-argument',
        `JSON field '${key}' must be a ${fieldSpec.typeString}.`,
      );
    }
    if (fieldSpec.expectedValue !== undefined && fieldValue !== fieldSpec.expectedValue) {
      throw new FirebaseError(
        'invalid-argument',
        `Expected '${key}' field to equal '${fieldSpec.expectedValue}'`,
      );
    }
  }
  return json;
}
