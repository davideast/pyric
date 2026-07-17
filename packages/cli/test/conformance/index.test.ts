import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('public conformance barrel', () => {
  it('contains re-exports only', () => {
    const source = readFileSync(new URL('../../src/conformance/index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('export function');
    expect(source).not.toContain('function ');
    expect(source).not.toContain('CONFORMANCE_SUPPORTS');
    expect(source).not.toContain('CONFORMANCE_IMPORT_EVIDENCE');
    expect(source).not.toContain('resolveCanIUse');
    expect(source).not.toContain('createConformanceTools');
  });
});
