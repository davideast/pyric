import { describe, expect, test } from 'bun:test';
import { firestoreDocumentName } from '../../src/storage-stdlib-real-api.ts';

describe('storage stdlib real API support', () => {
  test('Firestore targets preserve project and database identity', () => {
    expect(firestoreDocumentName('p', '(default)', 'r1', 'a'))
      .toBe('projects/p/databases/(default)/documents/__pyric_storage_stdlib/r1/docs/a');
    expect(firestoreDocumentName('p', 'probes', 'r1', 'a'))
      .toBe('projects/p/databases/probes/documents/__pyric_storage_stdlib/r1/docs/a');
  });
});
