import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
const origin = process.env.KIN_BASE_URL ?? "http://127.0.0.1:5227/";
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => {
    const Native = window.SharedWorker;
    window.SharedWorker = class extends Native {
      constructor(url, options) {
        if (String(url).includes("generation-shared-worker.ts"))
          url = new URL("/test/resumable-worker.ts", location.href);
        super(url, options);
      }
    };
  });
  const login = await context.newPage();
  await login.goto(origin);
  await login.getByLabel("Email", { exact: true }).fill("emma@kin.example");
  await login
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  let [page] = await Promise.all([
    context.waitForEvent("page"),
    login.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  await page
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  await login.close();
  page.on("pageerror", (error) => console.log("PAGE ERROR", error.message));
  page.setDefaultTimeout(12000);
  await page.goto(origin + "#apps");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page.getByLabel("App name", { exact: true }).fill("Durable counter");
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("A counter");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: /Continue draft.*Durable counter/ })
    .click();
  await page
    .getByText("Draft saved", { exact: true })
    .waitFor()
    .catch(async (e) => {
      console.log(await page.locator("main").innerText());
      throw e;
    });
  assert.equal(
    await page.getByLabel("What should it do?", { exact: true }).inputValue(),
    "A counter",
  );

  const other = await context.newPage();
  await other.goto(page.url());
  await other.getByText("Draft saved", { exact: true }).waitFor();
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("First tab change");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await other
    .getByLabel("What should it do?", { exact: true })
    .fill("Second tab recovered text");
  await other.getByText(/This draft changed in another tab/).waitFor();
  await other.reload();
  await other
    .getByRole("button", { name: "Save recovered draft", exact: true })
    .waitFor();
  assert.equal(
    await other.getByLabel("What should it do?", { exact: true }).inputValue(),
    "Second tab recovered text",
  );
  await other
    .getByRole("button", { name: "Save recovered draft", exact: true })
    .click();
  await other.getByText("Draft saved", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Draft saved", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("What should it do?", { exact: true }).inputValue(),
    "Second tab recovered text",
  );
  console.log(
    "PASS conflicting tabs preserve text and require explicit recovery",
  );
} finally {
  await browser.close();
}
