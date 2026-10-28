// `pyric sandbox --hosted` on a project with a Functions source, started from
// a shell that has gcloud's Google variables set. The Functions child must see
// the sandbox project in every project variable, as a deployed function sees
// its own project, and must not see the host's credentials file. Before the
// fix the child inherited GOOGLE_CLOUD_PROJECT, GCP_PROJECT and
// GOOGLE_APPLICATION_CREDENTIALS from the host (#1427).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, sleep } from '../driver.ts';

const HOST_PROJECT = 'corp-production-project';
const HOST_CREDENTIALS = '/nonexistent/corp-production-sa.json';

interface ChildEnv {
  GCLOUD_PROJECT: string | null;
  GOOGLE_CLOUD_PROJECT: string | null;
  GCP_PROJECT: string | null;
  GOOGLE_APPLICATION_CREDENTIALS: string | null;
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const sandbox = await app.step('start pyric sandbox --hosted with the host Google variables set', () =>
    app.pyricProcess(['sandbox', '--hosted', '--no-open', '--no-run', '--port', String(port)], {
      env: {
        PYRIC_NO_UPDATE_CHECK: '1',
        GCLOUD_PROJECT: HOST_PROJECT,
        GOOGLE_CLOUD_PROJECT: HOST_PROJECT,
        GCP_PROJECT: HOST_PROJECT,
        GOOGLE_APPLICATION_CREDENTIALS: HOST_CREDENTIALS,
      },
    }));

  const seen = await app.step('the Functions child loads the function module', async () => {
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(app.dir, 'child-env.json'))) {
      assert.ok(sandbox.running, `pyric sandbox exited before the Functions child loaded:\n${sandbox.output}`);
      assert.ok(Date.now() < deadline, `the Functions child did not load functions/index.js within 60s:\n${sandbox.output}`);
      await sleep(250);
    }
    return JSON.parse(app.readFile('child-env.json')) as ChildEnv;
  });

  await app.step('the child sees the sandbox project, not the host project', () => {
    assert.ok(seen.GCLOUD_PROJECT, 'GCLOUD_PROJECT is set');
    assert.notEqual(seen.GCLOUD_PROJECT, HOST_PROJECT);
    assert.equal(seen.GOOGLE_CLOUD_PROJECT, seen.GCLOUD_PROJECT);
    assert.equal(seen.GCP_PROJECT, seen.GCLOUD_PROJECT);
  });

  await app.step("the child does not see the host's credentials file", () => {
    assert.equal(seen.GOOGLE_APPLICATION_CREDENTIALS, null);
  });
});
