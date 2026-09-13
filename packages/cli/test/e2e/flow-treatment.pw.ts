import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { createFlowTreatmentHost } from "../../src/serve/flow-treatment-host.js";

test("loads the project default and custom module in the browser, switches without reloading marks, and restores the user choice", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "flow-browser-"));
  const outdir = join(root, "bundle");
  writeFileSync(
    join(root, "pyric.json"),
    JSON.stringify({
      flow: {
        treatment: "team:quiet",
        treatments: [
          { id: "team:quiet", label: "Quiet", module: "./quiet.ts" },
        ],
      },
    }),
  );
  writeFileSync(
    join(root, "quiet.ts"),
    'export default { css: `html[data-pyric-treatment="team:quiet"] [data-pyric-flow] { outline: 3px solid rgb(12, 34, 56); }` };',
  );
  const host = await createFlowTreatmentHost(root);
  const entry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/serve/runtime/flow-treatments/controller.ts",
  );
  const bundle = await build({
    stdin: {
      contents: `import { createTreatmentController } from ${JSON.stringify(entry)}; const controller = createTreatmentController({ document, onChange() {} }); globalThis.controller = controller; await controller.attach(document.querySelector('#overlay')); globalThis.ready = true;`,
      resolveDir: process.cwd(),
    },
    outdir,
    entryNames: "app",
    bundle: true,
    splitting: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
  });
  const assets = new Map(
    bundle.outputFiles.map((file) => [
      file.path.slice(outdir.length),
      file.text,
    ]),
  );
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (await host.handle(req, res, url)) return;
    if (assets.has(url.pathname)) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(assets.get(url.pathname));
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><style>:root { --pyric-overlay-flow-outline-width: 2px; --pyric-overlay-outline-style: solid; }</style><div id="target" data-pyric-flow="0" data-pyric-flow-listener="one">Message</div><div id="overlay"></div><script type="module" src="/app.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  try {
    let configure!: () => void;
    const configuration = new Promise<void>((resolve) => {
      configure = resolve;
    });
    await page.route("**/__pyric/flow/manifest.json", async (route) => {
      await configuration;
      await route.continue();
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction("!!globalThis.controller");
    await page.evaluate('void globalThis.controller.select("outline")');
    configure();
    await expect(page.locator("html")).toHaveAttribute(
      "data-pyric-treatment",
      "outline",
    );
    await expect(page.locator("#target")).toHaveCSS("outline-style", "solid");
    await expect(page.locator("#target")).toHaveCSS("outline-width", "2px");
    await page.unroute("**/__pyric/flow/manifest.json");
    await page.evaluate(() => localStorage.removeItem("pyric:flow-treatment"));
    await page.reload();
    await page.waitForFunction("globalThis.ready === true");
    expect(
      await page.locator("html").getAttribute("data-pyric-treatment"),
    ).toBe("team:quiet");
    expect(
      await page
        .locator("#target")
        .evaluate((el) => getComputedStyle(el).outlineColor),
    ).toBe("rgb(12, 34, 56)");
    await page.evaluate('globalThis.controller.select("rail")');
    expect(
      await page.locator("#target").getAttribute("data-pyric-flow-listener"),
    ).toBe("one");
    await page.reload();
    await page.waitForFunction("globalThis.ready === true");
    expect(
      await page.locator("html").getAttribute("data-pyric-treatment"),
    ).toBe("rail");
    await page.evaluate('globalThis.controller.select("team:quiet")');
    expect(
      await page
        .locator("#target")
        .evaluate((el) => getComputedStyle(el).outlineColor),
    ).toBe("rgb(12, 34, 56)");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
