// A repro script for the fake builder's browser plant: the same fetch to
// Cloud Storage, from a page in the harness browser, through the Playwright
// client the harness names. The browser's resolver rules refuse it; the
// reproduction is judged by the network record.
const { chromium } = await import(process.env.PYRIC_BUILDER_PLAYWRIGHT);
const browser = await chromium.connect(process.env.PYRIC_BUILDER_BROWSER_WS);
try {
  const page = await browser.newPage();
  const outcome = await page.evaluate(() => fetch('https://firebasestorage.googleapis.com/v0/b/demo-fake.appspot.com/o').then(() => 'succeeded', (error) => `failed: ${error.message}`));
  console.log(`browser fetch ${outcome}`);
} finally {
  await browser.close();
}
