/**
 * `inspect_auth_flow` advertises `take_mail`. A call must reach the sandbox's
 * Auth outbox: it returns a message the application issued, removes it, and
 * leaves the stored accounts unchanged.
 *
 * The call goes through a real MCP session over a rendered discriminator
 * surface, so the schema, the route, the canonical dispatch, the method
 * record, and the engine outbox are exercised together.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAuth, sandbox as sandboxAuth, sendPasswordResetEmail, sendSignInLinkToEmail } from 'pyric/auth';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import { createLocalBridge } from '../../../src/bridge/server/local-bridge.js';
import { registerRenderedSurface } from '../../../src/bridge/server/surface-server.js';
import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';

interface Session {
  client: Client;
  sandbox: LocalSandbox;
  close(): Promise<void>;
}

async function openSurface(): Promise<Session> {
  const sandbox = initializeSandbox();
  const bridge = createLocalBridge(sandbox, {});
  const server = new McpServer({ name: 'pyric', version: bridge.version });
  registerRenderedSurface(server, bridge, renderSurface('discriminator'), createSurfaceContext(sandbox), {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'i21-take-mail', version: '0' });
  await client.connect(clientTransport);
  return { client, sandbox, close: () => client.close() };
}

interface MailResult {
  ok: boolean;
  data?: { mail: { operation: string; email: string; code: string; link: string } | null };
}

async function takeMail(session: Session, email?: string): Promise<MailResult> {
  const called = await session.client.callTool({
    name: 'inspect_auth_flow',
    arguments: email === undefined ? { action: 'take_mail' } : { action: 'take_mail', email },
  });
  expect(called.isError).toBeFalsy();
  const blocks = called.content as Array<{ type: string; text: string }>;
  return JSON.parse(blocks[0]!.text) as MailResult;
}

describe('inspect_auth_flow take_mail', () => {
  it('returns and consumes a message the application issued', async () => {
    const session = await openSurface();
    try {
      const auth = getAuth(session.sandbox);
      sandboxAuth.createUser(auth, { uid: 'ada', email: 'ada@example.com', password: 'correct-horse' });
      await sendPasswordResetEmail(auth, 'ada@example.com');
      const usersBefore = JSON.stringify(sandboxAuth.listUsers(auth));

      const first = await takeMail(session);
      expect(first.ok).toBe(true);
      expect(first.data?.mail).toMatchObject({ operation: 'PASSWORD_RESET', email: 'ada@example.com' });
      expect(first.data?.mail?.code.length).toBeGreaterThan(0);
      expect(first.data?.mail?.link).toContain(first.data!.mail!.code);

      const second = await takeMail(session);
      expect(second.ok).toBe(true);
      expect(second.data?.mail).toBeNull();
      expect(sandboxAuth.listAuthMail(auth)).toEqual([]);
      expect(JSON.stringify(sandboxAuth.listUsers(auth))).toBe(usersBefore);
    } finally {
      await session.close();
    }
  });

  it('filters by recipient and leaves other messages in the outbox', async () => {
    const session = await openSurface();
    try {
      const auth = getAuth(session.sandbox);
      const settings = { url: 'https://app.example.com/finish', handleCodeInApp: true };
      await sendSignInLinkToEmail(auth, 'first@example.com', settings);
      await sendSignInLinkToEmail(auth, 'second@example.com', settings);

      const taken = await takeMail(session, 'SECOND@example.com');
      expect(taken.data?.mail).toMatchObject({ operation: 'EMAIL_SIGNIN', email: 'second@example.com' });
      expect(sandboxAuth.listAuthMail(auth).map((mail) => mail.email)).toEqual(['first@example.com']);

      const none = await takeMail(session, 'nobody@example.com');
      expect(none.ok).toBe(true);
      expect(none.data?.mail).toBeNull();
      expect(sandboxAuth.listAuthMail(auth).length).toBe(1);
    } finally {
      await session.close();
    }
  });
});
