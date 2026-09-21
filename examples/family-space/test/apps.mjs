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
  const source = `import {useState} from 'react'; import {useAppData} from '@kin/app';
export default function App() {
 const [label]=useState('Kindness'); const {records,setRecord,error}=useAppData();
 const count=records.find(r=>r.id==='counter')?.count||0;
 return <main style={{padding:24}}><h1>{label}</h1><p role="status">Count: {count}</p><button onClick={()=>setRecord('counter',{count:count+1})}>Add kindness</button><p>{error}</p></main>;
}`;
  await page.evaluate(async (source) => {
    const { db, base } = await import("/data.ts");
    const moduleText = await fetch("/data.ts").then((r) => r.text());
    const sdkPath = moduleText.match(
      /from "([^"]*entries\/firestore.js[^"]*)"/,
    )[1];
    const { setDoc, doc } = await import(sdkPath);
    await setDoc(doc(db, base + "/apps/browser-counter"), {
      ownerId: "emma",
      title: "Browser counter",
      prompt: "Counter",
      source,
      context: '{"family":"Parkers"}',
      audience: ["emma", "sam"],
      createdAt: Date.now(),
      published: false,
    });
  }, source);
  await page.evaluate(() => (location.hash = "apps"));
  await page.getByRole("button", { name: /Browser counter/ }).click();
  const frame = page.frameLocator('iframe[title="Family app preview"]');
  await frame
    .getByRole("button", { name: "Add kindness" })
    .waitFor({ timeout: 30000 });
  await frame.getByRole("button", { name: "Add kindness" }).click();
  await frame.getByRole("status").filter({ hasText: "Count: 1" }).waitFor();
  const iframe = page.frames().find((f) => f.url() === "about:srcdoc");
  assert.equal(
    await iframe.evaluate(() => {
      try {
        return !!parent.document;
      } catch {
        return false;
      }
    }),
    false,
    "Preview cannot access signed-in host",
  );
  assert.equal(
    await iframe.evaluate(async () => {
      try {
        await fetch(location.origin + "/");
        return true;
      } catch {
        return false;
      }
    }),
    false,
    "Preview cannot make direct network calls",
  );
  await page.getByRole("button", { name: "Share app", exact: true }).click();
  await page.getByRole("button", { name: "Unshare", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/kin-app-builder.png" });
  await page.reload();
  await frame
    .getByRole("status")
    .filter({ hasText: "Count: 1" })
    .waitFor({ timeout: 30000 });
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"Mobile app view fits its viewport");
  await page.screenshot({path:"/tmp/kin-app-mobile.png"});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("sam@kin.example");
  await page
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  const [kid] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  await kid.getByRole("heading", { name: "Our family", exact: true }).waitFor();
  await kid.evaluate(() => (location.hash = "apps"));
  await kid.getByRole("button", { name: /Browser counter/ }).click();
  assert.equal(
    await kid.getByRole("button", { name: "Create app", exact: true }).count(),
    0,
  );
  const kidFrame = kid.frameLocator('iframe[title="Family app preview"]');
  await kidFrame
    .getByRole("status")
    .filter({ hasText: "Count: 1" })
    .waitFor({ timeout: 30000 });
  await kidFrame.getByRole("button", { name: "Add kindness" }).click();
  await kidFrame.getByRole("status").filter({ hasText: "Count: 2" }).waitFor();
  console.log(
    "PASS isolated React preview, live Firestore writes, sharing, reload and selected kid editing",
  );
} finally {
  await browser.close();
}
