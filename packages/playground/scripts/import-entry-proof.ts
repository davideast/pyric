import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

const root = resolve(import.meta.dir, '../../..');
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4328';
const fixturePaths = [
  'package.json',
  'examples/vite-sandbox-app/firestore.rules',
  'packages/playground/package.json',
  'packages/playground/tsconfig.json',
  'packages/pyric/package.json',
  'packages/ui/package.json',
  'packages/cli/package.json',
];

const TEXT_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|rules|md|txt|wasm)$/;
function collectTextFiles(relativeDir: string): string[] {
  const absoluteDir = resolve(root, relativeDir);
  const files: string[] = [];
  for (const name of readdirSync(absoluteDir)) {
    // Match a real GitHub clone: ignored build projections are not present.
    if (name === '.generated' || name === 'dist') continue;
    const relative = `${relativeDir}/${name}`;
    const stat = statSync(resolve(root, relative));
    if (stat.isDirectory()) files.push(...collectTextFiles(relative));
    else if (TEXT_EXTENSIONS.test(name)) files.push(relative);
  }
  return files;
}

fixturePaths.push(
  ...collectTextFiles('packages/playground/src'),
  ...collectTextFiles('packages/pyric/src'),
  ...collectTextFiles('packages/ui/src'),
  ...collectTextFiles('packages/cli/src'),
);
const fixture = Object.fromEntries(
  fixturePaths.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]),
);

async function configure(context: BrowserContext): Promise<Page> {
  await context.addInitScript((files) => {
    window.__pyricTestCloneRepo = async ({ writeFile }) => {
      for (const [path, content] of Object.entries(files)) await writeFile(path, content);
    };
  }, fixture);
  await context.route('https://api.github.com/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/user/repos?')) {
      await route.fulfill({ json: [{
        full_name: 'davideast/pyric', clone_url: 'https://github.com/davideast/pyric.git',
        private: false, default_branch: 'main', pushed_at: '2026-07-20T00:00:00Z',
        permissions: { push: true },
      }] });
    } else {
      await route.fulfill({ json: { id: 1, login: 'davideast', name: 'David', email: null, avatar_url: null } });
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[browser pageerror] ${error.stack ?? error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser console] ${message.text()}`);
  });
  await page.goto(baseURL);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('pyric:github-creds', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('creds');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('creds', 'readwrite');
      tx.objectStore('creds').put('proof-token', 'github-pat');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  const importTrigger = page.getByText('Import an existing GitHub repository', { exact: true });
  try {
    await importTrigger.waitFor({ timeout: 30_000 });
  } catch (error) {
    throw new Error(`Home page did not render the GitHub import control. Body:\n${await page.locator('body').innerText()}`, { cause: error });
  }
  await importTrigger.click();
  await page.getByLabel('Repository').selectOption('https://github.com/davideast/pyric.git');
  await page.getByRole('button', { name: 'Clone & inspect repository' }).click();
  await page.getByLabel('React preview entry').waitFor({ timeout: 60_000 });
  return page;
}

const browser = await chromium.launch({ headless: true });
try {
  const selectedContext = await browser.newContext();
  const selected = await configure(selectedContext);
  const entry = '/workspace/packages/playground/src/components/PlaygroundPage.tsx';
  await selected.getByLabel('React preview entry').selectOption(entry);
  await selected.getByRole('button', { name: 'Start imported session' }).click();
  await selected.waitForURL(/\/playground\?session=/, { timeout: 30_000 });
  const previewTab = selected.getByRole('button', { name: 'Preview', exact: true });
  await previewTab.waitFor();
  await previewTab.click();
  const previewFrame = selected.frameLocator('iframe[title="App preview"]');
  const nestedWorkspace = previewFrame.getByRole('button', { name: 'Firebase', exact: true });
  const compileError = selected.getByText('compile error', { exact: true });
  const runtimeError = selected.getByText('runtime error', { exact: true });
  await Promise.race([
    nestedWorkspace.waitFor({ timeout: 120_000 }),
    compileError.waitFor({ timeout: 120_000 }),
    runtimeError.waitFor({ timeout: 120_000 }),
  ]);
  if (await compileError.isVisible()) {
    const panel = compileError.locator('xpath=../../..');
    throw new Error(`Selected playground entry did not compile:\n${await panel.innerText()}`);
  }
  if (await runtimeError.isVisible()) {
    const panel = runtimeError.locator('xpath=../../..');
    throw new Error(`Selected playground entry failed at runtime:\n${await panel.innerText()}`);
  }
  console.log('✓ rendered packages/playground PlaygroundPage as the selected React preview entry');

  const skillsButton = previewFrame.locator('button[title="Review Firebase Expert and skills"]');
  await skillsButton.click();
  const improveFirebase = previewFrame.getByRole('switch', { name: /Improve Firebase/ });
  await improveFirebase.waitFor();
  await improveFirebase.click();
  if ((await improveFirebase.getAttribute('aria-checked')) !== 'true') {
    throw new Error('Improve Firebase skill did not toggle on');
  }
  console.log('✓ toggled Improve Firebase in the imported Playground');
  await selectedContext.close();

  const noPreviewContext = await browser.newContext();
  const noPreview = await configure(noPreviewContext);
  await noPreview.getByLabel('React preview entry').selectOption('__none__');
  await noPreview.getByRole('button', { name: 'Start imported session' }).click();
  await noPreview.waitForURL(/\/playground\?session=/, { timeout: 30_000 });
  await noPreview.getByRole('button', { name: 'Firebase', exact: true }).waitFor();
  if (await noPreview.getByRole('button', { name: 'Preview', exact: true }).count()) {
    throw new Error('Preview tab is visible in no-preview mode');
  }
  console.log('✓ imported the same repo in no-preview mode and omitted Preview');
  await noPreviewContext.close();
} finally {
  await browser.close();
}
