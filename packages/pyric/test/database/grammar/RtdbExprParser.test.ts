import { describe, test, expect } from 'bun:test';
import { parseExpression } from '../../../src/database/grammar/RtdbExprParser.js';

describe('parseExpression', () => {
  test('parses a simple auth check', () => {
    const result = parseExpression('auth !== null');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('parses chained method calls', () => {
    const result = parseExpression('data.child("count").val() < 5');
    expect(result.valid).toBe(true);
  });

  test('parses root cross-path reference', () => {
    const result = parseExpression('root.child("users").child(auth.uid).exists()');
    expect(result.valid).toBe(true);
  });

  test('parses newData expression', () => {
    const result = parseExpression('newData.exists()');
    expect(result.valid).toBe(true);
  });

  test('returns valid=false for incomplete expression', () => {
    const result = parseExpression('auth !==');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('returns valid=false for empty string', () => {
    const result = parseExpression('');
    expect(result.valid).toBe(false);
  });

  test('extracts referencedIdentifiers', () => {
    const result = parseExpression('auth.uid === $userId');
    expect(result.valid).toBe(true);
    expect(result.referencedIdentifiers).toContain('auth');
    expect(result.referencedIdentifiers).toContain('$userId');
  });

  test('extracts data and auth identifiers', () => {
    const result = parseExpression('auth !== null && data.exists()');
    expect(result.referencedIdentifiers).toContain('auth');
    expect(result.referencedIdentifiers).toContain('data');
  });

  test('parses regex literal', () => {
    const result = parseExpression('newData.val().matches(/^[a-zA-Z]+$/)');
    expect(result.valid).toBe(true);
  });

  test('parses ternary expression', () => {
    const result = parseExpression('auth !== null ? true : false');
    expect(result.valid).toBe(true);
  });

  test('parses boolean literals', () => {
    expect(parseExpression('true').valid).toBe(true);
    expect(parseExpression('false').valid).toBe(true);
  });

  test('parses string literals', () => {
    const result = parseExpression('"hello world"');
    expect(result.valid).toBe(true);
  });

  test('parses logical operators', () => {
    const result = parseExpression('auth !== null && newData.exists()');
    expect(result.valid).toBe(true);
  });

  test('deduplicates referencedIdentifiers', () => {
    const result = parseExpression('auth.uid === auth.uid');
    const authCount = result.referencedIdentifiers.filter(id => id === 'auth').length;
    expect(authCount).toBe(1);
  });
});
