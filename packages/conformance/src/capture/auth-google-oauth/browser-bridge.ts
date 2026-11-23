/**
 * Loopback HTTP bridge serving the two-popup `firebase/auth` page on
 * `http://localhost:<port>` for the `auth-google-oauth` human-witnessed rig (#1814).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type {
  CollisionCaseKind,
  GooglePopupDriver,
  GooglePopupStepResult,
} from './session-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface PopupBridgeSession {
  readonly url: string;
  readonly popupDriver: GooglePopupDriver;
  finish(message: string): void;
  close(): Promise<void>;
}

interface PendingPopupStep {
  readonly step: CollisionCaseKind;
  readonly expectedEmail: string;
  resolve(result: GooglePopupStepResult): void;
  reject(err: Error): void;
}

function renderIndexHtml(bootstrapJson: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Pyric #1814 Google OAuth Oracle Capture</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 20px; line-height: 1.5; }
    h1 { font-size: 1.35rem; }
    .card { border: 1px solid #ccc; border-radius: 8px; padding: 20px; margin-top: 16px; }
    .mono { font-family: ui-monospace, monospace; font-weight: 600; }
    button { font-size: 1rem; padding: 10px 18px; margin-top: 14px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <h1>Google OAuth Unverified-Account Capture (#1814)</h1>
  <p>Use dedicated throwaway Google accounts only. Sign in with the exact account shown for each step.</p>
  <div class="card">
    <div id="status">Connecting to local capture harness...</div>
    <div id="step-detail" class="mono" style="margin-top: 8px;"></div>
    <button id="run-step" disabled>Waiting...</button>
  </div>
  <script id="pyric-oauth-bootstrap" type="application/json">${bootstrapJson}</script>
  <script type="module" src="/main.js"></script>
</body>
</html>`;
}

function tryOpenSystemBrowser(url: string): void {
  let command: string | null = null;
  if (process.platform === 'darwin') {
    command = 'open';
  } else if (process.platform === 'linux') {
    command = 'xdg-open';
  }
  if (!command) {
    return;
  }
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Operator can always open the printed localhost URL manually.
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    let buf: Buffer;
    if (Buffer.isBuffer(chunk)) {
      buf = chunk;
    } else {
      buf = Buffer.from(chunk as Uint8Array);
    }
    total += buf.length;
    if (total > 64 * 1024) {
      throw new Error('Request body exceeded 64 KiB.');
    }
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

let cachedMainJsPromise: Promise<string> | null = null;

async function bundlePopupClientJs(): Promise<string> {
  if (cachedMainJsPromise === null) {
    cachedMainJsPromise = (async () => {
      const built = await Bun.build({
        entrypoints: [join(HERE, 'app', 'main.ts')],
        target: 'browser',
        format: 'esm',
      });
      if (!built.success || built.outputs.length === 0) {
        cachedMainJsPromise = null;
        throw new Error(
          `Failed to bundle browser popup app: ${built.logs.map(String).join('\n')}`,
        );
      }
      const firstOutput = built.outputs[0];
      if (!firstOutput) {
        cachedMainJsPromise = null;
        throw new Error('Browser popup bundle produced zero outputs.');
      }
      return firstOutput.text();
    })();
  }
  return cachedMainJsPromise;
}

export async function startGoogleOAuthPopupBridge(options: {
  readonly webConfig: Record<string, string>;
  readonly port: number;
  readonly openBrowser: boolean;
  readonly log?: (message: string) => void;
}): Promise<PopupBridgeSession> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const sessionToken = randomBytes(24).toString('hex');
  const mainJs = await bundlePopupClientJs();
  const bootstrapJson = JSON.stringify({
    webConfig: options.webConfig,
    sessionToken,
  }).replace(/</g, '\\u003c');
  const indexHtml = renderIndexHtml(bootstrapJson);

  let activeStep: PendingPopupStep | null = null;
  let terminalMessage: string | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const server = createServer(async (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && urlPath === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(indexHtml);
      return;
    }
    if (req.method === 'GET' && urlPath === '/main.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(mainJs);
      return;
    }

    const tokenHeader = req.headers['x-pyric-oauth-token'];
    if (tokenHeader !== sessionToken) {
      sendJson(res, 403, { error: 'invalid session token' });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/next-step') {
      if (terminalMessage !== null) {
        sendJson(res, 200, { state: 'done', message: terminalMessage });
        return;
      }
      if (activeStep !== null) {
        sendJson(res, 200, {
          state: 'ready',
          step: activeStep.step,
          expectedEmail: activeStep.expectedEmail,
        });
        return;
      }
      sendJson(res, 200, { state: 'waiting' });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/step-result') {
      try {
        const body = await readJsonBody(req);
        if (!activeStep || body.step !== activeStep.step || typeof body.result !== 'object' || body.result === null) {
          sendJson(res, 409, { error: 'no matching step active' });
          return;
        }
        const pending = activeStep;
        activeStep = null;
        pending.resolve(body.result as GooglePopupStepResult);
        sendJson(res, 200, { ok: true });
      } catch (err: unknown) {
        sendJson(res, 400, { error: String(err) });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });

  const addr = server.address() as AddressInfo;
  const url = `http://localhost:${addr.port}`;
  log(`[auth-google-oauth] interactive sign-in page listening at ${url}`);
  if (options.openBrowser) {
    tryOpenSystemBrowser(url);
  }

  const popupDriver: GooglePopupDriver = {
    runGooglePopup({ step, expectedEmail }): Promise<GooglePopupStepResult> {
      if (closed) {
        return Promise.reject(new Error('Popup bridge closed before step started.'));
      }
      log(`[auth-google-oauth] step '${step}': sign in with ${expectedEmail} at ${url}`);
      return new Promise<GooglePopupStepResult>((resolvePromise, rejectPromise) => {
        activeStep = {
          step,
          expectedEmail,
          resolve: resolvePromise,
          reject: rejectPromise,
        };
      });
    },
  };

  return {
    url,
    popupDriver,
    finish(message: string): void {
      terminalMessage = message;
      if (activeStep !== null) {
        const pending = activeStep;
        activeStep = null;
        pending.reject(new Error(`Popup bridge finished before step completed: ${message}`));
      }
    },
    close(): Promise<void> {
      closed = true;
      if (activeStep !== null) {
        const pending = activeStep;
        activeStep = null;
        pending.reject(new Error('Popup bridge closed before step completed.'));
      }
      if (closePromise === null) {
        closePromise = new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        });
      }
      return closePromise;
    },
  };
}
