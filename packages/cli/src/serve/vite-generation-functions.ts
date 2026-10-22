import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { FirebaseProjectResolution } from '../cli/firebase-project.js';
import type {
  FunctionsProject,
} from '../functions/project.js';
import type { BridgeMount } from './bridge-mount.js';
import { hostingRewrites } from '../functions/http/rewrites.js';
import { isAllowedHost } from './server.js';

/** firebase.json, read synchronously at attach; a missing or unreadable file has no rewrites. */
function readRewrites(projectDir: string): ReturnType<typeof hostingRewrites> {
  try {
    return hostingRewrites(JSON.parse(readFileSync(path.join(projectDir, 'firebase.json'), 'utf8')));
  } catch {
    return [];
  }
}

/** Vite's own routes and any file under the root or the public dir answer before a rewrite. */
function viteServesPath(server: ViteDevServer, pathname: string): boolean {
  if (/^\/(@|__|node_modules\/)/.test(pathname)) return true;
  const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();
  const relative = pathname.replace(/^\/+/, '');
  const roots = [server.config.root, server.config.publicDir].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  return roots.some((dir) => {
    const file = path.resolve(dir, relative);
    const inside = file === dir || file.startsWith(`${path.resolve(dir)}${path.sep}`);
    return inside && (isFile(file) || isFile(path.join(file, 'index.html')));
  });
}
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
    rewrites: readRewrites(projectDir),
    staticFileExists: (pathname) => viteServesPath(server, pathname),
    isAllowedRequest: (req) => {
      const serverOptions = server.config.server;
      return serverOptions.allowedHosts === true || isAllowedHost(
        req.headers.host,
        typeof serverOptions.host === 'string' ? serverOptions.host : 'localhost',
        Array.isArray(serverOptions.allowedHosts) ? serverOptions.allowedHosts : [],
      );
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
