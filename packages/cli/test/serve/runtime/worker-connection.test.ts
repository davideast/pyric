import { describe, expect, it } from 'bun:test';
import { connectRuntimeWorker } from '../../../src/serve/runtime/worker-connection.js';

describe('runtime worker connection', () => {
  it('reports a synchronous SharedWorker construction failure and permits fallback', () => {
    const errors: unknown[] = [];

    const db = connectRuntimeWorker(
      () => { throw new DOMException('blocked by policy', 'SecurityError'); },
      (error) => errors.push(error),
    );

    expect(db).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(DOMException);
  });
});
