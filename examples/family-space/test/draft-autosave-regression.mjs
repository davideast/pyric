import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...args) {
      if (window.__kinTestLatency && message?.t === "op") {
        setTimeout(
          () => send.call(this, message, ...args),
          window.__kinTestLatency,
        );
      } else send.call(this, message, ...args);
    };
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
  await page.evaluate(() => {
    window.__kinTestLatency = 75;
  });
  await page
    .getByLabel("App name", { exact: true })
    .pressSequentially("Generated notes", { delay: 10 });
  await page
    .getByLabel("What should it do?", { exact: true })
    .pressSequentially(
      "[policy-notes] Each member may manage only their own notes.",
      { delay: 5 },
    );
  await page
    .getByText("Draft saved", { exact: true })
    .waitFor({ timeout: 5000 });
  console.log(
    "PASS typing finishes autosaving promptly over a delayed transport",
  );
} finally {
  await browser.close();
}
