import { bundleWorker, defaultSdkEntries, workerSourceHash } from '../../src/serve/bundler.js';
import { pyric } from '../../src/serve/vite-plugin.js';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { homedir } from 'node:os';

export const viteEntries = defaultSdkEntries();
let workerWarmup: Promise<unknown> | null = null;

export function warmViteWorkerBundle(): Promise<unknown> {
  workerWarmup ??= bundleWorker({
    outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()),
  });
  return workerWarmup;
}

export class MockRes extends Writable {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  headersSent = false;
  private chunks: Buffer[] = [];

  writeHead(code: number, headers?: Record<string, unknown>): this {
    this.statusCode = code;
    if (headers) {
      for (const key of Object.keys(headers)) this.headers[key.toLowerCase()] = headers[key];
    }
    this.headersSent = true;
    return this;
  }

  setHeader(key: string, value: unknown): void {
    this.headers[key.toLowerCase()] = value;
  }

  getHeader(key: string): unknown {
    return this.headers[key.toLowerCase()];
  }

  override _write(
    chunk: Buffer | string,
    _encoding: unknown,
    callback: (error?: Error) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk as Buffer));
    callback();
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export interface PyricReq {
  method: string;
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
}

export type PyricMiddleware = (
  request: PyricReq,
  response: MockRes,
  next: () => void,
) => void;

export async function bootPluginInstance(
  options: Record<string, unknown>,
  root: string,
): Promise<{ handler: PyricMiddleware; plugin: ReturnType<typeof pyric> }> {
  let handler: PyricMiddleware | undefined;
  const plugin = pyric(options);
  const stub = {
    config: {
      root,
      logger: { info() {}, warn() {} },
      server: { allowedHosts: [], host: 'localhost' },
    },
    middlewares: {
      use(route: string, middleware: PyricMiddleware) {
        if (route === '/__pyric') handler = middleware;
      },
    },
    watcher: { add() {}, on() {} },
    httpServer: { address: () => ({ port: 5173 }), on() {}, once() {} },
  };
  await (plugin.configureServer as (server: unknown) => Promise<void>)(stub);
  if (!handler) throw new Error('plugin did not mount the /__pyric middleware');
  return { handler, plugin };
}

export async function bootPlugin(
  options: Record<string, unknown>,
  root: string,
): Promise<PyricMiddleware> {
  return (await bootPluginInstance(options, root)).handler;
}

export async function callPyric(
  handler: PyricMiddleware,
  options: {
    method?: string;
    path: string;
    mountedPath?: string;
    host?: string;
    headers?: Record<string, string>;
  },
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string; nexted: boolean }> {
  const request: PyricReq = {
    method: options.method ?? 'GET',
    url: options.mountedPath ?? options.path,
    originalUrl: options.path,
    headers: { host: options.host ?? 'localhost', ...(options.headers ?? {}) },
  };
  const response = new MockRes();
  let nexted = false;
  await new Promise<void>((resolve, reject) => {
    response.on('finish', resolve);
    response.on('error', reject);
    try {
      handler(request, response, () => {
        nexted = true;
        resolve();
      });
    } catch (error) {
      reject(error as Error);
    }
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    nexted,
  };
}

export async function callPyricStack(
  handlers: PyricMiddleware[],
  options: { method?: string; path: string; host?: string; headers?: Record<string, string> },
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string; nexted: boolean }> {
  const request: PyricReq = {
    method: options.method ?? 'GET',
    url: options.path,
    originalUrl: options.path,
    headers: { host: options.host ?? 'localhost', ...(options.headers ?? {}) },
  };
  const response = new MockRes();
  let nexted = false;
  await new Promise<void>((resolve, reject) => {
    response.on('finish', resolve);
    response.on('error', reject);
    const dispatch = (index: number): void => {
      if (index === handlers.length) {
        nexted = true;
        resolve();
        return;
      }
      try {
        handlers[index]!(request, response, () => dispatch(index + 1));
      } catch (error) {
        reject(error as Error);
      }
    };
    dispatch(0);
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    nexted,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function initJson(handler: PyricMiddleware): Promise<any> {
  return JSON.parse((await callPyric(handler, { path: '/__pyric/init.json' })).body);
}
