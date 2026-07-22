import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { FirebaseRc } from '../cli/firebase-json.js';
import type {
  FunctionsRtdbProject,
} from '../functions-rtdb/project.js';
import type { BridgeMount } from './bridge-mount.js';
import type {
  ViteFunctionsDevelopmentAttachment,
  ViteFunctionsDevelopmentOptions,
} from './vite-functions-development.js';

export interface ResolvedViteGenerationFunctions {
  options: { region?: string; instance?: string; watch?: boolean };
  project: FunctionsRtdbProject | null;
  projectId: string | null;
}

export async function resolveViteGenerationFunctions(input: {
  projectDir: string;
  options: false | { region?: string; instance?: string; watch?: boolean };
  discover(projectDir: string): FunctionsRtdbProject | null;
  readFirebaseRc(projectDir: string): Promise<FirebaseRc | null>;
}): Promise<ResolvedViteGenerationFunctions> {
  const { projectDir, options, discover, readFirebaseRc } = input;
  const project = options === false ? null : discover(projectDir);
  let projectId: string | null = null;
  if (project) {
    projectId =
      process.env.PYRIC_PROJECT ??
      (await readFirebaseRc(projectDir))?.projects?.default ??
      'demo-project';
  }
  return {
    options: typeof options === 'object' ? options : {},
    project,
    projectId,
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
  const builtChild = path.join(cliRoot, 'dist/functions-rtdb/child.js');
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
    watcher: server.watcher,
    logger: server.config.logger,
    bridge,
    baseEnv: process.env,
    registerUrl,
    childModuleUrl,
  };
  return attach(attachmentOptions);
}
