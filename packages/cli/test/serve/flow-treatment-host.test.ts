import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createFlowTreatmentHost } from "../../src/serve/flow-treatment-host.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("serves the shared project manifest and lazily bundles only registered browser modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-host-"));
  roots.push(root);
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
  const host = await createFlowTreatmentHost(root);
  const server = createServer(async (req, res) => {
    if (!(await host.handle(req, res, new URL(req.url!, "http://localhost")))) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const manifest = await (
      await fetch(`${url}/__pyric/flow/manifest.json`)
    ).json();
    expect(manifest.treatment).toBe("team:quiet");
    expect(manifest.treatments[0].url).toBe(
      "/__pyric/flow/custom/team%3Aquiet.js",
    );
    // Missing module does not stop host startup or manifest discovery.
    expect((await fetch(url + manifest.treatments[0].url)).status).toBe(500);
    writeFileSync(
      join(root, "quiet.ts"),
      'import { color } from "./color"; export default { css: `html[data-pyric-treatment="team:quiet"] [data-pyric-flow] { outline-color: ${color}; }` };',
    );
    writeFileSync(
      join(root, "color.ts"),
      'export const color: string = "#abcdef";',
    );
    const module = await fetch(url + manifest.treatments[0].url + "?attempt=2");
    expect(module.status).toBe(200);
    expect(module.headers.get("Content-Type")).toContain("javascript");
    expect(await module.text()).toContain("#abcdef");
    expect(
      (await fetch(`${url}/__pyric/flow/custom/unregistered.js`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${url}/__pyric/flow/manifest.json`, { method: "POST" }))
        .status,
    ).toBe(405);
    expect(
      (await createFlowTreatmentHost(root, { treatment: "rail" })).manifest
        .treatment,
    ).toBe("rail");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
