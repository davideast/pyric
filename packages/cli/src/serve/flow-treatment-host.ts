import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { build } from "esbuild";
import { readPyricConfig } from "../cli/pyric-config.js";
import {
  flowManifest,
  resolveFlowConfig,
  type FlowConfig,
} from "./flow-config.js";

/** Shared by CLI, framework hosts, and development examples. No config code
 * executes on the host: only explicitly registered browser modules are bundled. */
export async function createFlowTreatmentHost(
  projectDir: string,
  overrides?: FlowConfig,
) {
  const config = resolveFlowConfig(
    (await readPyricConfig(projectDir)).flow,
    overrides,
  );
  const manifest = flowManifest(config);
  const entries = new Map(
    (config.treatments ?? []).map((entry) => [
      `/__pyric/flow/custom/${encodeURIComponent(entry.id)}.js`,
      resolve(projectDir, entry.module),
    ]),
  );
  return {
    manifest,
    async handle(
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
    ): Promise<boolean> {
      if (!url.pathname.startsWith("/__pyric/flow/")) return false;
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return true;
      }
      if (url.pathname === "/__pyric/flow/manifest.json") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(manifest));
        return true;
      }
      const entry = entries.get(url.pathname);
      if (!entry) {
        res.statusCode = 404;
        res.end("Unknown treatment");
        return true;
      }
      try {
        const result = await build({
          entryPoints: [entry],
          bundle: true,
          write: false,
          format: "esm",
          platform: "browser",
          target: "es2022",
          logLevel: "silent",
        });
        // Treat a configured module like application source: bundle its imports
        // for the browser, but never expose arbitrary filesystem routes.
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(result.outputFiles[0]!.text);
      } catch {
        res.statusCode = 500;
        res.end(
          "Unable to bundle the configured Flow treatment. Check its module path and browser imports.",
        );
      }
      return true;
    },
  };
}
