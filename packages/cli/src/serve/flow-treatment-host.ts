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
  createGuardPolicy,
  evaluateGuard,
  type RemoteAccessOptions,
} from "./guard-policy.js";
import {
  isSessionTokenRequired,
  inProcessSessionTokenForPort,
  projectSessionPolicyFor,
} from "./local-session-token.js";

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
    remoteAccess?: RemoteAccessOptions;
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
      let requiresToken = guard?.requireSessionToken;
      if (requiresToken === undefined) {
        if (portToken !== undefined) {
          requiresToken = isSessionTokenRequired(portToken);
        } else {
          requiresToken = projectPolicy?.requireSessionToken === true;
        }
      }
      const extraHosts: string[] = [];
      for (const host of guard?.allowedHosts ?? []) {
        if (!extraHosts.includes(host)) extraHosts.push(host);
      }
      for (const host of guard?.remoteAccess?.allowedHosts ?? []) {
        if (!extraHosts.includes(host)) extraHosts.push(host);
      }
      const policy = createGuardPolicy({
        boundHost: guard?.boundHost ?? "localhost",
        allowedHosts: extraHosts,
        allowPeers: guard?.remoteAccess?.allowPeers,
        trustProxy: guard?.remoteAccess?.trustProxy,
        browserUnlock: guard?.remoteAccess?.browserUnlock,
        remoteAccessEnabled: guard?.remoteAccess !== undefined,
        sessionToken: expectedToken,
        requireSessionToken: requiresToken,
      });
      const decision = evaluateGuard(req, policy, "flow", {
        url,
        extraAppPorts: ports,
      });
      if (!decision.ok) {
        res.statusCode = decision.status;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(decision.message);
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
