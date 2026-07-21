import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEmbeddedExampleRuntime } from '../src/examples/embedded-runtime';
import { PYRIC_EXAMPLES } from '../src/examples/registry';

describe('Pyric documentation examples', () => {
  it('runs a named example against a fresh embedded sandbox and resets it', async () => {
    const definition = PYRIC_EXAMPLES['firestore-first-write'].definition;
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

  it('shows the exact checked-in source that the example executes', () => {
    const file = join(import.meta.dir, '../src/examples/firestore-first-write/run.ts');
    expect(PYRIC_EXAMPLES['firestore-first-write'].source.trim()).toBe(
      readFileSync(file, 'utf8').trim(),
    );
  });

  it('ties setup to the declared Firestore service instead of promising unsupported services', () => {
    const definition = PYRIC_EXAMPLES['firestore-first-write'].definition;
    expect(definition.service).toBe('firestore');
    expect(definition.firestore.rules).toContain('service cloud.firestore');
  });

  it('keeps example pages finite and iframe-isolated', () => {
    const page = readFileSync(
      join(import.meta.dir, '../src/pages/examples/[example].astro'),
      'utf8',
    );
    const component = readFileSync(
      join(import.meta.dir, '../src/components/PyricExample.astro'),
      'utf8',
    );
    expect(page).toContain('Object.keys(PYRIC_EXAMPLES)');
    expect(component).toContain('sandbox="allow-scripts allow-same-origin"');
  });
});
