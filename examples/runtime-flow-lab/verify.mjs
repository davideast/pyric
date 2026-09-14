/** Browser check for the running manual example. */
import { chromium, expect } from "@playwright/test";
import { chatListenerIds } from "./verify-data.mjs";
import { mkdir } from "node:fs/promises";
const url = process.env.FLOW_LAB_URL ?? "http://localhost:5197";
const output = process.env.FLOW_LAB_SCREENSHOTS ?? "/tmp/flow-lab-review";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  const chunks = new Set();
  page.on("request", (request) => {
    if (request.url().includes("/chunks/")) chunks.add(request.url());
  });
  page.on(
    "pageerror",
    (error) => (
      errors.push(error.message),
      console.log("PAGE ERROR", error.message)
    ),
  );
  await page.goto(url);
  await expect(page.locator("[data-deliver=messages]")).toBeVisible();
  await expect(page.locator("#treatment option")).toHaveCount(15);
  const listenerIds = await chatListenerIds(page);
  // Real subscriptions deliver their initial snapshots before the first action.
  await page.locator('#clear').click();
  await page.locator("[data-deliver=messages]").click();
  await expect(page.locator("[data-component=UnreadBadge]")).toHaveAttribute(
    "data-pyric-flow-listener",
    listenerIds.messages,
  );
  await expect(page.locator("[data-component=MessageList]")).toHaveAttribute(
    "data-pyric-flow-listener",
    listenerIds.messages,
  );
  await expect(page.locator("[data-component=MemberList]")).not.toHaveAttribute(
    "data-pyric-flow-listener",
    listenerIds.messages,
  );
  await expect(page.locator("#chat-workspace")).not.toHaveAttribute(
    "data-pyric-flow-listener",
  );
  // The chip uses the same registry, loading only the selected visual chunk.
  const picker = page.locator("[data-flow-treatment]");
  await expect(picker.locator("option")).toHaveCount(15);
  expect([...chunks].some((url) => /corners-/.test(url))).toBe(false);
  const mark = page.locator("[data-component=UnreadBadge]");
  const sequenceBefore = await mark.getAttribute("data-pyric-flow-sequence");
  await picker.selectOption("corners");
  await expect(page.locator("html")).toHaveAttribute(
    "data-pyric-treatment",
    "corners",
  );
  expect([...chunks].some((url) => /corners-/.test(url))).toBe(true);
  expect(await mark.getAttribute("data-pyric-flow-sequence")).toBe(
    sequenceBefore,
  );
  expect(
    await page.evaluate(() => localStorage.getItem("pyric:flow-treatment")),
  ).toBe("corners");
  await picker.selectOption("outline");
  await expect(page.locator("html")).toHaveAttribute(
    "data-pyric-treatment",
    "outline",
  );
  // The same live pathway must work after startup replay expires.
  const now = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(now + 120000);
  await page.locator("#clear").click();
  await page.locator("[data-deliver=presence]").click();
  await expect(page.locator("[data-component=PresenceStrip]")).toHaveAttribute(
    "data-pyric-flow-listener",
    listenerIds.presence,
  );
  await expect(page.locator("[data-component=MemberList]")).toHaveAttribute(
    "data-pyric-flow-listener",
    listenerIds.presence,
  );
  await expect(
    page.locator("[data-component=MessageList]"),
  ).not.toHaveAttribute("data-pyric-flow-listener");
  for (const source of ["typing", "receipts"]) {
    await page.locator(`#clear`).click();
    await page.locator(`[data-deliver=${source}]`).click();
    await expect(
      page.locator(`[data-pyric-flow-listener="${listenerIds[source]}"]`).first(),
    ).toBeVisible();
  }
  const variants = await page
    .locator("#treatment option")
    .evaluateAll((options) => options.map((option) => option.value));
  for (const id of variants) {
    await page.locator("#treatment").selectOption(id);
    await expect(page.locator("html")).toHaveAttribute(
      "data-pyric-treatment",
      id,
    );
    await expect(
      page.locator("#chat-workspace [data-pyric-flow]").first(),
    ).toBeVisible();
    await expect(
      page.locator("[data-pyric-flow-hits]").first(),
    ).toHaveAttribute("data-pyric-flow-hits", /\d+/);
    if (["threads", "trail", "minimap"].includes(id))
      await expect(
        page.locator(".pyric-treatment-flow-map>*").first(),
      ).toBeAttached();
  }
  await page.locator("#treatment").selectOption("threads");
  await page.locator("[data-deliver=messages]").click();
  await page.screenshot({ path: `${output}/desktop-threads.png` });
  await page.locator("#treatment").selectOption("heat");
  await page.locator("#burst").click();
  await expect(page.locator("#burst")).toBeEnabled({ timeout: 8000 });
  await page.screenshot({ path: `${output}/desktop-heat.png` });
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(await overflow()).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator("#treatment").selectOption("corners");
  await page.locator("[data-deliver=presence]").click();
  expect(await overflow()).toBe(false);
  await page.screenshot({
    path: `${output}/mobile-corners.png`,
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#treatment").selectOption("radar");
  await expect
    .poll(() =>
      page
        .locator("#chat-workspace [data-pyric-flow]")
        .first()
        .evaluate((el) => getComputedStyle(el, "::before").animationName),
    )
    .toBe("none");
  await page.locator("#inspector").click();
  await expect(page.locator(".panel")).toBeVisible();
  await page.locator("[data-collapse]").click();
  await expect(page.locator(".panel")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    "PASS: targeted renders, fan-out, idle deliveries, 15 treatments, burst, mobile overflow, reduced motion, and inspector toggle.",
  );
} finally {
  await browser.close();
}
