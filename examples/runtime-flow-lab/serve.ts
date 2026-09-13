/** Run from the repository root: bun examples/runtime-flow-lab/serve.ts */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAvatar } from "../../packages/cli/src/serve/assets/avatar-route.ts";
import { createAssetResolver } from "../../packages/cli/src/serve/assets/resolver.ts";
import { defaultAvatarSvg } from "pyric/auth/internal";

const here = fileURLToPath(new URL(".", import.meta.url));
// React is a workspace development dependency, never a CLI runtime dependency.
const resolve = createRequire(
  new URL("../../packages/studio/package.json", import.meta.url),
);
const build = await Bun.build({
  entrypoints: [join(here, "app.ts")],
  target: "browser",
  plugins: [
    {
      name: "workspace-react",
      setup(build) {
        build.onResolve(
          { filter: /^react(?:-dom)?(?:\/client)?$/ },
          (args) => ({ path: resolve.resolve(args.path) }),
        );
      },
    },
  ],
  minify: false,
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const script = await build.outputs[0]!.text();
const portraits = [12, 47, 13, 49, 14, 44, 15, 48, 16];
const ids = [
  "david",
  "alice",
  "marcus",
  "avery",
  "test-0",
  "test-1",
  "test-2",
  "test-3",
  "test-4",
];
const resolver = createAssetResolver({
  dir: join(tmpdir(), "chip-preview-avatars"),
  source: ({ key, seed }) => ({
    url: `https://i.pravatar.cc/160?img=${portraits[ids.includes(key) ? ids.indexOf(key) : [...seed].reduce((n, c) => n + c.charCodeAt(0), 0) % portraits.length]}`,
  }),
  sourceDeadlineMs: 15000,
  fallback: ({ key, context }) => ({
    data: new TextEncoder().encode(
      defaultAvatarSvg({
        uid: key,
        displayName:
          typeof context.displayName === "string" ? context.displayName : null,
        email: null,
      }),
    ),
    contentType: "image/svg+xml",
  }),
});
const port = Number(process.env.FLOW_LAB_PORT ?? 5197);
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/__pyric/assets/")) {
    await handleAvatar(resolver, req, res, url);
    return;
  }
  if (url.pathname === "/chip.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(script);
    return;
  }
  if (url.pathname === "/lab.css") {
    res.writeHead(200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      (await Bun.file(join(here, "lab.css")).text()) +
        "\n" +
        (await Bun.file(join(here, "treatments.css")).text()),
    );
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(await Bun.file(join(here, "index.html")).text());
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Flow studies: http://localhost:${port}`),
);
