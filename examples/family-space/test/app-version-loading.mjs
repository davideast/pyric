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
  const ids = await page.evaluate(async () =>
    (await import("/test/version-loading-fixture.ts")).seedVersions(),
  );
  await page.evaluate((id) => {
    location.hash = "apps/" + id + "/version/version-0";
  }, ids[0]);
  await page
    .frameLocator('iframe[title="Family app preview"]')
    .getByText("Saved content 0")
    .waitFor({ timeout: 30000 });
  await page.evaluate((id) => {
    location.hash = "apps/" + id;
  }, ids[1]);
  await page
    .getByRole("heading", { name: "Existing app 1", exact: true })
    .waitFor();
  await page
    .frameLocator('iframe[title="Family app preview"]')
    .getByText("Saved content 1")
    .waitFor({ timeout: 10000 });
  assert.equal(
    await page
      .getByText(
        "No generated version yet. Continue your draft to build this app.",
        { exact: true },
      )
      .count(),
    0,
  );
  console.log("PASS switching existing apps loads their own saved version");
  await page.evaluate((id) => {
    location.hash = "apps/" + id;
  }, ids[2]);
  await page
    .getByRole("alert")
    .getByText("Saved source for Version 1 is missing.", { exact: true })
    .waitFor()
    .catch(async (e) => {
      console.log(await page.locator("main").innerText());
      throw e;
    });
  assert.equal(
    await page
      .getByText(
        "No generated version yet. Continue your draft to build this app.",
        { exact: true },
      )
      .count(),
    0,
  );
  await page.evaluate(
    async (id) =>
      (await import("/test/version-loading-fixture.ts")).restoreMissingSource(
        id,
      ),
    ids[2],
  );
  await page
    .getByRole("button", { name: "Retry loading", exact: true })
    .click();
  await page
    .frameLocator('iframe[title="Family app preview"]')
    .getByText("Recovered saved content")
    .waitFor({ timeout: 30000 });
  console.log(
    "PASS missing artifact is reported and Retry loads the recovered saved source",
  );
} finally {
  await browser.close();
}
