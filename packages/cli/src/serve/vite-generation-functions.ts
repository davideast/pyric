import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { FirebaseProjectResolution } from '../cli/firebase-project.js';
import type {
  FunctionsProject,
} from '../functions/project.js';
import type { BridgeMount } from './bridge-mount.js';
import { getHeader, isAllowedHost, isAllowedOriginOnPorts } from './server.js';
import type {
  ViteFunctionsDevelopmentAttachment,
  ViteFunctionsDevelopmentOptions,
} from './vite-functions-development.js';

export interface ResolvedViteGenerationFunctions {
  options: { region?: string; instance?: string; watch?: boolean };
  project: FunctionsProject | null;
  projectId: string | null;
}

/**
 * The functions codebase this generation runs, and the project id its child
 * runs as: the project `resolveFirebaseProject` resolved, else `demo-project`.
 */
export function resolveViteGenerationFunctions(input: {
  projectDir: string;
  options: false | { region?: string; instance?: string; watch?: boolean };
  discover(projectDir: string): FunctionsProject | null;
  firebaseProject: FirebaseProjectResolution;
}): ResolvedViteGenerationFunctions {
  const { projectDir, options, discover, firebaseProject } = input;
  const project = options === false ? null : discover(projectDir);
  return {
    options: typeof options === 'object' ? options : {},
    project,
    projectId: project ? firebaseProject.projectId ?? 'demo-project' : null,
  };
}

/**
 * With `allowedHosts: true` Vite serves the app under any name, so the
 * app's own page is the one whose Origin names the host it asked for.
 */
function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  const sendsNoOrigin = origin === undefined;
  if (sendsNoOrigin) return true;
  try {
    return new URL(origin).host.toLowerCase() === (hostHeader ?? '').toLowerCase();
  } catch {
    return false;
  }
}

export function attachViteGenerationFunctions(input: {
  server: ViteDevServer;
  projectDir: string;
  cliRoot: string;
  bridge: BridgeMount | null;
  resolved: ResolvedViteGenerationFunctions;
  registerModuleUrl(): string;
  fileExists?: (path: string) => boolean;
  attach(options: ViteFunctionsDevelopmentOptions): ViteFunctionsDevelopmentAttachment;
}): ViteFunctionsDevelopmentAttachment | null {
  const { server, projectDir, cliRoot, bridge, resolved, registerModuleUrl, attach } = input;
  if (!resolved.project || !resolved.projectId || !bridge || !server.httpServer) return null;
  const builtChild = path.join(cliRoot, 'dist/functions/child.js');
  const fileExists = input.fileExists ?? existsSync;
  const childModuleUrl = fileExists(builtChild) ? builtChild : undefined;
  const host =
    (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
  const registerUrl = registerModuleUrl();
  const attachmentOptions: ViteFunctionsDevelopmentOptions = {
    cwd: projectDir,
    project: resolved.project,
    projectId: resolved.projectId,
    instance: resolved.options.instance,
    region: resolved.options.region,
    watch: resolved.options.watch,
    host,
    httpServer: server.httpServer as unknown as HttpServer,
    middlewares: server.middlewares,
    isAllowedRequest: (req) => {
      const serverOptions = server.config.server;
      return serverOptions.allowedHosts === true || isAllowedHost(
        req.headers.host,
        typeof serverOptions.host === 'string' ? serverOptions.host : 'localhost',
        Array.isArray(serverOptions.allowedHosts) ? serverOptions.allowedHosts : [],
      );
    },
    // The page Vite serves names Vite's own port, the port the request came in on.
    allowsAppOrigin: (req) => {
      const serverOptions = server.config.server;
      const origin = getHeader(req, 'origin');
      const allowsAnyHost = serverOptions.allowedHosts === true;
      if (allowsAnyHost) return isSameOrigin(origin, req.headers.host);
      const extraHosts = Array.isArray(serverOptions.allowedHosts) ? serverOptions.allowedHosts : [];
      const ports = req.socket.localPort === undefined ? [] : [req.socket.localPort];
      return isAllowedOriginOnPorts(origin, host, extraHosts, ports);
    },
    watcher: server.watcher,
    logger: server.config.logger,
    bridge,
    baseEnv: process.env,
    registerUrl,
    childModuleUrl,
  };
  return attach(attachmentOptions);
}
