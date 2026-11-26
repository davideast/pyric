import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { FirebaseProjectResolution } from '../cli/firebase-project.js';
import type {
  FunctionsProject,
} from '../functions/project.js';
import type { BridgeMount } from './bridge-mount.js';
import {
  effectiveRequestScheme,
  parseTrustProxySetting,
  type RemoteAccessOptions,
} from './guard-policy.js';
import { hostingRewrites } from '../functions/http/rewrites.js';
import {
  attachFunctionsRequestGuard,
  createFunctionsGuardPolicy,
  mergeAllowedHostEntries,
  parseGuardRequestUrl,
} from '../functions/http/request-guard.js';
import {
  getHeader,
  isAllowedHost,
  isAllowedOriginOnPorts,
  isForeignFetchSite,
  requestSocketScheme,
} from './server.js';
import type {
  ViteFunctionsDevelopmentAttachment,
  ViteFunctionsDevelopmentOptions,
} from './vite-functions-development.js';

/** firebase.json's hosting rewrites, read synchronously at attach; a rewrite that does not compile is warned about and skipped. */
function readRewrites(projectDir: string, warn: (message: string) => void): ReturnType<typeof hostingRewrites> {
  const file = path.join(projectDir, 'firebase.json');
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    warn(`  ⚠ [pyric] firebase.json could not be read for hosting rewrites: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  return hostingRewrites(parsed, (warning) => warn(`  ⚠ [pyric] ${warning}`));
}

function decoded(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * Whether the dev server answers this path itself, so a rewrite must not:
 * Vite's own routes, and any file under the root or the public dir, read
 * under Vite's `base` and with the path decoded as the file system names it.
 */
function viteServesPath(server: ViteDevServer, pathname: string): boolean {
  const base = server.config.base.endsWith('/') ? server.config.base : `${server.config.base}/`;
  const underBase = pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : pathname === base.slice(0, -1) ? '/' : null;
  if (underBase === null) return false;
  if (/^\/(@|__|node_modules\/)/.test(underBase)) return true;
  const relative = decoded(underBase)?.replace(/^\/+/, '');
  if (relative === undefined) return false;
  const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();
  const roots = [server.config.root, server.config.publicDir].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  return roots.some((dir) => {
    const root = path.resolve(dir);
    const file = path.resolve(root, relative);
    const inside = file === root || file.startsWith(`${root}${path.sep}`);
    return inside && (isFile(file) || isFile(path.join(file, 'index.html')));
  });
}

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
  allowedHosts?: readonly string[];
  remoteAccess?: RemoteAccessOptions;
  attach(options: ViteFunctionsDevelopmentOptions): ViteFunctionsDevelopmentAttachment;
}): ViteFunctionsDevelopmentAttachment | null {
  const { server, projectDir, cliRoot, bridge, resolved, registerModuleUrl, attach } = input;
  if (!resolved.project || !resolved.projectId || !bridge || !server.httpServer) return null;
  const trustProxy = parseTrustProxySetting(input.remoteAccess?.trustProxy);
  const builtChild = path.join(cliRoot, 'dist/functions/child.js');
  const fileExists = input.fileExists ?? existsSync;
  const childModuleUrl = fileExists(builtChild) ? builtChild : undefined;
  const host =
    (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
  const registerUrl = registerModuleUrl();
  let viteAllowedHostEntries: readonly string[] | undefined;
  if (Array.isArray(server.config.server.allowedHosts)) {
    viteAllowedHostEntries = server.config.server.allowedHosts;
  }
  const mergedAllowedHosts = mergeAllowedHostEntries(
    mergeAllowedHostEntries(viteAllowedHostEntries, input.allowedHosts),
    input.remoteAccess?.allowedHosts,
  );
  const functionsGuardPolicy = createFunctionsGuardPolicy({
    boundHost: host,
    allowedHosts: mergedAllowedHosts,
    remoteAccess: input.remoteAccess,
    sessionToken: bridge.sessionToken,
  });
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
    rewrites: readRewrites(projectDir, (message) => server.config.logger.warn(message)),
    staticFileExists: (pathname) => viteServesPath(server, pathname),
    trustProxy,
    isAllowedRequest: (req) => {
      const serverOptions = server.config.server;
      let boundHost = 'localhost';
      if (typeof serverOptions.host === 'string' && serverOptions.host.length > 0) {
        boundHost = serverOptions.host;
      }
      if (!isAllowedHost(req.headers.host, boundHost, mergedAllowedHosts)) {
        return false;
      }
      attachFunctionsRequestGuard(req, {
        policy: functionsGuardPolicy,
        url: parseGuardRequestUrl(req),
      });
      return true;
    },
    // The page Vite serves names Vite's own port and scheme, the socket the request came in on.
    allowsAppOrigin: (req) => {
      const serverOptions = server.config.server;
      const origin = getHeader(req, 'origin');
      let fallbackScheme: 'http:' | 'https:' = 'http:';
      if (serverOptions.https) fallbackScheme = 'https:';
      let expectedScheme = effectiveRequestScheme(req, trustProxy);
      if (expectedScheme === undefined) expectedScheme = requestSocketScheme(req);
      if (expectedScheme === undefined) expectedScheme = fallbackScheme;
      let ports: number[] = [];
      if (req.socket.localPort !== undefined) {
        ports = [req.socket.localPort];
      }
      return (
        isAllowedOriginOnPorts(origin, host, mergedAllowedHosts, ports, expectedScheme) &&
        !isForeignFetchSite(req, host, ports, expectedScheme, mergedAllowedHosts)
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
