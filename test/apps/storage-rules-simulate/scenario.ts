// `pyric rules simulate --service storage` builds `request.resource` the way
// the live request would (#1344, ST-H2-5, ST-H2-6, ST-H3-2, ST-H3-3), and
// `pyric rules lint --service storage` runs the shared security lint
// (ST-H3-7).
//
// The project keeps one object, docs/readme.txt, owned by alice through its
// custom metadata. `storage.rules` lets alice re-upload it only when the new
// upload names her as owner. A live re-upload that sends no custom metadata
// is denied, because an upload replaces the object, so simulate has to deny
// it too rather than fill the missing fields from the stored object. A get
// carries no `request.resource`, so a get case that passes data is refused. An
// update builds `request.resource` from the stored object even with no data.
// A misspelled data field is refused by name, and a numeric string size reads
// as its number.
import assert from 'node:assert/strict';
import { scenario, type App } from '../driver.ts';

/** `pyric rules simulate --service storage`, run in process from the app directory. */
function simulate(app: App, extra: string[]) {
  return app.pyric(['rules', 'simulate', '--service', 'storage', ...extra]);
}

export default scenario(async (app) => {
  await app.step('pyric storage uploadBytes stores docs/readme.txt owned by alice', async () => {
    const { code, output } = await app.pyric([
      'storage',
      'uploadBytes',
      '--path',
      'docs/readme.txt',
      '--contentBase64',
      Buffer.from('hello world').toString('base64'),
      '--metadata',
      JSON.stringify({ contentType: 'text/plain', customMetadata: { owner: 'alice' } }),
    ]);
    assert.equal(code, 0, output);
  });

  await app.step('a re-upload that names no owner is denied, as the live upload is', async () => {
    const { code, output } = await simulate(app, [
      '--operation',
      'create',
      '--path',
      'docs/readme.txt',
      '--uid',
      'alice',
      '--data',
      JSON.stringify({ contentType: 'text/plain', size: 5 }),
    ]);
    assert.equal(code, 0, output);
    assert.match(output, /create docs\/readme\.txt: DENY/, output);
  });

  await app.step('a re-upload that names alice as owner is allowed', async () => {
    const { code, output } = await simulate(app, [
      '--operation',
      'create',
      '--path',
      'docs/readme.txt',
      '--uid',
      'alice',
      '--data',
      JSON.stringify({ contentType: 'text/plain', size: '5', metadata: { owner: 'alice' } }),
    ]);
    assert.equal(code, 0, output);
    assert.match(output, /create docs\/readme\.txt: ALLOW/, output);
  });

  await app.step('an update with no data reads the stored object as request.resource', async () => {
    const { code, output } = await simulate(app, ['--operation', 'update', '--path', 'docs/readme.txt', '--uid', 'alice']);
    assert.equal(code, 0, output);
    assert.match(output, /update docs\/readme\.txt: ALLOW/, output);
  });

  await app.step('a get that passes data is refused', async () => {
    const { code, output } = await simulate(app, [
      '--operation',
      'get',
      '--path',
      'docs/readme.txt',
      '--uid',
      'alice',
      '--data',
      JSON.stringify({ size: 5 }),
    ]);
    assert.notEqual(code, 0, output);
    assert.match(output, /a get request carries no request\.resource; remove 'data'/, output);
  });

  await app.step('a misspelled data field is refused by name', async () => {
    const { code, output } = await simulate(app, [
      '--operation',
      'create',
      '--path',
      'docs/readme.txt',
      '--uid',
      'alice',
      '--data',
      JSON.stringify({ sise: 5 }),
    ]);
    assert.notEqual(code, 0, output);
    assert.match(output, /data\.sise is not a field of request\.resource/, output);
  });

  await app.step('pyric rules lint reports public Storage rules as SEC-1', async () => {
    const { code, output } = await app.pyric(['rules', 'lint', '--service', 'storage', '--rules-file', 'public.rules']);
    assert.notEqual(code, 0, output);
    assert.match(output, /SEC-1/, output);
    assert.doesNotMatch(output, /parsed with no errors/, output);
  });
});
