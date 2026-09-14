/** Selection must change actual paint, not only selector text. Run against serve.ts. */
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  let configure;
  const configuration = new Promise(resolve => { configure = resolve; });
  await page.route("**/__pyric/flow/manifest.json", async route => {
    await configuration;
    await route.continue();
  });
  await page.goto(process.env.FLOW_LAB_URL ?? "http://localhost:5197");
  const picker = page.locator("#treatment");
  const chip = page.locator("[data-flow-treatment]");
  await expect(picker.locator("option")).toHaveCount(15);
  await picker.selectOption("corners");
  configure();
  await expect(page.locator("html")).toHaveAttribute("data-pyric-treatment", "corners");
  await expect.poll(() => page.locator("[data-component=UnreadBadge]").evaluate(el => getComputedStyle(el, "::before").content)).toBe('""');
  await page.unroute("**/__pyric/flow/manifest.json");
  // Start a fresh page so the next race exercises an uncached dynamic import.
  await page.evaluate(() => localStorage.removeItem("pyric:flow-treatment"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-pyric-treatment", "outline");
  // A slow page selection must not overwrite a newer choice made in the chip.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  await page.route("**/chunks/corners-*.js", async route => {
    requested();
    await held;
    await route.continue();
  });
  await picker.selectOption("corners");
  await started;
  await chip.selectOption("outline");
  const chunkResponse = page.waitForResponse(response => /\/chunks\/corners-/.test(response.url()));
  release();
  await expect(picker).toHaveValue("outline");
  // A subsequent selection waits behind the released chunk and exposes late callbacks.
  await expect.poll(() => picker.inputValue()).toBe("outline");
  await (await chunkResponse).finished();
  await expect(picker).toHaveValue("outline");
  await expect(chip).toHaveValue("outline");
  await page.unroute("**/chunks/corners-*.js");
  await page.locator("[data-deliver=messages]").click();
  const mark = page.locator("[data-component=UnreadBadge]");
  const ids = await picker.locator("option").evaluateAll(options => options.map(option => option.value));
  for (const surface of [picker, chip]) {
    for (const id of ids) {
      await surface.selectOption(id);
      await expect(page.locator("html")).toHaveAttribute("data-pyric-treatment", id);
      await surface.selectOption("outline");
      await expect(picker).toHaveValue("outline");
      await expect(chip).toHaveValue("outline");
      await expect(mark).toHaveCSS("outline-style", "solid");
      await expect(mark).toHaveCSS("outline-width", "2px");
      await expect(mark).toHaveCSS("box-shadow", "none");
      await expect.poll(() => mark.evaluate(el => getComputedStyle(el, "::before").content)).toBe("none");
      await expect(page.locator("[data-pyric-treatment-style]")).toHaveCount(1);
      await expect(page.locator(".pyric-treatment-flow-map")).toHaveCount(0);
    }
  }
  console.log("PASS: late page selection cannot overwrite chip choice; all 15 treatments return to actual Crisp outline paint through either selector.");
} finally {
  await browser.close();
}
