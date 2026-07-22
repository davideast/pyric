import type { Server as HttpServer } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { FunctionsRtdbProject } from '../functions-rtdb/project.js';
import type {
  BridgeHostAttachment,
  BridgeMount,
  BridgeMountOptions,
} from './bridge-mount.js';

export function createViteGenerationBridge(input: {
  server: ViteDevServer;
  projectDir: string;
  options: Omit<BridgeMountOptions, 'upgradeGuard'> | null;
  functionsProject: FunctionsRtdbProject | null;
  functionsProjectId: string | null;
  createBridge(options: BridgeMountOptions): BridgeMount;
}): BridgeMount | null {
  const { server, options, functionsProject, functionsProjectId, createBridge } = input;
  if (!options && !functionsProject) return null;
  const serverOptions = server.config.server;
  return createBridge({
    ...(options ?? {}),
    project: options?.project ?? functionsProjectId ?? undefined,
    upgradeGuard: {
      boundHost: typeof serverOptions.host === 'string' ? serverOptions.host : 'localhost',
      allowedHosts:
        serverOptions.allowedHosts === true
          ? true
          : Array.isArray(serverOptions.allowedHosts)
            ? serverOptions.allowedHosts
            : [],
    },
  });
}

export function attachViteGenerationBridge(input: {
  server: ViteDevServer;
  projectDir: string;
  bridge: BridgeMount | null;
}): BridgeHostAttachment | null {
  const { server, projectDir, bridge } = input;
  if (!bridge || !server.httpServer) return null;
  const httpServer = server.httpServer as unknown as HttpServer;
  const host =
    (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
  return bridge.attachHost({
    servers: [httpServer],
    projectDir,
    origin: () => {
      const address = httpServer.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      return port > 0 ? { host, port } : null;
    },
    collision: server.config.logger,
    closeOnServerClose: false,
  });
}
