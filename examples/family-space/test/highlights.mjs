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
  await page.evaluate(() => (location.hash = "chat"));
  await page.locator(".chat-message").first().waitFor();
  await page.getByRole("button", { name: "Open pyric", exact: true }).click();
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  const all = page.getByRole("button", { name: "Show all", exact: true });
  if ((await all.getAttribute("aria-pressed")) !== "true") await all.click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-pyric-listener-box]").length > 0,
  );
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await page
    .getByRole("button", { name: "Minimize pyric", exact: true })
    .click();
  const text = "Highlight regression " + Date.now();
  await page.getByRole("textbox", { name: "Family chat message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const row = page.locator(".chat-message").filter({ hasText: text });
  await row.waitFor();
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll(".chat-message[data-pyric-flow]")].some(
        (el) => el.textContent.includes(t),
      ),
    text,
  );
  await page.screenshot({ path: "/tmp/kin-highlight-message.png" });
  // Return to overview after a reload without an auth reset.
  await page.reload();
  await page.locator(".chat-message").first().waitFor();
  await page.getByRole("button", { name: "Open pyric", exact: true }).click();
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  if ((await all.getAttribute("aria-pressed")) !== "true") await all.click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-pyric-listener-box]").length > 0,
  );
  assert.ok(await page.locator("[data-pyric-listener-box]").count());
  console.log(
    "PASS initial Overview, sent message Flow, and Overview after authenticated reload",
  );
} finally {
  await browser.close();
}
