import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const cli = join(root, 'packages/cli');

for (const directory of [join('src', 'serve', 'live'), join('src', 'serve', 'entries', 'live'), join('test', 'e2e', 'live')]) {
  test(`the parked directory ${directory} is absent from the release branch`, () => {
    expect(existsSync(join(cli, directory))).toBe(false);
  });
}

test('serve and Vite no longer expose the live option', () => {
  for (const file of ['src/cli/serve.ts', 'src/serve/vite-plugin.ts', 'src/serve/vite-module-swap.ts', 'src/serve/bundler.ts']) {
    expect(readFileSync(join(cli, file), 'utf8')).not.toMatch(/\blive\?:/);
  }
  expect(readFileSync(join(cli, 'src/cli/parse-args.ts'), 'utf8')).not.toContain("'live'");
});

test('packaging no longer requires parked adapters', () => {
  const entryDirectory = ['entries', 'live'].join('/');
  const contract = readFileSync(join(root, 'scripts/fixtures/cli-release-contract.json'), 'utf8');
  const smoke = readFileSync(join(root, 'scripts/packed-resolution-smoke.mjs'), 'utf8');
  expect(contract).not.toContain(entryDirectory);
  expect(smoke).not.toContain(entryDirectory);
  expect(smoke).not.toContain('live: true');
});

test('combined live-mode evidence remains on the parking branch only', () => {
  const parkedDocuments = readdirSync(join(root, 'docs')).filter(name => name.startsWith('hosted-sandbox-live-mode-'));
  expect(parkedDocuments).toEqual([]);
});
