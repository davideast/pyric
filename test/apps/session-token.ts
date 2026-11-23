/**
 * Per-boot `.pyric/serve.json` and `.pyric/session.json` capability token
 * lookup for scenario HTTP probes against local Pyric hosts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads the per-boot session capability token from `.pyric/serve.json` or
 * `.pyric/session.json` in `app.dir` (or a nested `web/` or `rules/` folder),
 * matching `url`'s port first when `url` is provided.
 */
export function sessionToken(app: { readonly dir: string }, url?: string): string {
  const targetPort = url !== undefined ? Number(new URL(url).port) : undefined;
  let fallback: string | undefined;
  for (const sub of ['', 'web', 'rules']) {
    for (const name of ['serve.json', 'session.json']) {
      const candidate = sub ? join(app.dir, sub, '.pyric', name) : join(app.dir, '.pyric', name);
      if (!existsSync(candidate)) continue;
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { port?: number; token?: string; sessionToken?: string };
        const token = parsed.token ?? parsed.sessionToken;
        if (typeof token !== 'string' || token.length === 0) continue;
        if (targetPort !== undefined && parsed.port === targetPort) return token;
        fallback ??= token;
      } catch (error) {
        // Ignore a pointer being rewritten mid-restart.
        if (!(error instanceof Error)) throw error;
      }
    }
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`No .pyric session capability token found for ${url ?? app.dir}`);
}

export function sessionHeaders(app: { readonly dir: string }, url?: string): Record<string, string> {
  return { 'x-pyric-session-token': sessionToken(app, url) };
}
