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
  console.log("PASS prompt survives reload");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .waitFor({ timeout: 40000 });
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .click();
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 15000 })
    .catch(async (e) => {
      console.log("PAGE", await page.locator("body").innerText());
      throw e;
    });
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .waitFor({ state: "hidden" });
  const frame = page.frameLocator('iframe[title="Family app preview"]');
  await frame.getByRole("button", { name: "Add kindness" }).click();
  await frame.getByText("Count: 1", { exact: true }).waitFor();
  const url = page.url();
  await page.getByRole("button", { name: "Edit app", exact: true }).click();
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("A better counter");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Generate version", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Building Durable counter", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .waitFor({ timeout: 40000 });
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .click();
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 15000 })
    .catch(async (e) => {
      console.log("PAGE", await page.locator("body").innerText());
      throw e;
    });
  await page.getByLabel("Version history").selectOption({ label: "Version 2" });
  await page.getByText("App started successfully", { exact: true }).waitFor();
  await frame.getByText("Count: 1", { exact: true }).waitFor();
  await frame.getByRole("button", { name: "Add kindness" }).click();
  await frame.getByText("Count: 2", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .waitFor({ state: "hidden" });
  await frame.getByText("Count: 1", { exact: true }).waitFor();
  assert.equal(page.url().split("/version/")[0], url.split("/version/")[0]);
  await page.getByLabel("Version history").selectOption({ label: "Version 1" });
  await page.getByText("App started successfully", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .waitFor({ state: "hidden" });
  await frame.getByText("Count: 1", { exact: true }).waitFor();
  console.log(
    "PASS regeneration, preview isolation, activation and rollback preserve live records",
  );
  await page.getByRole("button", { name: "Delete app", exact: true }).click();
  await page
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await page.getByText("Trash", { exact: true }).click();
  await page
    .getByRole("button", { name: "Restore Durable counter", exact: true })
    .click();
  await page.getByRole("button", { name: /Durable counter.*Open app/ }).click();
  await page.getByText("App started successfully", { exact: true }).waitFor();
  await frame.getByText("Count: 1", { exact: true }).waitFor();
  console.log("PASS delete and restore preserve versions and data");
  await page.getByRole("button", { name: "Delete app", exact: true }).click();
  await page
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await page.getByText("Trash", { exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore Durable counter", exact: true })
    .waitFor({ state: "hidden" });
  console.log("PASS permanent deletion removes the app from Trash");
  await page.goto(origin + "#apps");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page.getByLabel("App name", { exact: true }).fill("Retry counter");
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("[fail-build] A counter");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("button", { name: "Retry stage", exact: true })
    .waitFor({ timeout: 30000 });
  await page
    .getByRole("link", { name: "Start over from draft", exact: true })
    .click();
  await page
    .getByRole("button", { name: /^(Retry from beginning|Create app)$/, exact: true })
    .waitFor();
  await page.getByText("Draft saved", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("What should it do?", { exact: true }).inputValue(),
    "[fail-build] A counter",
  );
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("A counter");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .waitFor({ timeout: 40000 });
  console.log("PASS failed build returns to editable draft and starts fresh");
} finally {
  await browser.close();
}
