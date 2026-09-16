import type { Server as HttpServer } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { FunctionsRtdbProject } from '../functions-rtdb/project.js';
import type {
  BridgeHostAttachment,
  BridgeHostOptions,
  BridgeMount,
  BridgeMountOptions,
} from './bridge-mount.js';

function resolveAllowedHosts(allowedHosts: true | string[] | undefined): true | string[] {
  if (allowedHosts === true) return true;
  if (Array.isArray(allowedHosts)) return allowedHosts;
  return [];
}

export function createViteGenerationBridge(input: {
  server: ViteDevServer;
  projectDir: string;
  hosted?: boolean;
  options: Omit<BridgeMountOptions, 'upgradeGuard'> | null;
  functionsProject: FunctionsRtdbProject | null;
  functionsProjectId: string | null;
  createBridge(options: BridgeMountOptions): BridgeMount;
}): BridgeMount | null {
  const { server, options, functionsProject, functionsProjectId, createBridge } = input;
  const needsBridge = Boolean(input.hosted || options || functionsProject);
  if (!needsBridge) return null;
  const serverOptions = server.config.server;
  const project = options?.project ?? functionsProjectId ?? undefined;
  const disableAuditLog = options?.disableAuditLog;
  const boundHost = typeof serverOptions.host === 'string' ? serverOptions.host : 'localhost';
  const allowedHosts = resolveAllowedHosts(serverOptions.allowedHosts);
  const bridgeOptions: BridgeMountOptions = {
    hosted: input.hosted,
    projectKey: input.hosted ? input.projectDir : undefined,
    project,
    disableAuditLog,
    upgradeGuard: {
      boundHost,
      allowedHosts,
    },
  };
  return createBridge(bridgeOptions);
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
  const origin = (): { host: string; port: number } | null => {
    const address = httpServer.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    return port > 0 ? { host, port } : null;
  };
  const hostOptions: BridgeHostOptions = {
    servers: [httpServer],
    projectDir,
    origin,
    collision: server.config.logger,
    closeOnServerClose: false,
  };
  return bridge.attachHost(hostOptions);
}
