// Two Storage rules load paths that disagreed with the rest of pyric (#1331).
// firebase.json deploys rules/storage.rules, which allows writes under open/
// and nothing else, and a permissive storage.rules sits in the project root
// as a decoy firebase.json does not name.
//
// With no dev server running, `pyric mcp` hosts an in-process sandbox. Before
// the fix it loaded the root storage.rules, so an anonymous upload to
// uploads/a.txt went through. It must enforce rules/storage.rules, as the dev
// server does.
//
// The dev server then reloads rules/storage.rules rewritten with an `import`
// under rules_version = '2'. The parser accepts that, but the sandbox's
// install gate refuses it. Before the fix the dev server logged "storage rules
// reloaded" while the page kept the previous rules. It must say the reload
// was refused, and the page must keep enforcing the previous rules.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function upload(path: string): Promise<string>;

const IMPORT_UNDER_V2 = `rules_version = '2';
import { anyone } from './helpers';
service firebase.storage {
  match /b/{bucket}/o {
    match /{all=**} {
      allow read, write: if true;
    }
  }
}
`;

export default scenario(async (app) => {
  await app.step('pyric mcp with no dev server refuses an anonymous upload outside open/', async () => {
    const { output } = await app.command('node', ['mcp-upload.mjs', 'uploads/a.txt'], { timeoutMs: 90_000 });
    assert.match(output, /^uploads\/a\.txt denied: storage\/unauthorized/m, output);
  });

  await app.step('pyric mcp with no dev server allows an anonymous upload under open/', async () => {
    const { output } = await app.command('node', ['mcp-upload.mjs', 'open/a.txt'], { timeoutMs: 90_000 });
    assert.match(output, /^open\/a\.txt allowed$/m, output);
  });

  const host = await app.step('start the dev server', () => app.devServer());

  const page = await app.step('open the page', async () => {
    const opened = await app.page(host.url);
    await opened.waitForFunction(() => 'upload' in window, undefined, { timeout: 30_000 });
    return opened;
  });

  await app.step('the page enforces rules/storage.rules', async () => {
    assert.equal(await page.evaluate(() => upload('open/a.txt')), 'ok');
    assert.equal(await page.evaluate(() => upload('locked/x.txt')), 'storage/unauthorized');
  });

  await app.step('the dev server refuses a reload with an import under version 2', async () => {
    const since = host.process.mark();
    app.writeFile('rules/storage.rules', IMPORT_UNDER_V2);
    await host.process.waitForLog(/storage rules NOT reloaded \(last-good stays live\): .*Import statements require rules_version = '2\+modules'/, {
      since,
      timeoutMs: 15_000,
    });
    assert.doesNotMatch(host.process.output.slice(since), /storage rules reloaded/);
  });

  await app.step('the page keeps enforcing the previous rules', async () => {
    assert.equal(await page.evaluate(() => upload('open/b.txt')), 'ok');
    assert.equal(await page.evaluate(() => upload('locked/y.txt')), 'storage/unauthorized');
  });
});
