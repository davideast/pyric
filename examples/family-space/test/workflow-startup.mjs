import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext();
  context.setDefaultTimeout(30000);
  context.on("page", (p) => {
    p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
    p.on("console", (m) => {
      if (m.type() === "error" || m.text().includes("vite"))
        console.log(m.text().slice(0, 300));
    });
  });
  await context.addInitScript(() => {
    const Native = SharedWorker;
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
  [page] = await Promise.all([
    context.waitForEvent("page"),
    login.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  await page
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  await login.close();
  await page.goto(new URL("/#apps", page.url()).href);
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByLabel("App name", { exact: true })
    .fill("Startup failure fixture");
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("[startup-failure] A family kindness counter");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("button", { name: "Retry stage", exact: true })
    .waitFor({ timeout: 120000 });
  await page
    .getByText("missingBinding is not defined", { exact: false })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open app", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("Stage: startup", { exact: true }).count(),
    3,
  );
  console.log(
    "PASS runtime failure retained its diagnostic and stopped after two repairs without publishing a candidate",
  );
} catch (e) {
  if (page) console.log((await page.locator("body").innerText()).slice(-10000));
  throw e;
} finally {
  await browser.close();
}
