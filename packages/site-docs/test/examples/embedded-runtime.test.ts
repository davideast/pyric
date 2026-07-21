import { describe, expect, it } from 'bun:test';
import { createEmbeddedExampleRuntime } from '../../src/examples/embedded-runtime';
import definition from '../../src/examples/firestore-first-write/definition';

describe('embedded example runtime', () => {
  it('runs against a fresh sandbox and resets to another fresh sandbox', async () => {
    const first = createEmbeddedExampleRuntime(definition);

    expect(await first.run()).toEqual({
      title: 'The sandbox is local',
      ownerId: 'ada',
    });
    expect(await first.reset().run()).toEqual({
      title: 'The sandbox is local',
      ownerId: 'ada',
    });
  });
});
