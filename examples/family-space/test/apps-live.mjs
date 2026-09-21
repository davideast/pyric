import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const request = await context.newPage();
  await request.goto(process.env.KIN_BASE_URL ?? 'http://127.0.0.1:5227/');
  await request.getByLabel("Email", { exact: true }).fill("emma@kin.example");
  await request
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  const [page] = await Promise.all([
    context.waitForEvent("page"),
    request.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  await page
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await page.evaluate(() => (location.hash = "apps"));
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByLabel("App name", { exact: true })
    .fill("Family kindness counter");
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill(
      "Create a very simple family kindness counter. Show one heading, a total saved in useAppData record 'counter', and a button labeled Add kindness that increments it. Use setRecord and show errors. Display the count as Count: N. Derive the count directly from records each render, never copy it into useState. Keep it under 35 lines.",
    );
  await page.getByLabel("Sam Parker", { exact: true }).check();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page.getByRole("heading", {name:"Building Family kindness counter",exact:true}).waitFor();
  await page.getByRole("navigation", {name:"Main navigation",exact:true}).getByRole("link", {name:"Family",exact:true}).click();
  await page.getByRole("heading", {name:"Our family",exact:true}).waitFor();
  await page.getByRole("complementary",{name:"App generation progress"}).waitFor();
  await page.getByRole("complementary",{name:"App generation progress"}).getByRole("link",{name:"Open app",exact:true}).waitFor({timeout:180000});
  await page.locator('.generation-bar-status').click();
  await page.getByText("React compilation passed",{exact:true}).waitFor();
  await page.locator('.generation-events summary').filter({hasText:"Writing the React app"}).click();
  await page.screenshot({path:"/tmp/kin-build-status-desktop.png"});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole("navigation",{name:"Mobile navigation"}).getByRole("link",{name:"Apps",exact:true}).waitFor();
  await page.screenshot({path:"/tmp/kin-build-status-mobile.png"});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("complementary",{name:"App generation progress"}).getByRole("link",{name:"Open app",exact:true}).click();
  await page.setViewportSize({width:1440,height:1000});
  await page
    .evaluate(async () => {
      const { db, base } = await import("/data.ts");
      const moduleText = await fetch("/data.ts").then((r) => r.text());
      const sdkPath = moduleText.match(
        /from "([^"]*entries\/firestore.js[^"]*)"/,
      )[1];
      const { getDocs, collection, query, where } = await import(sdkPath);
      return (
        await getDocs(
          query(collection(db, base + "/apps"), where("ownerId", "==", "emma")),
        )
      ).docs.map((d) => d.data());
    })
    .then(async (apps) => {
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        "/tmp/kin-live-apps.json",
        JSON.stringify(apps, null, 2),
      );
    });
  const frame = page.frameLocator('iframe[title="Family app preview"]');
  await frame
    .getByRole("button", { name: "Add kindness", exact: true })
    .waitFor({ timeout: 30000 });
  await frame
    .getByRole("button", { name: "Add kindness", exact: true })
    .click();
  await frame
    .getByText("Count: 1", { exact: true })
    .waitFor({ timeout: 15000 });
  console.log("PREVIEW", await frame.locator("body").innerText());
  await page.getByRole("button", { name: "Share app", exact: true }).click();
  await page.getByRole("button", { name: "Unshare", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/kin-generated-app.png" });
  await page.reload();

  await frame
    .getByRole("button", { name: "Add kindness", exact: true })
    .waitFor({ timeout: 30000 });
  await frame
    .getByText("Count: 1", { exact: true })
    .waitFor({ timeout: 15000 });
  console.log("RELOADED", await frame.locator("body").innerText());
  console.log(
    "PASS live AI Logic generation, React compilation, app record write, publishing, and reload",
  );
} finally {
  await browser.close();
}
