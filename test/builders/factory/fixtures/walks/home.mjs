// The trivial walk: Studio's first page loads and shows text. Real walks live in <briefDir>/walks/.
export default async function walk(page, baseURL) {
  const response = await page.goto(baseURL, { waitUntil: 'load', timeout: 120_000 });
  if (response === null || response.status() >= 500) throw new Error(`the first page answered ${response?.status() ?? 'nothing'}`);
  await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 60_000 });
}
