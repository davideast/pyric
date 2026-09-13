/** Geometry regression: run against the example with native anchors AND the
 * feature-detected fallback. Pixel assertions, not screenshots alone. */
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ headless: true });
try {
  for (const fallback of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (fallback)
      await page.addInitScript(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = (property, value) =>
          /anchor|position-visibility/.test(property)
            ? false
            : supports(property, value);
      });
    await page.goto(process.env.FLOW_LAB_URL ?? "http://localhost:5197");
    await page.addStyleTag({
      content: ".photo { anchor-name: --application-avatar; }",
    });
    const variants = await page
      .locator("#treatment option")
      .evaluateAll((options) => options.map((option) => option.value));
    const photo = page.locator("img[data-pyric-flow-listener=messages]").last();
    const badge = page
      .locator("[data-pyric-flow-badge][data-listener-id=messages]")
      .last();
    const photoError = async () => {
      const target = await photo.boundingBox(),
        label = await badge.boundingBox();
      if (!target || !label) return Infinity;
      return Math.max(
        Math.abs(label.x - target.x),
        Math.abs(label.y + label.height - target.y),
      );
    };
    for (const treatment of variants) {
      await page.locator("#treatment").selectOption(treatment);
      await expect(badge).toBeVisible();
      expect(
        await badge.evaluate((el) => el.hasAttribute("data-pyric-anchored")),
      ).toBe(!fallback);
      await expect.poll(photoError).toBeLessThan(2);
      await page.evaluate(() => window.scrollTo(0, 180));
      await expect.poll(photoError).toBeLessThan(2);
    }
    // Scroll inside a constrained chat container: these events do not bubble.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const chat = document.querySelector("#chat-workspace");
      const scroller = document.createElement("div");
      scroller.id = "test-scroller";
      scroller.style.cssText = "height:400px;overflow:auto;position:relative";
      chat.before(scroller);
      scroller.append(chat);
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    });
    await expect.poll(photoError).toBeLessThan(2);
    await page.locator("#test-scroller").evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - 40);
    });
    await expect.poll(photoError).toBeLessThan(2);
    // Reflow without a resize or scroll event must also move the detached label.
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "60px";
      document.querySelector("#test-scroller").before(spacer);
    });
    await expect.poll(photoError).toBeLessThan(2);
    const removedPhoto = await photo.elementHandle(),
      removedBadge = await badge.elementHandle();
    await removedPhoto.evaluate((el) => el.remove());
    await expect
      .poll(() => removedBadge.evaluate((el) => el.isConnected))
      .toBe(false);
    expect(
      await removedPhoto.evaluate((el) =>
        el.style.getPropertyValue("anchor-name"),
      ),
    ).toBe("");

    // The large displaced box is Overview. Four boxes share one target here;
    // all four must release their anchor without disturbing the app's name.
    await page
      .locator("#chat-workspace")
      .evaluate((el) =>
        el.style.setProperty("anchor-name", "--application-chat", "important"),
      );
    await page.locator("[data-listener-all]").click();
    const outline = page.locator("[data-pyric-listener-box]").first();
    const outlineError = async () => {
      const target = await page.locator("#chat-workspace").boundingBox(),
        box = await outline.boundingBox();
      if (!target || !box) return Infinity;
      return Math.max(
        Math.abs(box.x - target.x),
        Math.abs(box.y - target.y),
        Math.abs(box.width - target.width),
        Math.abs(box.height - target.height),
      );
    };
    expect(
      await outline.evaluate((el) => el.hasAttribute("data-pyric-anchored")),
    ).toBe(!fallback);
    await expect.poll(outlineError).toBeLessThan(2);
    await page.evaluate(() => window.scrollTo(0, 250));
    await expect.poll(outlineError).toBeLessThan(2);
    await page.locator("#test-scroller").evaluate((el) => {
      el.scrollTop += 30;
    });
    await expect.poll(outlineError).toBeLessThan(2);
    await page.locator("#chat-workspace").evaluate((el) => {
      el.style.minHeight = "700px";
    });
    await expect.poll(outlineError).toBeLessThan(2);
    await page.locator("[data-listener-all]").click();
    expect(
      await page
        .locator("#chat-workspace")
        .evaluate((el) => [
          el.style.getPropertyValue("anchor-name"),
          el.style.getPropertyPriority("anchor-name"),
        ]),
    ).toEqual(["--application-chat", "important"]);
    await expect(page.locator("[data-pyric-listener-overlay]")).toHaveCount(0);
    expect(errors).toEqual([]);
    console.log(
      `PASS ${fallback ? "measured fallback" : "native CSS anchors"}: 15 treatments, page/nested scroll, reflow, resizing, removed photos, and shared-anchor restoration`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
