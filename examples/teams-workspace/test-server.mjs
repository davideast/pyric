import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createServer } from 'vite';

// Each browser run owns its state and Functions child; never touch the demo's data.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-notifications-')));
cpSync(import.meta.dirname, root, {
  recursive: true,
  filter: source => !['node_modules', '.pyric', 'dist', 'test-results'].includes(basename(source)),
});
symlinkSync(join(import.meta.dirname, 'node_modules'), join(root, 'node_modules'));
symlinkSync(join(import.meta.dirname, 'functions/node_modules'), join(root, 'functions/node_modules'));
writeFileSync(join(root, 'test-sdk.ts'), `
  export * as auth from 'firebase/auth';
  export * as firestore from 'firebase/firestore';
  export * as database from 'firebase/database';
`);
const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), server: { fs: { allow: [root, join(import.meta.dirname, '../..')] } } });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
await server.listen();
