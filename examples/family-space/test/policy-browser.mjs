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
    .waitFor({ timeout: 15000 })
    .catch(async (e) => {
      console.log(await page.locator("body").innerText());
      throw e;
    });
  const f = page.frameLocator('iframe[title="Family app preview"]');

  const appUrl = page.url();
  await page.evaluate(async () => {
    const { db, base } = await import("/data.ts");
    const sdk = (await fetch("/data.ts").then((r) => r.text())).match(
      /from "([^"]*entries\/firestore.js[^"]*)"/,
    )[1];
    const { doc, updateDoc } = await import(sdk);
    const id = location.hash.split("/")[1];
    await updateDoc(doc(db, base + "/apps/" + id), {
      published: false,
      audience: ["emma", "sam", "zoe"],
    });
    await updateDoc(doc(db, base + "/apps/" + id), { published: true });
  });
  await f.getByLabel("Chore", { exact: true }).fill("Sam chore");
  // Test context exposes only Emma, so assign the fixture using the public bridge.
  const request = async (frame, op, id, data) =>
    frame.evaluate(
      ({ op, id, data }) =>
        new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          const listener = (e) => {
            if (
              e.data?.kind === "kin-data-result" &&
              e.data.requestId === requestId
            ) {
              removeEventListener("message", listener);
              resolve(e.data);
            }
          };
          addEventListener("message", listener);
          parent.postMessage(
            {
              kind: "kin-data",
              token: globalThis.__kinToken,
              requestId,
              op,
              id,
              data,
            },
            "*",
          );
        }),
      { op, id, data },
    );
  let frame = page.frames().find((x) => x !== page.mainFrame());
  assert.equal(
    (
      await request(frame, "set", "sam-chore", {
        title: "Sam chore",
        assigneeId: "sam",
        completed: false,
        extra: "keep",
      })
    ).error,
    undefined,
  );
  assert.equal(
    (
      await request(frame, "set", "zoe-chore", {
        title: "Zoe chore",
        assigneeId: "zoe",
        completed: false,
      })
    ).error,
    undefined,
  );

  await page.evaluate(async () => {
    const { db, base, auth } = await import("/data.ts");
    const sdk = (await fetch("/data.ts").then((r) => r.text())).match(
      /from "([^"]*entries\/firestore.js[^"]*)"/,
    )[1];
    const { doc, getDoc, updateDoc } = await import(sdk);
    const { writePolicyRecord } = await import("/policy-bridge.ts");
    const { saveGeneratedVersion, activateVersion, listVersions } =
      await import("/app-versions.ts");
    const id = location.hash.split("/")[1],
      ref = doc(db, base + "/apps/" + id),
      root = (await getDoc(ref)).data();
    const assertCode = async (code, run) => {
      try {
        await run();
        throw Error("Expected " + code);
      } catch (e) {
        if (e.code !== code) throw e;
      }
    };
    const write = (version, valid = () => true) =>
      writePolicyRecord(
        db,
        base,
        id,
        version,
        auth.currentUser.uid,
        valid,
        "set",
        "sam-chore",
        {
          title: "Sam chore",
          assigneeId: "sam",
          completed: true,
          extra: "keep",
        },
      );
    for (let i = 0; i < 5; i++) {
      await updateDoc(doc(db, base + "/apps/" + id + "/records/sam-chore"), {
        title: "Sam chore",
        assigneeId: "sam",
        completed: false,
        extra: "keep",
      });
      const raced = await Promise.allSettled([
        writePolicyRecord(
          db,
          base,
          id,
          root.activeVersionId,
          auth.currentUser.uid,
          () => true,
          "set",
          "sam-chore",
          {
            title: "Sam chore",
            assigneeId: "zoe",
            completed: false,
            extra: "keep",
          },
        ),
        writePolicyRecord(
          db,
          base,
          id,
          root.activeVersionId,
          "sam",
          () => true,
          "set",
          "sam-chore",
          {
            title: "Sam chore",
            assigneeId: "sam",
            completed: true,
            extra: "keep",
          },
        ),
      ]);
      if (raced[0].status !== "fulfilled")
        throw Error("Parent reassignment failed");
      const saved = (
        await getDoc(doc(db, base + "/apps/" + id + "/records/sam-chore"))
      ).data();
      if (saved.assigneeId !== "zoe" || saved.completed !== false)
        throw Error("Concurrent child write overwrote reassignment");
    }
    await updateDoc(doc(db, base + "/apps/" + id + "/records/sam-chore"), {
      assigneeId: "sam",
      completed: false,
    });
    await assertCode("stale-version", () => write("older-version"));
    await assertCode("session", () => write(root.activeVersionId, () => false));
    const legacyBuild = crypto.randomUUID();
    await updateDoc(ref, { policy: null });
    try {
      await assertCode("invalid-policy", () => write(root.activeVersionId));
      await saveGeneratedVersion(
        { id, buildId: legacyBuild },
        { ...root, id, policy: null },
      );
    } finally {
      await updateDoc(ref, { policy: root.policy });
    }
    const policyless = (await listVersions(id)).find(
      (v) => v.id === legacyBuild,
    );
    let blocked = false;
    try {
      await activateVersion(id, policyless, root.activeVersionId);
    } catch (e) {
      blocked = e.message.includes("without a policy");
    }
    if (!blocked) throw Error("Policyless rollback was not blocked");
    const app = {
      ...root,
      id,
      policy: { ...root.policy, resolved: "unsupported" },
    };
    const buildId = crypto.randomUUID();
    await saveGeneratedVersion({ id, buildId }, app);
    const candidate = (await listVersions(id)).find((v) => v.id === buildId);
    await assertCode("invalid-policy", () =>
      activateVersion(id, candidate, root.activeVersionId),
    );
    if ((await getDoc(ref)).data().activeVersionId !== root.activeVersionId)
      throw Error("Invalid version activated");
  });

  await page.getByText("App started successfully", { exact: true }).waitFor();
  frame = page.frames().find((x) => x !== page.mainFrame());
  await context.setOffline(true);
  try {
    assert.equal(
      (
        await request(frame, "set", "sam-chore", {
          title: "Sam chore",
          assigneeId: "sam",
          completed: true,
          extra: "keep",
        })
      ).code,
      "backend",
    );
  } finally {
    await context.setOffline(false);
  }
  const candidateId = await page.evaluate(async () => {
    const { db, base } = await import("/data.ts");
    const sdk = (await fetch("/data.ts").then((r) => r.text())).match(
      /from "([^"]*entries\/firestore.js[^"]*)"/,
    )[1];
    const { getDoc, doc } = await import(sdk);
    const { saveGeneratedVersion } = await import("/app-versions.ts");
    const id = location.hash.split("/")[1],
      root = (await getDoc(doc(db, base + "/apps/" + id))).data(),
      buildId = crypto.randomUUID();
    await saveGeneratedVersion({ id, buildId }, { ...root, id });
    return buildId;
  });
  await page.locator("select").first().selectOption(candidateId);
  await page.getByText("App started successfully", { exact: true }).waitFor();
  frame = page.frames().find((x) => x !== page.mainFrame());
  assert.equal(
    (
      await request(frame, "set", "sam-chore", {
        title: "Preview only",
        assigneeId: "sam",
        completed: true,
        extra: "keep",
      })
    ).error,
    undefined,
  );
  assert.equal(
    await page.evaluate(async () => {
      const { db, base } = await import("/data.ts");
      const sdk = (await fetch("/data.ts").then((r) => r.text())).match(
        /from "([^"]*entries\/firestore.js[^"]*)"/,
      )[1];
      const { getDoc, doc } = await import(sdk);
      return (
        await getDoc(
          doc(
            db,
            base +
              "/apps/" +
              location.hash.split("/")[1] +
              "/records/sam-chore",
          ),
        )
      ).data().title;
    }),
    "Sam chore",
  );
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
  await kid.goto(appUrl);
  await kid
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 30000 });
  const k = kid.frameLocator('iframe[title="Family app preview"]');
  await k.getByRole("checkbox", { name: "Sam chore", exact: true }).waitFor();
  assert.equal(
    await k
      .getByRole("checkbox", { name: "Zoe chore", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await k.getByRole("button", { name: "Add chore", exact: true }).count(),
    0,
  );
  assert.equal(
    await k
      .getByRole("button", { name: "Delete Sam chore", exact: true })
      .count(),
    0,
  );
  frame = kid.frames().find((x) => x !== kid.mainFrame());
  for (const [op, id, data] of [
    [
      "set",
      "zoe-chore",
      { title: "Zoe chore", assigneeId: "zoe", completed: true },
    ],
    ["delete", "sam-chore", undefined],
    [
      "set",
      "sam-chore",
      {
        title: "Sam chore",
        assigneeId: "sam",
        completed: true,
        extra: "changed",
      },
    ],
    [
      "set",
      "sam-chore",
      { title: "Sam chore", assigneeId: "zoe", completed: true, extra: "keep" },
    ],
    [
      "set",
      "new-chore",
      { title: "New chore", assigneeId: "sam", completed: false },
    ],
  ])
    assert.equal((await request(frame, op, id, data)).code, "denied");
  assert.equal(
    (
      await request(frame, "set", "sam-chore", {
        title: "Sam chore",
        assigneeId: "sam",
        completed: true,
        extra: "keep",
      })
    ).error,
    undefined,
  );
  await k.getByText("10 stars", { exact: true }).waitFor();
  await kid.reload();
  await kid
    .getByText("App started successfully", { exact: true })
    .waitFor({ timeout: 30000 });
  await k.getByText("10 stars", { exact: true }).waitFor();
  await k.getByRole("button", { name: "All (2)", exact: true }).click();
  await k.getByRole("checkbox", { name: "Sam chore", exact: true }).click();
  await k.getByText("0 stars", { exact: true }).waitFor();
  await kid.getByRole("button", { name: "Sign out", exact: true }).click();
  await kid
    .locator('iframe[title="Family app preview"]')
    .waitFor({ state: "detached" });
  console.log(
    "PASS live identity, parent writes, kid UI and direct bridge denials, completion/undo, reload, sign-out",
  );
} finally {
  await browser.close();
}
