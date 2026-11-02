/**
 * The Codex adapter: OpenAI's Codex CLI (`codex exec --json`) on the ChatGPT
 * subscription that `codex login` signed in on the host, behind the
 * factory's agent interface (`../../agent.ts`). See `README.md` here.
 */
import type { AgentAdapter } from '../../agent.ts';
import { codexHomeOf, codexInvocation, FACTORY_MODEL } from './command.ts';
import { parseEvents, reportsUsageLimit } from './events.ts';
import { codexInstall } from './install.ts';
import { CODEX_LOGIN_DIR, readCodexCredential } from './login.ts';
import { CHATGPT_HOST, checkBody, isForwardedHeader, lineRefusal } from './policy.ts';
import { rateLimitOf } from './rate-limit.ts';

/** How long a forwarded request may take. A turn at maximum reasoning can stream for a long time. */
export const CODEX_UPSTREAM_TIMEOUT_MS = 30 * 60_000;

export const codexAgent: AgentAdapter = {
  name: 'codex',
  install: (env) => codexInstall(env),
  credentialDirs: [CODEX_LOGIN_DIR],
  readCredential: () => readCodexCredential(),
  policy: {
    upstream: { host: CHATGPT_HOST, port: 443, tls: true },
    lineRefusal,
    isForwardedHeader,
    checkBody: (body) => checkBody(body, FACTORY_MODEL),
    rateLimitOf,
    timeoutMs: CODEX_UPSTREAM_TIMEOUT_MS,
  },
  homeDirs: (home) => [codexHomeOf(home)],
  invocation: (session, bridgeUrl, env) => codexInvocation(session, bridgeUrl, env),
  reportsRateLimit: (output) => reportsUsageLimit(parseEvents(output)),
};
