import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { publicRuntimeExports, servedServices } from '../../../../scripts/generate-served-availability.ts';

const entries = new URL('../../../../src/serve/entries/', import.meta.url);

for (const service of servedServices) {
  test(`served firebase/${service} exports every public runtime name from the installed SDK`, async () => {
    const expected = await publicRuntimeExports(`firebase/${service}`);
    const actual = new Set(await publicRuntimeExports(fileURLToPath(new URL(`${service}.ts`, entries))));
    const missing = expected.filter(name => !actual.has(name));
    expect(missing, `Missing served firebase/${service} exports: ${missing.join(', ')}`).toEqual([]);
  });
}
