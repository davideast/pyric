/** Disposable Orbit walkthrough: node examples/teams-workspace/verify-persistence.mjs */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { pyric } from '../../packages/cli/dist/vite.js';

const repo = resolve(import.meta.dirname, '../..');
const example = join(repo, 'examples/teams-workspace');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-persistence-checkpoint-')));
const evidence = join(tmpdir(), 'pyric-orbit-persistence-result.json');
const cli = join(repo, 'packages/cli/dist/cli/index.js');
const run = promisify(execFile);
const stages = [];
const browserErrors = [];
const email = 'persistence-checkpoint@example.test';
const password = 'Disposable-checkpoint-42';
const message = 'Orbit persistence checkpoint: message and attachment';
const file = { name: 'checkpoint.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 127, 128, 254, 255, 10, 65]) };
const state = join(root, '.pyric/state');
const hosted = join(state, 'hosted');
let server;
let browser;
let context;
let port = 0;
let original;
let succeeded = false;

function record(step, detail) {
  stages.push({ step, detail });
  console.log(`PASS: ${step}`);
}
function fingerprint(directory) {
  return Object.fromEntries(readdirSync(directory).sort().map(name => [name,
    createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]));
}
async function start({ fresh = false, seed = true } = {}) {
  server = await createServer({ root, configFile: false, logLevel: 'warn',
    // Retain the server even if a later plugin rejects during configureServer.
    // The malformed-store checkpoint must close Vite's partial startup too.
    plugins: [{ name: 'checkpoint-server-owner', enforce: 'pre', configureServer(created) { server = created; } },
      pyric({ hosted: true, bridge: true, capture: false, runtimeChip: true,
      fresh, seed: seed ? 'seed.json' : undefined, ai: { model: 'ornith:9b' } })],
    server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root, repo] } },
  });
  await server.listen();
  port = server.httpServer.address().port;
  context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => {
    browserErrors.push(error.message);
    console.error('[orbit browser]', error.message);
  });
  page.on('console', message => {
    const isError = message.type() === 'error';
    if (isError) console.error('[orbit console]', message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  return page;
}
async function stop() {
  await context?.close();
  context = undefined;
  await server?.close();
  server = undefined;
}
async function signIn(page) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('.auth-submit').click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}
async function readState(page) {
  return page.evaluate(async ({ message }) => {
    const { auth, db, rtdb, firestore, database, storage } = await import('/checkpoint-sdk.ts');
    const docs = await firestore.getDocs(firestore.collection(db, 'workspaces/orbit/channels/design/messages'));
    const document = docs.docs.find(doc => doc.data().text === message);
    const listing = await storage.listAll(storage.ref(storage.getStorage(), 'workspace'));
    const objects = await Promise.all(listing.prefixes.map(prefix => storage.listAll(prefix)));
    const reference = objects.flatMap(group => group.items).find(item => item.name === 'checkpoint.bin');
    const metadata = reference ? await storage.getMetadata(reference) : null;
    const bytes = reference ? [...new Uint8Array(await storage.getBytes(reference))] : null;
    const rtdbValue = (await database.get(database.ref(rtdb, 'scenarios/persistence-checkpoint'))).val();
    return { uid: auth.currentUser?.uid, document: document ? { id: document.id, ...document.data() } : null,
      rtdbValue, bytes, metadata };
  }, { message });
}
async function verifyRestored(page, step) {
  await signIn(page);
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  assert.deepEqual(await readState(page), original);
  const link = page.locator('a[download="checkpoint.bin"]').first();
  const downloaded = await page.evaluate(async href => [...new Uint8Array(await (await fetch(href)).arrayBuffer())], await link.getAttribute('href'));
  assert.deepEqual(downloaded, [...file.buffer]);
  record(step, { uid: original.uid, documentId: original.document.id, bytes: file.buffer.length, metadata: original.metadata });
}
try {
  // Copy source only. Never inherit the user's runtime state or deployment secrets.
  cpSync(example, root, { recursive: true, filter: source => {
    const name = basename(source);
    const excluded = ['node_modules', '.pyric', 'dist', 'test-results', '.git'].includes(name) || name.startsWith('.env');
    return !excluded;
  } });
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'));
  symlinkSync(join(example, 'functions/node_modules'), join(root, 'functions/node_modules'));
  writeFileSync(join(root, 'checkpoint-sdk.ts'), `
    export { auth, db, rtdb } from './data';
    export * as firestore from 'firebase/firestore';
    export * as database from 'firebase/database';
    export * as storage from 'firebase/storage';
  `);
  browser = await chromium.launch({ headless: true });
  let page = await start();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Persistence Checkpoint');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('.auth-submit').click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeVisible();
  await composer.fill(message);
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { database, rtdb } = await import('/checkpoint-sdk.ts');
    await database.set(database.ref(rtdb, 'scenarios/persistence-checkpoint'), { text: 'Durable RTDB value', count: 42 });
  });
  original = await readState(page);
  assert.ok(original.uid);
  assert.equal(original.document.text, message);
  assert.deepEqual(original.bytes, [...file.buffer]);
  assert.deepEqual(original.rtdbValue, { text: 'Durable RTDB value', count: 42 });
  record('Create account, send Orbit message with file, and write RTDB', { uid: original.uid, documentId: original.document.id });
  await page.screenshot({ path: join(tmpdir(), 'pyric-orbit-persistence-created.png'), fullPage: true });
  await stop();

  page = await start();
  await verifyRestored(page, 'Cold host restart and new browser context preserve account, data, file bytes and metadata');
  await stop();

  page = await start({ fresh: true, seed: false });
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('.auth-submit').click();
  await expect(page.getByRole('alert')).toBeVisible();
  const archives = readdirSync(state).filter(name => name.startsWith('hosted.archive-'));
  assert.equal(archives.length, 1);
  record('Fresh starts empty and preserves one archive', { archive: archives[0] });
  await stop();

  const archive = join(state, archives[0]);
  const before = fingerprint(archive);
  const recovered = join(state, 'recovered');
  const recoveredResult = await run(process.execPath, [cli, 'sandbox', 'salvage', '--source', archive, '--out', recovered], { cwd: root, timeout: 20_000 });
  const report = JSON.parse(recoveredResult.stdout);
  assert.deepEqual(report.excluded, []);
  assert.equal(report.recoveredObjects, 1);
  assert.ok(report.recoveredDocuments > 0);
  assert.deepEqual(fingerprint(archive), before);
  renameSync(hosted, join(state, 'fresh-empty'));
  renameSync(recovered, hosted);
  page = await start({ seed: false });
  await verifyRestored(page, 'CLI salvage preserves archive bytes and restores usable Orbit state');
  await stop();

  // Inject one malformed disposable record without altering the valid account/message/file.
  const database = new DatabaseSync(join(hosted, 'state.sqlite'));
  database.prepare('INSERT INTO records VALUES (?, ?, ?)').run('hosted', 'checkpoint-damaged', '{');
  database.close();
  await assert.rejects(start({ seed: false }), /could not be restored/);
  await stop();
  const damagedBefore = fingerprint(hosted);
  const repaired = join(state, 'repaired');
  const repairedResult = await run(process.execPath, [cli, 'sandbox', 'salvage', '--source', hosted, '--out', repaired], { cwd: root, timeout: 20_000 });
  const repairedReport = JSON.parse(repairedResult.stdout);
  assert.deepEqual(repairedReport.excluded, [{ namespace: 'hosted', id: 'checkpoint-damaged', reason: 'Invalid JSON' }]);
  assert.deepEqual(fingerprint(hosted), damagedBefore);
  renameSync(hosted, join(state, 'damaged-preserved'));
  renameSync(repaired, hosted);
  page = await start({ seed: false });
  await verifyRestored(page, 'Malformed state fails closed; salvage reports the exclusion and restores Orbit');
  await page.screenshot({ path: join(tmpdir(), 'pyric-orbit-persistence-recovered.png'), fullPage: true });
  record('Recovery report', repairedReport);
  assert.deepEqual(browserErrors, []);
  succeeded = true;
} finally {
  const failedWithPage = !succeeded && context !== undefined;
  if (failedWithPage) {
    const page = context.pages()[0];
    await page?.screenshot({ path: join(tmpdir(), 'pyric-orbit-persistence-failed.png'), fullPage: true }).catch(() => {});
  }
  try { await stop(); }
  finally {
    try { await browser?.close(); }
    finally {
      rmSync(root, { recursive: true, force: true });
      writeFileSync(evidence, JSON.stringify({ succeeded, verifiedAt: new Date().toISOString(), node: process.version,
        stages, browserErrors, disposableRootRemoved: !existsSync(root) }, null, 2) + '\n');
      console.log(`Evidence: ${evidence}`);
    }
  }
}
