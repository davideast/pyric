// The Vite `web` template must pass every Firebase option listed in its
// `.env.example` into `initializeApp(...)` (including VITE_FIREBASE_APP_ID,
// VITE_FIREBASE_STORAGE_BUCKET, and VITE_FIREBASE_MESSAGING_SENDER_ID) so real
// AI Logic / App Check work in production mode and in `vite build` (#1567).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../driver.ts';

const PROJECT = 'my-web-app';

const ENV_VALUES = {
  apiKey: 'AIzaSyDemoKeyForReproOnly000000000000',
  authDomain: 'my-real-project.firebaseapp.com',
  projectId: 'my-real-project',
  storageBucket: 'my-real-project.firebasestorage.app',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:abcdef0123456789',
};

export default scenario(async (app) => {
  await app.step('create-pyric scaffolds the web template', async () => {
    const result = await app.command('node', [
      'node_modules/create-pyric/dist/bin.js',
      PROJECT,
      '--template',
      'web',
    ]);
    assert.equal(result.code, 0, result.output);
    const envExample = app.readFile(`${PROJECT}/.env.example`);
    for (const key of [
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_STORAGE_BUCKET',
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'VITE_FIREBASE_APP_ID',
    ]) {
      assert.match(envExample, new RegExp(`^${key}=`, 'm'), `.env.example missing ${key}`);
    }
  });

  await app.step('write .env.local with all six VITE_FIREBASE_* values', () => {
    app.writeFile(
      `${PROJECT}/.env.local`,
      [
        `VITE_FIREBASE_API_KEY=${ENV_VALUES.apiKey}`,
        `VITE_FIREBASE_AUTH_DOMAIN=${ENV_VALUES.authDomain}`,
        `VITE_FIREBASE_PROJECT_ID=${ENV_VALUES.projectId}`,
        `VITE_FIREBASE_STORAGE_BUCKET=${ENV_VALUES.storageBucket}`,
        `VITE_FIREBASE_MESSAGING_SENDER_ID=${ENV_VALUES.messagingSenderId}`,
        `VITE_FIREBASE_APP_ID=${ENV_VALUES.appId}`,
        '',
      ].join('\n'),
    );
  });

  await app.step('install the scaffolded web project', () => app.installProject(PROJECT));

  await app.step('vite build embeds all configured Firebase options including appId', async () => {
    const build = await app.command('npm', ['run', 'build'], { cwd: PROJECT, timeoutMs: 120_000 });
    assert.equal(build.code, 0, build.output);
    const assetsDir = join(app.dir, PROJECT, 'dist', 'assets');
    const jsFiles = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
    assert.ok(jsFiles.length > 0, 'vite build emitted no JS asset under dist/assets');
    const bundle = jsFiles
      .map((name) => app.readFile(`${PROJECT}/dist/assets/${name}`))
      .join('\n');
    for (const [field, value] of Object.entries(ENV_VALUES)) {
      assert.ok(bundle.includes(value), `vite build bundle missing ${field} (${value})`);
    }
  });

  await app.step('vite dev initializes the default app with all six options', async () => {
    // Expose getApp().options from a separate HTML probe module so the
    // scaffolded src/main.ts runs unmodified.
    const indexHtml = app.readFile(`${PROJECT}/index.html`);
    app.writeFile(
      `${PROJECT}/src/probe-options.ts`,
      [
        "import { getApp, getApps } from 'firebase/app';",
        'const poll = (): void => {',
        '  if (getApps().length > 0) {',
        '    (window as unknown as { __pyricAppOptions?: unknown }).__pyricAppOptions = getApp().options;',
        '    return;',
        '  }',
        '  setTimeout(poll, 20);',
        '};',
        'poll();',
        '',
      ].join('\n'),
    );
    app.writeFile(
      `${PROJECT}/index.html`,
      indexHtml.replace(
        '</body>',
        '  <script type="module" src="/src/probe-options.ts"></script>\n  </body>',
      ),
    );

    const host = await app.devServer({ cwd: PROJECT });
    const page = await app.page(host.url);
    await page.waitForFunction(() => '__pyricAppOptions' in window, undefined, { timeout: 30_000 });
    const options = await page.evaluate(
      () => (window as unknown as { __pyricAppOptions: Record<string, unknown> }).__pyricAppOptions,
    );
    assert.deepEqual(options, ENV_VALUES);
  });
});
