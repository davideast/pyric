// Verify shipped samples through Kin's normal create-copy and iframe workflow.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const catalog = JSON.parse(
  await readFile(new URL("../templates/catalog.json", import.meta.url)),
);
const browser = await chromium.launch();
const origin = process.env.KIN_BASE_URL ?? "http://127.0.0.1:5227/";
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const login = await context.newPage();
  await login.goto(origin);
  await login.getByLabel("Email", { exact: true }).fill("emma@kin.example");
  await login
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  const [page] = await Promise.all([
    context.waitForEvent("page"),
    login.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  page.on("console", (msg) => {
    if (msg.type() === "error")
      console.log("BROWSER", msg.text().slice(0, 180));
  });
  await page
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  await login.close();
  await page.goto(origin + "#apps");
  await page
    .getByRole("button", { name: "Use Dinner Spinner template", exact: true })
    .waitFor();
  assert.equal(await page.locator(".template-row").count(), 10);
  assert.equal(
    await page
      .locator(".template-group")
      .first()
      .locator(".template-row")
      .count(),
    7,
  );
  await page.screenshot({
    path: "/tmp/kin-templates-desktop.png",
    fullPage: true,
  });

  await page.evaluate(async () => {
    const templates = await fetch("/app-templates.json").then((r) => r.json());
    const { useTemplate } = await import("/template-store.ts");
    const app = await useTemplate(
      templates.find((t) => t.id === "dinner-spinner"),
      { id: "emma", role: "parent" },
      [{ id: "emma", role: "parent" }],
      [],
      [],
    );
    location.hash = "apps/" + app.id;
  });
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 30000 });
  const f = page.frameLocator('iframe[title="Family app preview"]');
  await f.getByRole("button", { name: "Add sample dinners" }).click();
  await f.getByRole("checkbox", { name: "Pasta and salad" }).waitFor();
  const longName = "A very long dinner name for the whole family with extra toppings and sides";
  await f.getByLabel("Dinner option", {exact:true}).fill(longName);
  await f.getByRole("button", {name:"Add dinner",exact:true}).click();
  await f.getByRole("checkbox", {name:longName,exact:true}).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({width,height:1000});
    const layout=await f.locator(".dinner-row").evaluateAll(rows=>rows.map(row=>{
      const input=row.querySelector("input"),text=row.querySelector("span"),button=row.querySelector("button");
      const a=input.getBoundingClientRect(),b=text.getBoundingClientRect(),c=button.getBoundingClientRect();
      return {aligned:Math.abs(a.y+a.height/2-b.y-b.height/2)<1&&Math.abs(b.y+b.height/2-c.y-c.height/2)<1,right:b.x>=a.right,ellipsis:getComputedStyle(text).textOverflow,truncated:text.scrollWidth>text.clientWidth};
    }));
    assert.ok(layout.every(r=>r.aligned&&r.right&&r.ellipsis==="ellipsis"));
    assert.ok(layout.some(r=>r.truncated));
  }
  await page.setViewportSize({width:1440,height:1100});

  await f.getByRole("button", { name: "Spin dinner", exact: true }).click();
  await f.getByRole("button", { name: "Spinning…" }).waitFor();
  assert.equal(
    await f.getByRole("button", { name: "Spinning…" }).isDisabled(),
    true,
  );
  await f
    .getByText("Tonight’s winner", { exact: true })
    .waitFor({ timeout: 12000 });
  assert.equal(await f.locator(".dinner-confetti i").count(), 64);
  const result = await f.locator(".dinner-wheel svg").evaluate((svg) => {
    const m = new DOMMatrix(getComputedStyle(svg).transform);
    const degrees = ((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360;
    const index = Math.floor(((360 - degrees) % 360) / (360/svg.querySelectorAll("text").length));
    return {
      selected: svg
        .querySelectorAll("text")
        [index].textContent.replace(/(.+)\1/, "$1"),
      winner: document.querySelector(".dinner-outcome h2").textContent,
    };
  });
  assert.equal(result.selected, result.winner);
  await f.locator("main").evaluate((e) => e.scrollIntoView());
  await page.screenshot({
    path: "/tmp/dinner-wheel-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await f.locator("main").evaluate((e) => e.scrollIntoView());
  await page.screenshot({
    path: "/tmp/dinner-wheel-mobile.png",
    fullPage: true,
  });
  const iframe = page.frames().find((frame) => frame !== page.mainFrame());
  assert.ok(
    await iframe.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await f.getByRole("button", { name: "Spin dinner", exact: true }).click();
  await f.getByRole("button", { name: "Spin dinner", exact: true }).waitFor();
  assert.equal(await f.locator(".dinner-confetti").count(), 0);
  await page.reload();
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 30000 });
  await f.getByText("Last saved pick:", { exact: false }).waitFor();
  console.log(
    "PASS wheel lands on its announced winner; confetti, reduced motion, responsive layout and saved result",
  );
} finally {
  await browser.close();
}
