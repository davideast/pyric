import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { build } from "esbuild";
import { readPyricConfig } from "../cli/pyric-config.js";
import type { AppPorts } from "./app-ports.js";
import {
  flowManifest,
  resolveFlowConfig,
  type FlowConfig,
} from "./flow-config.js";
import {
  inProcessSessionTokenForPort,
  isSessionTokenRequired,
  projectSessionPolicyFor,
} from "./local-session-token.js";
import {
  isAllowedLoopbackRequest,
  isAllowedSessionToken,
  isLocalPeer,
} from "./server.js";

/** Shared by CLI, framework hosts, and development examples. No config code
 * executes on the host: only explicitly registered browser modules are bundled. */
export async function createFlowTreatmentHost(
  projectDir: string,
  overrides?: FlowConfig,
  guard?: {
    boundHost?: string;
    allowedHosts?: string[];
    appPorts?: AppPorts;
    sessionToken?: string;
    requireSessionToken?: boolean;
  },
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
      const ports =
        guard?.appPorts?.forRequest(req) ??
        (req.socket?.localPort ? [req.socket.localPort] : undefined);
      const portToken = inProcessSessionTokenForPort(req.socket?.localPort);
      const projectPolicy = projectSessionPolicyFor(projectDir);
      const expectedToken =
        guard?.sessionToken ?? portToken ?? projectPolicy?.token;
      const requiresToken =
        guard?.requireSessionToken ??
        (portToken !== undefined
          ? isSessionTokenRequired(portToken)
          : projectPolicy?.requireSessionToken === true);
      const authenticated = isAllowedSessionToken(req, url, expectedToken);
      const allowedExtraHosts =
        requiresToken && authenticated ? (guard?.allowedHosts ?? []) : [];
      if (
        !isLocalPeer(req) ||
        !isAllowedLoopbackRequest(
          req,
          guard?.boundHost ?? "localhost",
          allowedExtraHosts,
          ports,
        )
      ) {
        res.statusCode = 403;
        res.end("Forbidden: local loopback route");
        return true;
      }
      if (requiresToken && !authenticated) {
        res.statusCode = 401;
        res.end("Unauthorized: invalid session capability token");
        return true;
      }
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
