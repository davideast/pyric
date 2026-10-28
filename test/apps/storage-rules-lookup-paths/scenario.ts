// Two Storage rules shapes production denies (#1330). The app's rules guard
// avatar uploads with a Firestore lookup keyed by the upload's own metadata:
// `firestore.get(.../users/$(request.resource.metadata.uid)).data.admin`.
// Production keeps an interpolated string as one path segment, so a uid of
// `alice/private/x` names no document and the upload is refused, even with
// `users/alice/private/x` seeded as an admin. A second ruleset declares no
// `rules_version`, so production reads it as version 1, where `{x=**}` needs
// at least one segment: an upload to `uploads` itself is refused, and one to
// `uploads/a.png` is allowed.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function upload(path: string, customMetadata?: Record<string, string>): Promise<string>;

export default scenario(async (app) => {
  // Each refused upload answers 403 from the host's Storage route.
  app.expectHostError(/^403 POST \/__pyric\/storage\//);
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const sandbox = { PYRIC_SANDBOX: `remote:${host.url}` };

  await app.step('a server script seeds users/alice and users/alice/private/x as admins', async () => {
    const result = await app.serverScript('seed.mjs', ['users/alice', 'users/alice/private/x'], { env: sandbox });
    assert.match(result.output, /seeded/);
  });

  const page = await app.step('open the page', async () => {
    const opened = await app.page(host.url);
    await opened.waitForFunction(() => 'upload' in window);
    return opened;
  });

  await app.step('an upload whose uid holds slashes is refused, not read as the deeper document', async () => {
    assert.equal(
      await page.evaluate(() => upload('avatars/a.png', { uid: 'alice/private/x' })),
      'storage/unauthorized',
    );
  });

  await app.step('an upload whose uid names a seeded admin succeeds', async () => {
    assert.equal(await page.evaluate(() => upload('avatars/b.png', { uid: 'alice' })), 'ok');
  });

  await app.step('pyric rules set installs rules with no rules_version', async () => {
    const result = await app.pyric(
      ['rules', 'set', '--service', 'storage', '--rules-file', 'storage-v1.rules'],
      { env: sandbox },
    );
    assert.equal(result.code, 0, result.output);
  });

  await app.step('under version 1, an upload to uploads itself is refused', async () => {
    assert.equal(await page.evaluate(() => upload('uploads')), 'storage/unauthorized');
  });

  await app.step('under version 1, an upload to uploads/a.png succeeds', async () => {
    assert.equal(await page.evaluate(() => upload('uploads/a.png')), 'ok');
  });
});
