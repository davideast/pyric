import { chromium } from "playwright";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const origin = process.env.KIN_URL ?? "http://127.0.0.1:5227/";
(async () => {
  const b = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const c = await b.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["microphone"],
  });
  let p = await c.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(origin);
  async function login(name) {
    await p.evaluate(() => (location.hash = "feed"));
    await p.getByLabel("Email", { exact: true }).fill(name + "@kin.example");
    await p
      .getByRole("button", { name: "Send sign-in link", exact: true })
      .click();
    const previous = p;
    const [next] = await Promise.all([
      c.waitForEvent("page"),
      p.getByRole("link", { name: "Open sign-in link", exact: true }).click(),
    ]);
    p = next;
    p.on("pageerror", (e) => errors.push(e.message));
    await p.getByRole("heading", { name: "Our family", exact: true }).waitFor();
    await previous.close();
    await p.getByRole("heading", { name: "Our family", exact: true }).waitFor();
    await p.locator(".post-card").first().waitFor();
  }
  async function logout() {
    await p.locator(".sign-out").click();
    await p
      .getByRole("button", { name: "Send sign-in link", exact: true })
      .waitFor();
  }
  async function route(hash) {
    await p.evaluate((h) => (location.hash = h), hash);
  }
  await login("sam");
  assert.equal(await p.locator("[role=alert]").count(), 0);
  await p.getByRole("button", { name: "New post", exact: true }).click();
  await p.getByRole("button", { name: "Article", exact: true }).click();
  await p.getByLabel("Title", { exact: true }).fill("A tiny victory");
  await p
    .getByLabel("Article", { exact: true })
    .fill("I finished my puzzle today.");
  await p.getByRole("button", { name: "Send for review" }).click();
  await p.getByText("Awaiting review", { exact: true }).waitFor();
  const hash = await p.evaluate(() => location.hash);
  console.log("kid draft", hash);
  await logout();
  await login("emma");
  await route("review");
  await p.getByRole("heading", { name: "A tiny victory", exact: true }).click();
  await p.getByRole("checkbox", { name: "Sam", exact: true }).check();
  await p.getByRole("button", { name: "Approve & publish" }).click();
  await p.getByRole("button", { name: "Save audience" }).waitFor();
  console.log("approved for Sam");
  await logout();
  await login("zoe");
  await route(hash);
  await p
    .getByRole("heading", { name: "This post is not available", exact: true })
    .waitFor();
  console.log("sibling cannot read personalized post");
  await logout();
  await login("sam");
  await route(hash);
  await p.getByText("Marked as viewed", { exact: true }).waitFor();
  await p.getByLabel("Write a comment").fill("Thanks for reading!");
  await p.getByRole("button", { name: "Send", exact: true }).click();
  await p.getByText("Thanks for reading!", { exact: true }).waitFor();
  console.log("view/comment");
  await route("mine");
  await p
    .getByRole("heading", {
      name: "Sam, a small challenge for this week",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await p
      .getByRole("heading", {
        name: "Zoe, your afternoon dance break",
        exact: true,
      })
      .count(),
    0,
  );
  await route("chat");
  await p.getByLabel("Family chat message").fill("Browser-tested family hello");
  await p.getByRole("button", { name: "Send", exact: true }).click();
  await p.getByText("Browser-tested family hello", { exact: true }).waitFor();
  await p
    .getByLabel("Attach photo, video, or audio")
    .setInputFiles(
      fileURLToPath(new URL("../public/assets/dog.png", import.meta.url)),
    );
  await p.getByRole("button", { name: "Send", exact: true }).click();
  await p.locator(".chat-message-content img").waitFor();
  await p.waitForFunction(
    () => document.querySelector(".chat-message-content img")?.naturalWidth > 0,
  );
  console.log("chat photo");
  await p
    .getByLabel("Attach photo, video, or audio")
    .setInputFiles(
      fileURLToPath(new URL("../public/assets/flower.mp4", import.meta.url)),
    );
  await p.getByRole("button", { name: "Send", exact: true }).click();
  await p.waitForFunction(
    () => document.querySelector("video")?.readyState >= 1,
  );
  console.log("chat video");
  await p.getByRole("button", { name: "Voice", exact: true }).click();
  await p.getByRole("button", { name: "Stop recording" }).waitFor();
  await p.waitForTimeout(700);
  await p.getByRole("button", { name: "Stop recording" }).click();
  await p.getByText("Voice message ready").waitFor();
  await p.getByRole("button", { name: "Send", exact: true }).click();
  await p.locator("audio").waitFor();
  await p.waitForFunction(
    () => document.querySelector("audio")?.readyState >= 1,
  );
  await p.screenshot({ path: "/tmp/kin-test-chat.png" });
  console.log("chat voice");
  await route("schedule");
  for (const mode of ["Day", "Week", "Month"]) {
    await p.getByRole("button", { name: mode, exact: true }).click();
    assert.equal(
      await p
        .getByRole("button", { name: mode, exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
  }
  await p.screenshot({ path: "/tmp/kin-test-calendar.png" });
  await logout();
  await login("emma");
  await route(hash);
  await p.getByText("Viewed by Sam", { exact: true }).waitFor();
  console.log("parent sees viewer");
  await route("feed");
  await p.setViewportSize({ width: 390, height: 844 });
  await p.screenshot({ path: "/tmp/kin-test-mobile.png" });
  await route("chat");
  await p.getByText("Strawberries, please!", { exact: true }).waitFor();
  await p.screenshot({ path: "/tmp/kin-test-mobile-chat.png" });
  const overflow = await p.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert.equal(overflow, false);
  assert.equal(await p.locator("[role=alert]").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS all journeys");
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
