/** Run after building Playground and serving it with --hosted and Orbit's demo seed.
 * No model key, remote project, or deployment is required. Browser cleanup is unconditional.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const baseUrl = process.argv[2] ?? 'http://localhost:5219';
const email = `node-checkpoint-${Date.now()}@example.test`;
const browser = await chromium.launch({ headless: true });
const pageErrors = [];
let page;
try {
  const context = await browser.newContext();
  page = await context.newPage();
  await context.addInitScript(() => {
    globalThis.SharedWorker = class {
      constructor() {
        throw new Error('Unexpected SharedWorker in Node-host checkpoint');
      }
    };
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/?sandbox=shared`);
  await page.locator('textarea').first().fill('Local Node host checkpoint');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByRole('button', { name: 'Firebase', exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Firebase', exact: true }).click();
  assert.equal(
    await page.locator('meta[name="pyric-sandbox-host"]').getAttribute('content'),
    'node',
  );
  await page.getByRole('button', { name: 'Auth', exact: true }).click();
  await page.getByText('david@orbit.example', { exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  await page.getByPlaceholder('email@example.com').fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill('local-checkpoint-only');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText(email, { exact: true }).waitFor();
  const studio = await page.context().newPage();
  await studio.goto(`${baseUrl}/__pyric/ui/auth`);
  await studio.getByText(email, { exact: true }).waitFor();
  console.log('PASS Playground creates user visible in Node-backed Studio');
  await studio.close();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const editor = page.locator('.cm-content').first();
  await editor.waitFor({ state: 'visible' });
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(`import { useState } from 'react';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
export default function App() {
 const [status, setStatus] = useState('Ready');
 async function signIn() {
  try { const result = await signInWithEmailAndPassword(getAuth(), 'david@orbit.example', 'orbit-demo'); setStatus('Signed in: ' + result.user.uid); }
  catch (error) { setStatus(String(error)); }
 }
 return <main><h1>Hosted preview checkpoint</h1><button onClick={signIn}>Sign in as David</button><p>{status}</p></main>;
}`);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.frameLocator('iframe[title="App preview"]');
  await preview.getByRole('button', { name: 'Sign in as David' }).click({ timeout: 20000 });
  await preview.getByText('Signed in: david', { exact: true }).waitFor({ timeout: 10000 });
  console.log('PASS Playground compiled preview signs in against Node seed');
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: join(tmpdir(), 'pyric-playground-hosted-checkpoint.png') });
} catch (error) {
  console.error(await page?.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
