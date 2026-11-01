/**
 * A `list` case on a collection path is evaluated against the document-level
 * blocks, through a hypothetical document one segment deeper. A
 * document-style path already names a document of the queried collection, so
 * it is never widened: one segment deeper reaches only blocks no document of
 * that collection matches (#1428).
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const DEEPER_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /cities/{city}/{sub} { allow list: if true; }
  }
}`;

const DOCUMENT_BLOCK = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /cities/{city} { allow list: if true; }
  }
}`;

function list(source: string, path: string) {
  const tc: TestCase = { description: path, expectation: 'DENY', method: 'list', path };
  const result = new SimulateFirestoreRulesHandler().simulate(source, [tc]);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!.decision;
}

describe('list widening (#1428)', () => {
  test('a document-style path that matches nothing is not widened into a deeper block', () => {
    expect(list(DEEPER_ONLY, 'cities/__listPlaceholder__')).toBe('DENY');
    expect(list(DEEPER_ONLY, 'cities/SF')).toBe('DENY');
  });

  test('a collection path still widens to the document block', () => {
    expect(list(DOCUMENT_BLOCK, 'cities')).toBe('ALLOW');
  });

  test('a document-style path still resolves the document block directly', () => {
    expect(list(DOCUMENT_BLOCK, 'cities/__listPlaceholder__')).toBe('ALLOW');
  });
});
