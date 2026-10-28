// Discovery over documents with fields named `constructor`, `toString`,
// `hasOwnProperty` and `valueOf`, at the top level and inside a map. Firestore
// accepts those names. Before the fix the schema merge read each as an
// inherited Object.prototype member and the crawl threw, so
// firestore_discover_paths failed for the whole database (#1436). There is no
// `pyric discover` command; a user reaches discovery through the published
// `@pyric/cli/discover` entry, which the script imports from the installed app.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface DiscoverOutput {
  ok: boolean;
  summary: string;
  topLevel: string[] | null;
  profile: string[] | null;
}

export default scenario(async (app) => {
  const output = await app.step('run firestore_discover_paths from @pyric/cli/discover', async () => {
    const result = await app.command('node', ['discover.mjs']);
    assert.equal(result.code, 0, result.output);
    const line = result.output.trim().split('\n').at(-1) ?? '';
    return JSON.parse(line) as DiscoverOutput;
  });

  await app.step('the crawl succeeds', () => {
    assert.equal(output.ok, true, output.summary);
  });

  await app.step('the schema keeps every field, including the Object.prototype names', () => {
    assert.deepEqual(output.topLevel, ['constructor', 'name', 'profile', 'toString']);
    assert.deepEqual(output.profile, ['hasOwnProperty', 'title', 'valueOf']);
  });
});
