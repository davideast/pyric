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
      templates.find((t) => t.id === "chore-quest"),
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

  await f.getByRole("button", { name: "Add sample chores" }).click();
  await f
    .getByRole("checkbox", { name: "Water the plants", exact: true })
    .click();
  await f.getByText("Quest complete! +10 stars", { exact: true }).waitFor();
  await f.getByRole("button", { name: "All (3)", exact: true }).click();
  await f
    .getByRole("checkbox", { name: "Water the plants", exact: true })
    .click();
  await f.getByText("0 stars", { exact: true }).waitFor();
  const longName =
    "A very long chore name that still keeps its checkbox and action neatly aligned";
  await f.getByLabel("Chore", { exact: true }).fill(longName);
  await f.getByRole("button", { name: "Add chore", exact: true }).click();
  await f.getByRole("checkbox", { name: longName, exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    const geometry = await f.locator(".quest-card").evaluateAll((rows) =>
      rows.map((row) => {
        const a = row.querySelector("input").getBoundingClientRect(),
          b = row.querySelector("label>.quest-stack").getBoundingClientRect(),
          c = row.querySelector("button").getBoundingClientRect();
        return (
          Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < 1 &&
          Math.abs(a.y + a.height / 2 - c.y - c.height / 2) < 1
        );
      }),
    );
    assert.ok(geometry.every(Boolean));
    assert.ok(
      await f
        .locator(".quest-title[title]")
        .last()
        .evaluate((e) => e.scrollWidth > e.clientWidth),
    );
    const iframe = page.frames().find((x) => x !== page.mainFrame());
    assert.ok(
      await iframe.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await f.locator("main").evaluate((e) => e.scrollIntoView());
    await page.screenshot({
      path: "/tmp/chore-quest-" + width + ".png",
      fullPage: true,
    });
  }
  await f
    .getByRole("checkbox", { name: "Water the plants", exact: true })
    .click();
  await f.getByText("10 stars", { exact: true }).waitFor();
  await page.reload();
  await page
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 30000 });
  await f.getByText("10 stars", { exact: true }).waitFor();
  console.log(
    "PASS Chore Quest completion, undo, saved progress, responsive alignment and ellipsis",
  );
} finally {
  await browser.close();
}
