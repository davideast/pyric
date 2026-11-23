import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { WebSocket } from 'ws';
import type { ServeRuntime } from '../../src/cli/serve.js';
import type { ServeHandle } from '../../src/serve/server.js';

export function rawHttpRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export function tryWsUpgrade(url: string, headers?: Record<string, string>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let ws: WebSocket;
    if (headers) {
      ws = new WebSocket(url, { headers });
    } else {
      ws = new WebSocket(url);
    }
    ws.once('open', () => {
      finish(true);
      ws.close();
    });
    ws.on('error', () => finish(false));
    ws.once('close', () => finish(false));
  });
}

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
`;

export const runtimes: ServeRuntime[] = [];
export const staticHandles: ServeHandle[] = [];
export const viteServers: ViteDevServer[] = [];
export const dirs: string[] = [];

export async function cleanupLoopbackSecurityFixtures(): Promise<void> {
  while (viteServers.length > 0) {
    const srv = viteServers.pop();
    if (srv !== undefined) await srv.close();
  }
  while (staticHandles.length > 0) {
    const h = staticHandles.pop();
    if (h !== undefined) await h.stop();
  }
  while (runtimes.length > 0) {
    const rt = runtimes.pop();
    if (rt !== undefined) await rt.handle.stop();
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
}

export function createProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-loopback-security-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, 'public'), { recursive: true });
  writeFileSync(join(cwd, 'public', 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>');
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-security' } }));
  writeFileSync(
    join(cwd, 'firebase.json'),
    JSON.stringify({
      firestore: { rules: 'firestore.rules' },
      hosting: { public: 'public' },
    }),
  );
  writeFileSync(join(cwd, 'firestore.rules'), RULES);
  writeFileSync(join(cwd, 'seed.json'), JSON.stringify({ 'users/u1': { name: 'Ada' } }));
  return cwd;
}
