import basicSsl from "@vitejs/plugin-basic-ssl";
import { pyric } from "@pyric/cli/vite";

// A small SSR middleware, the shape a framework's dev SSR takes. `runner`
// picks how the module loads: `ssrLoadModule` or the environment API runner.
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
        const action = url.pathname.match(/^\/ssr\/(run|run-ai|admin)$/)?.[1];
        if (!action) return next();
        try {
          const runner = url.searchParams.get("runner");
          const tag = url.searchParams.get("tag");
          let body;
          if (action === "admin") {
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
// sandbox (PYRIC_TEST_HOSTED=0), the externalization settings frameworks
// use (PYRIC_TEST_NO_EXTERNAL=firebase or all), and HTTPS with a generated
// self-signed certificate (PYRIC_TEST_HTTPS=1).
const noExternal = { firebase: ["firebase"], all: true }[process.env.PYRIC_TEST_NO_EXTERNAL ?? ""];
const https = process.env.PYRIC_TEST_HTTPS === "1" ? [basicSsl()] : [];

export default {
  ...(noExternal === undefined ? {} : { ssr: { noExternal } }),
  plugins: [...https, pyric({ hosted: process.env.PYRIC_TEST_HOSTED !== "0" }), ssrRoutes()],
};
