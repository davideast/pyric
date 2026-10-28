// Each Storage bucket enforces the rules firebase.json deploys to it (#1313,
// ST-H2-2). This project's firebase.json deploys media.rules, which allows
// everything, to media-bucket, and storage.rules, which requires sign-in, to
// the app's default bucket demo-app.appspot.com. Production keeps one release
// per bucket, so an anonymous upload to the default bucket is denied, one to
// media-bucket is allowed, and one to a bucket nothing deploys to is denied,
// as production locks a new bucket.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

const EXPECTED = ['default storage/unauthorized', 'media ok', 'undeployed storage/unauthorized'];

export default scenario(async (app) => {
  await app.step('a PYRIC_SANDBOX=local server script gets each bucket its own rules', async () => {
    const { output } = await app.serverScript('upload.mjs', [], { env: { PYRIC_SANDBOX: 'local' }, timeoutMs: 60_000 });
    for (const line of EXPECTED) assert.match(output, new RegExp(`^${line}$`, 'm'), output);
  });
});
