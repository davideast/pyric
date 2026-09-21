import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
const origin = process.env.KIN_BASE_URL ?? "http://127.0.0.1:5227/";
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
  await page.evaluate(async () => {
    const { db, base } = await import("/data.ts");
    const text = await fetch("/data.ts").then((r) => r.text());
    const path = text.match(/from "([^"]*entries\/firestore.js[^"]*)"/)[1];
    const { setDoc, doc } = await import(path);
    await setDoc(doc(db, base + "/apps/recovery-test"), {
      ownerId: "emma",
      title: "Recovery test",
      prompt: "Counter",
      source:
        "export default function App(){const data=useAppData();return <p>{data.records.length}</p>}",
      context: "{}",
      audience: ["emma"],
      createdAt: 1,
      published: false,
    });
    await setDoc(doc(db, base + "/apps/recovery-test/records/counter"), {
      count: 7,
    });
  });
  await page.goto(origin + "#apps/recovery-test");
  await page.getByText("This app needs a repair", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Share app", exact: true })
      .isDisabled(),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "/tmp/kin-recovery-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/kin-recovery-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByText("This app needs a repair", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Repair app", exact: true }).click();
  try {
    await page
      .locator(".generation-bar")
      .getByRole("link", { name: "Open app", exact: true })
      .click({ timeout: 30000 });
  } catch (e) {
    console.log(await page.locator("body").innerText());
    throw e;
  }
  await page.getByText("App started successfully", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .waitFor({ state: "hidden" });
  for (const width of [1440, 1100, 800, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => {
      const a = document.querySelector(".main-content").getBoundingClientRect();
      const b = document
        .querySelector(".generation-bar")
        .getBoundingClientRect();
      return Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1;
    });
    if (width === 1440 || width === 390)
      await page.screenshot({ path: `/tmp/kin-bar-${width}.png` });
  }

  const frame = page.frameLocator('iframe[title="Family app preview"]');
  await frame.getByText("Count: 7", { exact: true }).waitFor();
  await frame
    .getByRole("button", { name: "Add kindness", exact: true })
    .click();
  await frame.getByText("Count: 8", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("App started successfully", { exact: true }).waitFor();
  await page
    .frameLocator('iframe[title="Family app preview"]')
    .getByText("Count: 8", { exact: true })
    .waitFor();
  console.log(
    "PASS runtime failure, sharing gate, retry, durable repair, records preserved, reload",
  );
} finally {
  await browser.close();
}
