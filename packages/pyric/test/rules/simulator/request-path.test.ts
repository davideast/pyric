import { describe, test, expect } from 'bun:test';
import {
  DOCUMENT_PATH_FORM,
  documentRelativePath,
} from '../../../src/rules/simulator/request-path.js';

describe('documentRelativePath', () => {
  test('leaves a document-relative path alone', () => {
    expect(documentRelativePath('orders/o2')).toBe('orders/o2');
    expect(documentRelativePath('/orders/o2')).toBe('orders/o2');
  });

  test('strips the databases and documents prefix the console shows', () => {
    expect(documentRelativePath('/databases/(default)/documents/orders/o2')).toBe('orders/o2');
    expect(documentRelativePath('databases/(default)/documents/orders/o2')).toBe('orders/o2');
    expect(documentRelativePath('/databases/analytics/documents/orders/o2')).toBe('orders/o2');
  });

  test('strips the prefix from a deeply nested path', () => {
    expect(documentRelativePath('/databases/(default)/documents/rooms/r1/msgs/m1')).toBe(
      'rooms/r1/msgs/m1',
    );
  });

  test('leaves a collection named databases alone', () => {
    expect(documentRelativePath('databases/d1')).toBe('databases/d1');
    expect(documentRelativePath('databases/(default)/orders')).toBe(
      'databases/(default)/orders',
    );
  });

  test('names the form a caller should send', () => {
    expect(DOCUMENT_PATH_FORM).toContain('document-relative');
  });
});
