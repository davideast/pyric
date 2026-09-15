import { test, expect } from '@playwright/test';

test('Studio lists app listeners registered before it opens and removes them when the app closes', async ({ page, context, baseURL }) => {
  await page.goto(baseURL!);
  await page.getByRole('button', { name: 'Watch the shared note' }).click();
  await expect(page.locator('#notes-panel')).not.toHaveText('no note yet');
  await page.getByRole('button', { name: 'Generate read traffic' }).click();
  await expect(page.locator('#read-traffic-status')).toHaveText('550 reads complete');
  const studio = await context.newPage();
  await studio.goto(`${baseURL}/__pyric/ui/traffic/?view=listeners`);
  await expect(studio.getByRole('heading', { name: '1 listener', exact: true })).toBeVisible();
  await page.close();
  await expect(studio.getByRole('heading', { name: 'No listeners attached', exact: true })).toBeVisible();
});

 test('Studio counts Firestore and RTDB independently across a traffic burst and detach', async ({ page, context, baseURL }) => {
  await page.goto(baseURL!);
  await page.getByRole('button', { name: 'Watch the shared note' }).click();
  await expect(page.locator('#notes-panel')).not.toHaveText('no note yet');
  await page.getByRole('button', { name: 'Watch presence' }).click();
  await expect(page.locator('#presence-status')).toHaveText('Presence subscribed');
  const studio = await context.newPage();
  await studio.goto(`${baseURL}/__pyric/ui/traffic/?view=listeners`);
  await expect(studio.getByRole('heading', { name: '2 listeners', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Generate read traffic' }).click();
  await expect(page.locator('#read-traffic-status')).toHaveText('550 reads complete');
  await expect(studio.getByRole('heading', { name: '2 listeners', exact: true })).toBeVisible();
  await studio.reload();
  await expect(studio.getByRole('heading', { name: '2 listeners', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop presence' }).click();
  await expect(studio.getByRole('heading', { name: '1 listener', exact: true })).toBeVisible();
  await page.close();
  await expect(studio.getByRole('heading', { name: 'No listeners attached', exact: true })).toBeVisible();
});
