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

  await page.evaluate(async () => {
    const { db, base } = await import("/data.ts");
    const text = await fetch("/data.ts").then((r) => r.text());
    const sdk = text.match(/from "([^"]*entries\/firestore.js[^"]*)"/)[1];
    const { setDoc, doc } = await import(sdk);
    const source =
      "export default function App(){return <h1>Legacy dinner</h1>}";
    const spec = {
      id: crypto.randomUUID(),
      ownerId: "emma",
      title: "Legacy dinner",
      prompt: "Dinner",
      source,
      context: "{}",
      audience: ["emma"],
      createdAt: 1,
      checkpoint: source,
    };
    await setDoc(doc(db, base + "/apps/" + spec.id), {
      ownerId: "emma",
      title: spec.title,
      prompt: spec.prompt,
      source,
      context: "{}",
      audience: ["emma"],
      createdAt: 1,
      published: false,
    });
    const { generationClient } = await import("/durable-generation.ts");
    const result = await generationClient().start(spec);
    localStorage.setItem("kin:generation:emma", result.jobId);
  });
  await page.reload();
  await page
    .locator(".generation-bar strong")
    .filter({ hasText: "Ready: Legacy dinner" })
    .waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Dismiss build progress" }).click();
  await page.reload();
  assert.equal(await page.locator(".generation-bar").count(), 0);
  console.log(
    "PASS completed pre-versioning build does not remain running and dismissal survives reload",
  );
} finally {
  await browser.close();
}
