/**
 * The Codex login the factory's forwarder puts on each model request: the
 * ChatGPT tokens `codex login` keeps in `~/.codex/auth.json`. Only the
 * harness process reads it, outside every sandbox, and it reads it again
 * for each request, so a refresh made by the host's own Codex is picked up.
 * The harness never refreshes it and never writes it: Codex rotates the
 * refresh token on each refresh, so a second writer would log the host's
 * Codex out. Nothing here says a token's value; a problem names the file
 * and the rule it broke.
 *
 * The file is refused unless it is a regular file (not a link), owned by
 * the current user, with no group or other access, holding a ChatGPT login
 * (`auth_mode: chatgpt` and its tokens).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readPrivateFile } from '../harness-token.ts';

/** Where `codex login` keeps the login, under the default CODEX_HOME. */
export const CODEX_LOGIN_FILE = join(homedir(), '.codex', 'auth.json');

const LABEL = 'the Codex login';

const authSchema = z.object({
  auth_mode: z.literal('chatgpt'),
  tokens: z.object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

export interface CodexLogin {
  accessToken: string;
  accountId: string;
  /** Every token the login holds. The token scan looks for each; none may leave the harness. */
  secrets: string[];
  /** When the access token stops working, from its own `exp`; null when it names none. */
  expiresAt: Date | null;
}

export type LoginRead = { ok: true; login: CodexLogin } | { ok: false; problem: string };

/** The `exp` of a JWT, read without checking its signature: the harness only asks when it lapses. */
export function jwtExpiry(token: string): Date | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = z.object({ exp: z.number() }).safeParse(claims);
    return exp.success ? new Date(exp.data.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** The login from the file's text, or why it is not a ChatGPT login; the reason never holds a value. */
export function loginFromText(path: string, text: string): LoginRead {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: `${LABEL} ${path} is not JSON` };
  }
  const parsed = authSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problem: `${LABEL} ${path} holds no ChatGPT login: run \`codex login\` on the host` };
  const tokens = parsed.data.tokens;
  return {
    ok: true,
    login: {
      accessToken: tokens.access_token,
      accountId: tokens.account_id,
      secrets: [tokens.access_token, tokens.refresh_token, tokens.id_token],
      expiresAt: jwtExpiry(tokens.access_token),
    },
  };
}

/** Reads the login, or says which rule it breaks. `uid` is the current user's by default. */
export function readCodexLogin(path: string = CODEX_LOGIN_FILE, uid: number = process.getuid?.() ?? -1): LoginRead {
  const read = readPrivateFile(path, LABEL, uid);
  if (!read.ok) return read;
  return loginFromText(path, read.text);
}

/** How long before the access token lapses the forwarder stops using it, so no request goes out on a token about to lapse. */
export const EXPIRY_MARGIN_MS = 5 * 60_000;

/** Why the login can't be used at `now`, or undefined when it can. */
export function expiryProblem(login: CodexLogin, now: Date): string | undefined {
  if (login.expiresAt === null) return undefined;
  const lapsed = login.expiresAt.getTime() - EXPIRY_MARGIN_MS <= now.getTime();
  if (!lapsed) return undefined;
  return `the Codex login's access token lapses at ${login.expiresAt.toISOString()}: refresh it on the host (start Codex there, or run \`codex login\`)`;
}
