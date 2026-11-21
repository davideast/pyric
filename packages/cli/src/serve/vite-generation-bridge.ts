import type { Server as HttpServer } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { FunctionsProject } from '../functions/project.js';
import type { LiveHostState } from './live-host-state.js';
import type { RemoteAccessOptions } from './guard-policy.js';
import type {
  BridgeHostAttachment,
  BridgeHostOptions,
  BridgeMount,
  BridgeMountOptions,
  BridgeOrigin,
} from './bridge-mount.js';
import { advertisedHost } from './advertised-host.js';
import { servesHttps } from './vite-https.js';

function resolveAllowedHosts(allowedHosts: true | string[] | undefined): true | string[] {
  if (allowedHosts === true) return true;
  if (Array.isArray(allowedHosts)) return allowedHosts;
  return [];
}

export function createViteGenerationBridge(input: {
  server: ViteDevServer;
  projectDir: string;
  hosted?: boolean;
  /** Held only by a generation `@pyric/live` started. */
  liveHost?: LiveHostState;
  options: Omit<BridgeMountOptions, 'upgradeGuard'> | null;
  functionsProject: FunctionsProject | null;
  functionsProjectId: string | null;
  sessionToken?: string;
  requireSessionToken?: boolean;
  allowedHosts?: readonly string[];
  remoteAccess?: RemoteAccessOptions;
  upgradeRejectionLogger?: (line: string) => void;
  createBridge(options: BridgeMountOptions): BridgeMount;
}): BridgeMount | null {
  const { server, options, functionsProject, functionsProjectId, sessionToken, requireSessionToken, createBridge } = input;
  const needsBridge = Boolean(input.hosted || options || functionsProject);
  if (!needsBridge) return null;
  const serverOptions = server.config.server;
  const project = options?.project ?? functionsProjectId ?? undefined;
  const disableAuditLog = options?.disableAuditLog;
  const boundHost = typeof serverOptions.host === 'string' ? serverOptions.host : 'localhost';
  let allowedHosts = resolveAllowedHosts(serverOptions.allowedHosts);
  if (input.allowedHosts !== undefined && input.allowedHosts.length > 0) {
    const merged: string[] = Array.isArray(allowedHosts) ? [...allowedHosts] : [];
    for (const host of input.allowedHosts) {
      if (!merged.includes(host)) merged.push(host);
    }
    // Never turn explicit remote-access entries into `true` bypass.
    allowedHosts = merged;
  }
  const bridgeOptions: BridgeMountOptions = {
    hosted: input.hosted,
    projectKey: input.hosted ? input.projectDir : undefined,
    project,
    disableAuditLog,
    liveHost: input.liveHost,
    sessionToken,
    requireSessionToken,
    remoteAccess: input.remoteAccess,
    upgradeRejectionLogger: input.upgradeRejectionLogger,
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
  const configuredHost = server.config.server.host;
  let rawHost = 'localhost';
  if (typeof configuredHost === 'string' && configuredHost.length > 0) {
    rawHost = configuredHost;
  }
  const host = advertisedHost(rawHost);
  const secure = servesHttps(server);
  const origin = (): BridgeOrigin | null => {
    const address = httpServer.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    return port > 0 ? { host, port, secure } : null;
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
