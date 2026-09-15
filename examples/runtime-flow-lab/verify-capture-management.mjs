import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch();
try {
 for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  await page.goto('http://localhost:5197/?service=firestore');
  const init = await (await page.request.get('http://localhost:5197/__pyric/init.json')).json();
  const headers = { 'x-pyric-session-token': init.sessionToken };
  const endpoint = 'http://localhost:5197/__pyric/rate-captures';
  const captures = await (await page.request.get(endpoint, { headers })).json();
  expect(captures.length).toBeGreaterThan(0);
  const original = await (await page.request.get(`${endpoint}?id=${captures[0].id}`, { headers })).json();
  const created = await (await page.request.post(endpoint, { headers, data: original })).json();
  const id = created.id;
  const name = `Message burst ${width}`;
  try {
   const openList = async () => {
    const opener = page.getByRole('button', { name: 'Open pyric', exact: true });
    await expect(opener.or(page.getByRole('button', { name: 'Minimize pyric', exact: true }))).toBeVisible();
    if (await opener.isVisible()) await opener.click();
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    await page.getByRole('button', { name: 'Rates', exact: true }).click();
    await page.getByRole('button', { name: 'Firestore', exact: true }).click();
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('button', { name: 'Open capture…', exact: true }).click();
    await page.locator(`[data-project-capture="${id}"]`).click();
   };
   await openList();
   await page.getByRole('button', { name: 'More actions', exact: true }).click();
   await page.getByRole('button', { name: 'Rename…', exact: true }).click();
   await page.getByLabel('Name', { exact: true }).fill(name);
   await page.screenshot({ path: `/tmp/capture-rename-${width}.png` });
   await page.getByRole('button', { name: 'Save', exact: true }).click();
   await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(name);
   expect(await (await page.request.get(`${endpoint}?id=${id}`, { headers })).json()).toEqual(original);
   await page.reload(); await openList();
   await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(name);
   await page.getByRole('button', { name: 'More actions', exact: true }).click();
   await page.getByRole('button', { name: 'Delete…', exact: true }).click();
   await page.screenshot({ path: `/tmp/capture-delete-${width}.png` });
   expect(await page.locator('.traffic-toolbar').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
   await page.getByRole('button', { name: 'Cancel', exact: true }).click();
   expect((await page.request.get(`${endpoint}?id=${id}`, { headers })).ok()).toBe(true);
   await page.getByRole('button', { name: 'More actions', exact: true }).click();
   await page.getByRole('button', { name: 'Delete…', exact: true }).click();
   const deleting = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes(id));
   await page.getByRole('button', { name: 'Delete', exact: true }).click();
   expect((await deleting).status()).toBe(200);
   await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveText('ServicesCaptures');
   await expect(page.locator(`[data-project-capture="${id}"]`)).toHaveCount(0);
   expect((await page.request.get(`${endpoint}?id=${id}`, { headers })).ok()).toBe(false);
   expect((await page.request.get(`${endpoint}?id=${captures[0].id}`, { headers })).ok()).toBe(true);
   console.log('PASS rename persists without changing evidence, cancel preserves capture, delete removes only its snapshot', width);
  } finally { await page.request.delete(`${endpoint}?id=${id}`, { headers, data: { confirm: true } }); await page.close(); }
 }
} finally { await browser.close(); }
