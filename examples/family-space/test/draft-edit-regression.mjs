import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
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
  await login.goto(process.env.KIN_BASE_URL ?? "http://127.0.0.1:5227/");
  await login.getByLabel("Email", { exact: true }).fill("emma@kin.example");
  await login
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  const [page] = await Promise.all([
    context.waitForEvent("page"),
    login.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  await page
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  await login.close();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => console.log("PAGE", e.message));
  await page.goto(new URL("/#apps", page.url()).href);
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByLabel("App name", { exact: true })
    .pressSequentially("Generated notes", { delay: 10 });
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("[policy-notes] Each member may manage only their own notes.");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Sam Parker", exact: true }).check();
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .waitFor({ timeout: 60000 })
    .catch(async (e) => {
      console.log(await page.locator("main").innerText());
      throw e;
    });
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .click();
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 20000 })
    .catch(async (e) => {
      console.log(await page.locator("body").innerText());
      throw e;
    });
  await page
    .getByText("Policy checks passed", { exact: false })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Edit app", exact: true }).click();
  await page.getByText("Draft saved", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("What should it do?", { exact: true }).inputValue(),
    "[policy-notes] Each member may manage only their own notes.",
    "Edit preserves the generated candidate prompt",
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Sam Parker", exact: true })
      .isChecked(),
    true,
  );
  console.log("PASS initial autosave and candidate edit preserve content");
  const revised =
    "[policy-notes] [stall-once] Keep ownership and improve the notes board.";
  await page.getByLabel("What should it do?", { exact: true }).fill(revised);
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Generate version", exact: true })
    .click();
  await page.getByText("plan response", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Stop build", exact: true }).click();
  await page
    .getByRole("link", { name: "Start over from draft", exact: true })
    .click();
  await page.getByText("Draft saved", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("What should it do?", { exact: true }).inputValue(),
    revised,
  );
  await page
    .getByRole("button", { name: "Generate version", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .waitFor({ timeout: 60000 })
    .catch(async (e) => {
      console.log(await page.locator("main").innerText());
      throw e;
    });
  console.log(
    "PASS stopped planning can rebuild the saved edit without refreshing",
  );
} finally {
  await browser.close();
}
