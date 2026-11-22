// `pyric sandbox --hosted` on a project with a Functions source, started from
// a shell that has gcloud's Google variables and well-known ADC file set. The
// Functions child must see the sandbox project in every project variable, as a
// deployed function sees its own project, and must not see any host credential
// variable, quota project, or well-known ADC file (#1427, #1463).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenario, sleep } from '../driver.ts';

const HOST_PROJECT = 'corp-production-project';
const HOST_CREDENTIALS = '/nonexistent/corp-production-sa.json';
const HOST_SA_BASE64 = 'eyJ0eXBlIjoic2VydmljZV9hY2NvdW50In0=';
const HOST_QUOTA_PROJECT = 'corp-billing-project';

interface ChildEnv {
  GCLOUD_PROJECT: string | null;
  GOOGLE_CLOUD_PROJECT: string | null;
  GCP_PROJECT: string | null;
  GOOGLE_APPLICATION_CREDENTIALS: string | null;
  google_application_credentials: string | null;
  FIREBASE_SA_BASE64: string | null;
  GOOGLE_CLOUD_QUOTA_PROJECT: string | null;
  HOME: string | null;
  CLOUDSDK_CONFIG: string | null;
  homeAdcExists: boolean;
  cloudsdkAdcExists: boolean;
}

export default scenario(async (app) => {
  const hostHome = mkdtempSync(join(tmpdir(), 'pyric-host-adc-'));
  const hostGcloudDir = join(hostHome, '.config', 'gcloud');
  mkdirSync(hostGcloudDir, { recursive: true });
  writeFileSync(
    join(hostGcloudDir, 'application_default_credentials.json'),
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'dev-client',
      client_secret: 'dev-secret',
      refresh_token: 'dev-refresh',
    }),
    'utf8',
  );

  try {
    const port = await app.freePort();
    const sandbox = await app.step('start pyric sandbox --hosted with the host Google variables and ADC file set', () =>
      app.pyricProcess(['sandbox', '--hosted', '--no-open', '--no-run', '--port', String(port)], {
        env: {
          PYRIC_NO_UPDATE_CHECK: '1',
          HOME: hostHome,
          CLOUDSDK_CONFIG: hostGcloudDir,
          GCLOUD_PROJECT: HOST_PROJECT,
          GOOGLE_CLOUD_PROJECT: HOST_PROJECT,
          GCP_PROJECT: HOST_PROJECT,
          GOOGLE_APPLICATION_CREDENTIALS: HOST_CREDENTIALS,
          google_application_credentials: HOST_CREDENTIALS,
          FIREBASE_SA_BASE64: HOST_SA_BASE64,
          GOOGLE_CLOUD_QUOTA_PROJECT: HOST_QUOTA_PROJECT,
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

    await app.step('the child does not see any host credentials, quota project, or well-known ADC file', () => {
      assert.equal(seen.GOOGLE_APPLICATION_CREDENTIALS, null);
      assert.equal(seen.google_application_credentials, null);
      assert.equal(seen.FIREBASE_SA_BASE64, null);
      assert.equal(seen.GOOGLE_CLOUD_QUOTA_PROJECT, null);
      assert.notEqual(seen.HOME, hostHome);
      assert.notEqual(seen.CLOUDSDK_CONFIG, hostGcloudDir);
      assert.equal(seen.homeAdcExists, false);
      assert.equal(seen.cloudsdkAdcExists, false);
    });
  } finally {
    rmSync(hostHome, { recursive: true, force: true });
  }
});
