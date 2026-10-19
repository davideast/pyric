import { pyric } from "@pyric/cli/vite";

// A small SSR middleware, the shape a framework's dev SSR takes. `runner`
// picks how the module loads: `ssrLoadModule` or the environment API runner.
function ssrRoutes() {
  return {
    name: "ssr-routes",
    configureServer(server) {
      const load = (runner) =>
        runner === "environment"
          ? server.environments.ssr.runner.import("/src/ssr.js")
          : server.ssrLoadModule("/src/ssr.js");
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        const action = url.pathname.match(/^\/ssr\/(start|start-ai|status)$/)?.[1];
        if (!action) return next();
        try {
          const mod = await load(url.searchParams.get("runner"));
          const tag = url.searchParams.get("tag");
          const actions = { start: mod.start, "start-ai": mod.startAiOnly, status: mod.status };
          const body = actions[action](tag);
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

export default {
  plugins: [pyric({ hosted: true }), ssrRoutes()],
};
