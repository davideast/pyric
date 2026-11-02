/**
 * A made-up agent adapter for the factory's generic tests: a scripted CLI
 * (`fake-agent-cli.ts`), a made-up credential, and an upstream policy as
 * small as the interface allows. The stand-in upstream is
 * `fake-upstream.ts`. Nothing here is any real agent's.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AgentAdapter, Credential, RateLimit } from '../agent.ts';

export const FIXTURES = fileURLToPath(new URL('.', import.meta.url));
export const FAKE_AGENT_CLI = join(FIXTURES, 'fake-agent-cli.ts');
export const FAKE_MODEL = 'fake-model';
export const FAKE_TOKEN = 'made-up-fake-agent-token';
export const FAKE_PATH = '/v1/responses';

export const fakeCredential: Credential = {
  headers: { authorization: `Bearer ${FAKE_TOKEN}` },
  secrets: [FAKE_TOKEN],
  problemAt: () => undefined,
};

const bodySchema = z.object({ model: z.string() }).passthrough();
const limitSchema = z.object({ resets_at: z.number() }).passthrough();

function rateLimitOf(status: number, _headers: unknown, body: string): RateLimit {
  const limitReached = status === 429;
  let resetAt: string | null = null;
  try {
    const parsed = limitSchema.safeParse(JSON.parse(body));
    if (limitReached && parsed.success) resetAt = new Date(parsed.data.resets_at * 1000).toISOString();
  } catch {
    // Not a limit body.
  }
  return { limitReached, resetAt, usedPercent: {} };
}

function lineRefusal(method: string, target: string): string | undefined {
  if (method !== 'POST') return 'method';
  if (target !== FAKE_PATH) return 'path';
  return undefined;
}

export function fakeAgent(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'fake',
    install: () => ({ command: FAKE_AGENT_CLI, binds: [FIXTURES] }),
    credentialDirs: [],
    readCredential: () => ({ ok: true, credential: fakeCredential }),
    policy: {
      upstream: { host: 'upstream.invalid', port: 443, tls: true },
      lineRefusal,
      isForwardedHeader: (name) => name === 'content-type' || name === 'accept' || name.startsWith('x-fake-'),
      checkBody: (body) => {
        try {
          const parsed = bodySchema.safeParse(JSON.parse(body.toString('utf8')));
          if (!parsed.success) return { ok: false, reason: 'body-not-json', names: [] };
          return parsed.data.model === FAKE_MODEL ? { ok: true, model: FAKE_MODEL } : { ok: false, reason: 'other-model', names: [parsed.data.model] };
        } catch {
          return { ok: false, reason: 'body-not-json', names: [] };
        }
      },
      rateLimitOf,
      timeoutMs: 10_000,
    },
    homeDirs: (home) => [join(home, '.fake-agent')],
    invocation: (session, bridgeUrl, env) => ({
      command: session.command,
      args: ['--base-url', bridgeUrl, '--instructions', session.instructions, '--', session.prompt],
      env: { ...env, FAKE_AGENT_HOME: join(session.home, '.fake-agent') },
    }),
    reportsRateLimit: (output) => output.includes('"type":"usage-limit"'),
    ...overrides,
  };
}
