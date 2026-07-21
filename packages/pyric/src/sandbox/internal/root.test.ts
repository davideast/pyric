import { describe, expect, it } from 'bun:test';
import { createSandboxRoot } from './root.js';

describe('sandbox roots', () => {
  it('gives each browser host an isolated instance of the same sandbox implementation', () => {
    const first = createSandboxRoot();
    const second = createSandboxRoot();

    expect(first).not.toBe(second);
    expect(typeof first.history).toBe('function');
    expect(typeof second.history).toBe('function');
  });
});
