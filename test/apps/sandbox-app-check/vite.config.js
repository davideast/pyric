import { pyric } from "@pyric/cli/vite";

// The Node host by default; SANDBOX_APP_CHECK_PLANE=shared-worker serves the
// SharedWorker plane, whose pages fall back to the in-page sandbox when asked.
const hosted = process.env.SANDBOX_APP_CHECK_PLANE !== "shared-worker";

async function settle(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, name: error?.name ?? null, message: String(error?.message ?? error) };
  }
}

// A small SSR route, the shape a framework's dev SSR takes: GET /ssr/app-check
// loads the module that imports the shared firebase.ts, and the module that
// attests with a CustomProvider calling the token server named by `?token=`.
function ssrAppCheck() {
  return {
    name: "ssr-app-check",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname !== "/ssr/app-check") return next();
        const body = {
          sharedFirebase: await settle(async () => (await server.ssrLoadModule("/src/ssr-render.js")).render()),
          customProvider: await settle(async () => (await server.ssrLoadModule("/src/ssr-custom.js")).customToken(url.searchParams.get("token"))),
        };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });
    },
  };
}

export default {
  plugins: [pyric({ hosted }), ssrAppCheck()],
  server: { port: 5184, strictPort: true },
};
