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
  await page.goto(origin + "#apps");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page.getByLabel("App name", { exact: true }).fill("Durable counter");
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("A counter");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  try {
    await page
      .getByText("Writing the React app", { exact: true })
      .first()
      .waitFor();
  } catch (e) {
    console.log(await page.locator(".generation-events").textContent());
    throw e;
  }
  const pointer = await page.evaluate(() =>
    localStorage.getItem("kin:generation:emma"),
  );
  // Reload during generation: same job, no new upstream call.
  await page.reload();
  const continuation = await context.newPage();
  await continuation.goto(origin + "#build");
  await continuation
    .getByText("Writing the React app", { exact: true })
    .first()
    .waitFor();
  await page.close();
  page = continuation;
  await page
    .getByText("Checking React compilation", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("kin:generation:emma")),
    pointer,
  );
  // Kill the worker after the model output checkpoint, then reload. Recovery
  // recompiles that source without generating again, and retains the same app ID.
  const cdp = await context.newCDPSession(page);
  const targets = await cdp.send("Target.getTargets");
  const workerTarget = targets.targetInfos.find(
    (t) => t.type === "shared_worker" && t.url.includes("resumable-worker"),
  );
  assert.ok(workerTarget, "SharedWorker target exists");
  await cdp.send("Target.closeTarget", { targetId: workerTarget.targetId });
  await page.waitForTimeout(300);
  await page.reload();
  try {
    await page
      .getByText("Resuming your build", { exact: true })
      .waitFor({ timeout: 12000 });
  } catch (e) {
    console.log(
      "RECOVERY",
      await page.locator("body").innerText(),
      await page.locator(".generation-detail").allTextContents(),
    );
    throw e;
  }
  await page
    .locator(".generation-bar")
    .getByRole("link", { name: "Open app", exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(
    await page
      .locator(".generation-events summary")
      .filter({ hasText: "Writing the React app" })
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator(".generation-events li")
      .filter({ hasText: "Selecting UI patterns" })
      .count(),
    1,
  );
  await page.getByText("check_ui_plan", { exact: true }).waitFor();
  await page.getByText("read_ui", { exact: true }).waitFor();
  const link = await page
    .locator(".generation-bar")
    .getByRole("link", { name: "Open app", exact: true })
    .getAttribute("href");
  const follower = await context.newPage();
  await follower.goto(origin + "#build");
  await follower
    .locator(".generation-bar")
    .getByRole("link", { name: "Open app", exact: true })
    .waitFor();
  assert.equal(
    await follower.locator(".generation-bar a.primary").getAttribute("href"),
    link,
  );
  await page.close();
  await follower.reload();
  await follower.locator(".generation-bar a.primary").click();
  await follower
    .getByText("App started successfully", { exact: true })
    .waitFor();
  await follower
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await follower
    .getByRole("button", { name: "Use this version", exact: true })
    .waitFor({ state: "hidden" });
  const frame = follower.frameLocator('iframe[title="Family app preview"]');
  await frame
    .getByRole("button", { name: "Add kindness", exact: true })
    .click();
  await frame.getByText("Count: 1", { exact: true }).waitFor();
  await follower.goto(origin + "#feed");
  await follower
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  await follower.goto(origin + "#apps");
  await follower
    .getByRole("button", { name: "Create app", exact: true })
    .click();
  await follower.getByLabel("App name", { exact: true }).fill("Stop me");
  await follower
    .getByLabel("What should it do?", { exact: true })
    .fill("Counter");
  await follower
    .getByRole("button", { name: "Create app", exact: true })
    .click();
  await follower
    .getByText("Writing the React app", { exact: true })
    .first()
    .waitFor();
  await follower
    .getByRole("button", { name: "Stop build", exact: true })
    .click();
  await follower
    .getByRole("heading", { name: "Build: Stop me", exact: true })
    .waitFor();
  await follower.reload();
  await follower
    .getByRole("heading", { name: "Build: Stop me", exact: true })
    .waitFor();
  assert.equal(await follower.locator(".generation-bar a.primary").count(), 0);
  // Explicit sign-out must not expose the parent's log to the next identity.
  await follower.getByRole("button", { name: "Sign out", exact: true }).click();
  await follower.locator(".generation-bar").waitFor({ state: "detached" });
  assert.equal(await follower.locator(".generation-bar").count(), 0);
  console.log(
    "PASS durable worker reload, killed-worker checkpoint recovery, cross-tab replay, saved app, and identity isolation",
  );
} finally {
  await browser.close();
}
