import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const request = await context.newPage();
  await request.goto(process.env.KIN_BASE_URL ?? 'http://127.0.0.1:5227/');
  await request.getByLabel("Email", { exact: true }).fill("emma@kin.example");
  await request
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  const [page] = await Promise.all([
    context.waitForEvent("page"),
    request.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  await page
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  const card = page.locator(".post-card").filter({has: page.locator(".video-preview")}).first();
  const preview = card.locator(".video-preview");
  const cover = card.locator("img.card-cover");
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    const a=await preview.boundingBox(), b=await cover.boundingBox();
    assert.ok(a && b && a.y < b.y+b.height && a.y+a.height > b.y, "Play treatment must overlap the video cover");
  }
  await card.locator(".post-open").click();
  await page.locator("video[controls]").waitFor();
  console.log("PASS video overlay at desktop/mobile widths and detail navigation");
} finally { await browser.close(); }
