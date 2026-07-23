import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { getInternalEnv } from '../../../src/sandbox/internal/index.js';
import { createFirestoreSimulatorTools } from '../../../src/rules/internal/index.js';

describe('browser-safe rules internals', () => {
  it('exposes the simulator tools without the disk-backed resolver entry', () => {
    const sandbox = initializeSandbox();
    const tools = createFirestoreSimulatorTools({
      resolveSandbox: () => getInternalEnv(sandbox),
    });

    expect(tools.map((tool) => tool.name)).toContain('firestore_simulator_create');
  });
});
