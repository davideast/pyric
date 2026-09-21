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
  await page.getByLabel("App name", { exact: true }).fill("Checkpoint counter");
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("A family kindness counter");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByText("Stage: code", { exact: true })
    .first()
    .waitFor({ timeout: 60000 });
  const follower = await context.newPage();
  await follower.goto(new URL("/#build", page.url()).href);
  await follower
    .getByRole("button", { name: "Stop build", exact: true })
    .waitFor();
  await follower.close();
  await page
    .getByText("Stage: compile", { exact: true })
    .first()
    .waitFor({ timeout: 60000 });
  const cdp = await context.newCDPSession(page),
    targets = await cdp.send("Target.getTargets");
  const worker = targets.targetInfos.find(
    (t) => t.type === "shared_worker" && t.url.includes("resumable-worker"),
  );
  assert.ok(worker);
  await cdp.send("Target.closeTarget", { targetId: worker.targetId });
  await page.evaluate(() => localStorage.removeItem("kin:generation:emma"));
  await page.reload();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  assert.equal(await page.locator(".generation-bar .spinning").count(), 0);
  console.log(
    "PASS interrupted build discovered without its local pointer; waiting for lease expiry",
  );
  await page.waitForTimeout(61000);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page
    .locator(".generation-bar")
    .getByRole("link", { name: "Open app", exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(
    await page.getByText("code response", { exact: true }).count(),
    1,
    "completed model output was not regenerated",
  );
  await page
    .locator(".generation-bar")
    .getByRole("link", { name: "Open app", exact: true })
    .click();
  await page.getByText("App started successfully", { exact: true }).waitFor();
  console.log(
    "PASS explicit resume restored source, checked startup and saved one ready candidate",
  );
} catch (e) {
  if (page) console.log((await page.locator("body").innerText()).slice(-10000));
  throw e;
} finally {
  await browser.close();
}
