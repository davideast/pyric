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
  page.on("pageerror", (e) => console.log("PAGE", e.message));
  await page.goto(new URL("/#apps", page.url()).href);
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByLabel("App name", { exact: true })
    .fill("Generated policy quest");
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill(
      "[policy-chore] Parents manage chores; kids complete only their own assigned chores.",
    );
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .waitFor({ timeout: 60000 });
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .click();
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 20000 });
  await page
    .getByText("Policy checks passed", { exact: false })
    .first()
    .waitFor();
  // Regenerate an unactivated candidate: retain its policy from version artifacts.
  await page.getByRole("button", { name: "Edit app", exact: true }).click();
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill(
      "[policy-chore] Keep the chore permissions and improve the quest board.",
    );
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Generate version", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .waitFor({ timeout: 60000 });
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .click();
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 20000 });
  await page
    .getByText("App policy · Policy checks passed", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .waitFor({ state: "hidden" });
  await page.reload();
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 20000 });
  await page
    .getByText("App policy · Policy checks passed", { exact: true })
    .click();
  await page
    .getByText('"sandboxPassed": 28', { exact: false })
    .first()
    .waitFor();
  console.log(
    "PASS generated policy prepared, sandbox validated, saved, activated, and retained after reload",
  );
} finally {
  await browser.close();
}
