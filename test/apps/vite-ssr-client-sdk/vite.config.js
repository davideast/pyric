import { pyric } from "@pyric/cli/vite";
import { pyricViteExternals } from "@pyric/cli/bundler";

// A small SSR middleware, the shape a framework's dev SSR takes. `runner`
// picks how the module loads: `ssrLoadModule` or the environment API runner.
// `/ssr/trapped` answers with the hosts trap.cjs recorded in this process.
function ssrRoutes() {
  return {
    name: "ssr-routes",
    configureServer(server) {
      const load = (runner, path) =>
        runner === "environment"
          ? server.environments.ssr.runner.import(path)
          : server.ssrLoadModule(path);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        const action = url.pathname.match(/^\/ssr\/(run|run-ai|admin|local-admin|sdk-names|trapped)$/)?.[1];
        if (!action) return next();
        try {
          const runner = url.searchParams.get("runner");
          const tag = url.searchParams.get("tag");
          let body;
          if (action === "trapped") {
            body = globalThis[Symbol.for("scenario.trapped")] ?? null;
          } else if (action === "sdk-names") {
            body = { outcomes: (await load(runner, "/src/ssr-sdk-names.js")).outcomes };
          } else if (action === "local-admin") {
            body = await (await load(runner, "/src/ssr-local-admin.js")).run();
          } else if (action === "admin") {
            body = await (await load(runner, "/src/ssr-admin.js")).read(url.searchParams.get("uid"), tag);
          } else {
            const mod = await load(runner, "/src/ssr.js");
            body = await (action === "run" ? mod.run(tag) : mod.runAiOnly());
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error?.stack ?? error));
        }
      });
    },
  };
}

// The scenario starts this dev server in several shapes: the SharedWorker
// sandbox (PYRIC_TEST_HOSTED=0), and the externalization settings frameworks
// use (PYRIC_TEST_NO_EXTERNAL=firebase or all). `vite build --ssr` with
// PYRIC_TEST_NO_EXTERNAL=all bundles every dependency except the Firebase SDKs
// pyricViteExternals keeps external; that plugin runs in builds only (#1756).
const noExternal = { firebase: ["firebase"], all: true }[process.env.PYRIC_TEST_NO_EXTERNAL ?? ""];

export default {
  ...(noExternal === undefined ? {} : { ssr: { noExternal } }),
  plugins: [pyric({ hosted: process.env.PYRIC_TEST_HOSTED !== "0" }), ssrRoutes(), pyricViteExternals()],
};
