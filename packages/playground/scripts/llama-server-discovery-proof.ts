import { chromium } from 'playwright';

const playgroundUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4328';
const expectedModel = process.env.LLAMA_SERVER_MODEL ?? 'ornith-35b';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('http://localhost:8080/v1/models', (route) =>
    route.abort('connectionrefused'));
  await page.goto(playgroundUrl);

  const provider = page.locator('select[title="LLM provider"]');
  await provider.selectOption('llamaServer');

  const model = page.locator('select[title="Model"]');
  await model.locator(`option[value="${expectedModel}"]`).waitFor({
    state: 'attached',
    timeout: 10_000,
  });
  if ((await model.inputValue()) !== expectedModel) {
    throw new Error(`Expected ${expectedModel} to be selected, got ${await model.inputValue()}`);
  }
  console.log(`✓ proxied around a refused browser request and selected llama.cpp model ${expectedModel}`);
} finally {
  await browser.close();
}
