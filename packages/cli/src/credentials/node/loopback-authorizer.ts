/**
 * Node loopback `Authorizer`: bind a localhost server on an ephemeral port, open
 * the consent URL, and catch Google's redirect. Pre-mortem hardening: port `0`
 * (never "address in use"), a hard timeout, `state` validation (CSRF), single-
 * settle, and an injected `openUrl` so a headless box falls back to the printed
 * URL (and so tests can drive the redirect without a real browser).
 */
import { createServer } from 'node:http';
import type { Authorizer, AuthorizeRequest, AuthorizeResult } from '../core/types.js';

const page = (title: string, body: string) =>
  `<!doctype html><meta charset=utf-8><title>pyric</title>` +
  `<body style="font-family:system-ui;padding:3rem;max-width:32rem"><h2>${title}</h2><p>${body}</p>`;
const SUCCESS_HTML = page('Signed in to pyric', 'You can close this tab and return to your terminal.');
const ERROR_HTML = page('Sign-in was cancelled', 'Return to your terminal and try again.');

export interface LoopbackDeps {
  /** Open the consent URL. Injected: the browser opener in production, a fake in
   *  tests. May fail/no-op (headless) — the URL is printed regardless. */
  openUrl: (url: string) => void | Promise<void>;
  /** Status + paste-fallback output. */
  print: (line: string) => void;
  /** Abort after this many ms. Default 120s. */
  timeoutMs?: number;
}

export function loopbackAuthorizer(deps: LoopbackDeps): Authorizer {
  return {
    authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
      return new Promise<AuthorizeResult>((resolve, reject) => {
        let redirectUri = '';
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          server.close();
          fn();
        };
        const server = createServer((rq, rs) => {
          const u = new URL(rq.url ?? '/', redirectUri || 'http://127.0.0.1');
          if (u.pathname !== '/') {
            rs.writeHead(404).end();
            return;
          }
          const error = u.searchParams.get('error');
          const code = u.searchParams.get('code');
          const state = u.searchParams.get('state');
          const ok = !error && !!code && state === req.state;
          rs.writeHead(ok ? 200 : 400, { 'content-type': 'text/html' }).end(ok ? SUCCESS_HTML : ERROR_HTML);
          if (error) return finish(() => reject(new Error(`sign-in cancelled (${error})`)));
          if (!code) return finish(() => reject(new Error('sign-in: no authorization code in the redirect')));
          if (state !== req.state) {
            return finish(() => reject(new Error('sign-in: state mismatch (possible CSRF) — aborted')));
          }
          finish(() => resolve({ code, redirectUri }));
        });
        const timer = setTimeout(
          () => finish(() => reject(new Error('sign-in timed out. Run `pyric login` to retry.'))),
          deps.timeoutMs ?? 120_000,
        );
        server.on('error', (e) => finish(() => reject(e)));
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          redirectUri = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
          const authUrl = req.buildUrl(redirectUri);
          deps.print('Opening your browser to sign in...');
          deps.print(`   or open: ${authUrl}`);
          void Promise.resolve(deps.openUrl(authUrl)).catch(() =>
            deps.print('(could not open a browser automatically — open the URL above)'),
          );
        });
      });
    },
  };
}
