#!/usr/bin/env node

/**
 * Prove package-resolution behavior from consumers of the packed CLI.
 * Activated Node/Vite processes must select Pyric mirrors; inactive processes
 * must select the real Firebase packages owned by the consumer.
 *
 * Usage: node scripts/packed-resolution-smoke.mjs <consumer> <sdk-free-consumer>
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const [consumerArg, sdkFreeArg] = process.argv.slice(2);
if (!consumerArg || !sdkFreeArg) {
  process.stderr.write(
    'usage: node scripts/packed-resolution-smoke.mjs <consumer> <sdk-free-consumer>\n',
  );
  process.exit(2);
}

const consumer = isAbsolute(consumerArg) ? consumerArg : resolve(consumerArg);
const sdkFreeConsumer = isAbsolute(sdkFreeArg) ? sdkFreeArg : resolve(sdkFreeArg);

const inactiveNode = join(consumer, '__packed-node-inactive.mjs');
writeFileSync(
  inactiveNode,
  `import assert from 'node:assert/strict';
import { initializeApp } from 'firebase/app';
import { getApps } from 'firebase-admin/app';
const clientUrl = import.meta.resolve('firebase/app');
const adminUrl = import.meta.resolve('firebase-admin/app');
assert.match(clientUrl, /[/\\\\]node_modules[/\\\\]firebase[/\\\\]/);
assert.match(adminUrl, /[/\\\\]node_modules[/\\\\]firebase-admin[/\\\\]/);
const app = initializeApp({ projectId: 'packed-inactive-resolution' }, 'packed-inactive-resolution');
assert.equal(app[Symbol.for('pyric.app.target')], undefined);
assert.equal(Array.isArray(getApps()), true);
`,
);
runNode(consumer, [inactiveNode]);

const activeNode = join(sdkFreeConsumer, '__packed-node-active.mjs');
writeFileSync(
  activeNode,
  `import assert from 'node:assert/strict';
const admin = await import('firebase-admin/database');
const appModule = await import('firebase/app');
const firestore = await import('firebase/firestore');
assert.equal(typeof admin.getDatabase, 'function');
const options = { projectId: 'packed-active-resolution' };
const app = appModule.initializeApp(options);
assert.equal(app.name, '[DEFAULT]');
assert.deepEqual(app.options, options);
assert.equal(appModule.getApp(), app);
assert.deepEqual(appModule.getApps(), [app]);
assert.equal(typeof firestore.getFirestore(app), 'object');
`,
);
runNode(sdkFreeConsumer, ['--import', '@pyric/cli/register', activeNode], {
  PYRIC_SANDBOX: 'local',
});

const viteRoot = join(consumer, '__packed-vite-resolution');
rmSync(viteRoot, { recursive: true, force: true });
mkdirSync(join(viteRoot, 'src'), { recursive: true });
writeFileSync(
  join(viteRoot, 'src/main.js'),
  `import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
export const db = getFirestore(initializeApp({ projectId: 'packed-vite-resolution' }));
`,
);
writeFileSync(
  join(viteRoot, 'check.mjs'),
  `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pyricSandbox } from '@pyric/cli/vite';

const root = process.cwd();
const importer = join(root, 'src/main.js');

async function resolveWith(plugins) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins,
    server: { middlewareMode: true },
  });
  try {
    return {
      app: await server.pluginContainer.resolveId('firebase/app', importer),
      firestore: await server.pluginContainer.resolveId('firebase/firestore', importer),
    };
  } finally {
    await server.close();
  }
}

const active = await resolveWith([pyricSandbox({ ui: false })]);
for (const resolved of [active.app, active.firestore]) {
  assert.ok(resolved?.id.includes('/node_modules/@pyric/cli/dist/serve/entries/'), resolved?.id);
}

const inactive = await resolveWith([]);
for (const resolved of [inactive.app, inactive.firestore]) {
  assert.ok(
    resolved?.id.includes('/node_modules/firebase/') ||
      resolved?.id.includes('/node_modules/.vite/deps/firebase_'),
    resolved?.id,
  );
  assert.ok(!resolved.id.includes('/node_modules/@pyric/cli/'), resolved.id);
}
`,
);
runNode(viteRoot, [join(viteRoot, 'check.mjs')]);

process.stdout.write(
  '  ✓ packed Node and Vite fixtures select Pyric only when sandbox activation is present\n',
);

function runNode(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', ...env },
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `node ${args.join(' ')} failed\n` +
        `exit: ${result.status ?? -1}\n` +
        `stdout:\n${result.stdout ?? ''}\n` +
        `stderr:\n${result.stderr ?? ''}\n` +
        (result.error ? `error: ${result.error.message}\n` : ''),
    );
  }
}
