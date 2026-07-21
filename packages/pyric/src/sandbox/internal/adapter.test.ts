import { describe, expect, it } from 'bun:test';
import { createSandboxAdapter } from './adapter.js';

describe('sandbox adapters', () => {
  it('give SharedWorker and embedded hosts the same isolated sandbox implementation', () => {
    const worker = createSandboxAdapter('shared-worker');
    const embedded = createSandboxAdapter('embedded');
    const first = worker.create();
    const second = embedded.create();

    expect(worker.kind).toBe('shared-worker');
    expect(embedded.kind).toBe('embedded');
    expect(first).not.toBe(second);
    expect(typeof first.history).toBe('function');
    expect(typeof second.history).toBe('function');
  });
});
