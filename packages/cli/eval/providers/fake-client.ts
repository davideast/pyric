/**
 * The process the fake provider spawns. It is a real MCP client: it starts the
 * server command over stdio exactly as a CLI would, issues the canned calls in
 * order, and closes the transport so the server flushes its snapshot.
 *
 * It prints one JSON line per call to stdout. The runner captures that stream
 * as raw output and never parses it for scoring, matching how the real CLIs are
 * treated.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FakePlan } from './fake.js';
import { MINTED_TOKEN, NEXT_CURSOR } from './fake.js';
import { spawnEnv } from './server-env.js';

/** The values a run has handed out that a later canned call may name. */
interface Handed {
  cursor: string | null;
  token: string | null;
}

/**
 * A canned transcript cannot name a cursor or a minted token the run has not
 * handed out yet, so an argument written as the `<nextCursor>` or `<token>`
 * placeholder is replaced with the most recent one a call returned.
 * Everything else is sent as written.
 */
function withHanded(args: Record<string, unknown>, handed: Handed): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const placeholder = value === NEXT_CURSOR ? handed.cursor : value === MINTED_TOKEN ? handed.token : undefined;
    if (placeholder !== undefined) {
      if (placeholder !== null) filled[key] = placeholder;
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      filled[key] = withHanded(value as Record<string, unknown>, handed);
      continue;
    }
    filled[key] = value;
  }
  return filled;
}

/** The string field `name` one tool result's body carries under `data`, if any. */
function dataField(result: unknown, name: 'nextCursor' | 'token'): string | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  for (const part of content) {
    if (part.type !== 'text' || part.text === undefined) continue;
    try {
      const body = JSON.parse(part.text) as { data?: Record<string, unknown> };
      const field = body.data?.[name];
      if (typeof field === 'string') return field;
    } catch {
      // A body that is not JSON carries nothing; the next call sends none.
    }
  }
  return null;
}

async function main(): Promise<number> {
  const planPath = process.argv[2];
  if (planPath === undefined) {
    process.stderr.write('usage: fake-client <plan.json>\n');
    return 2;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as FakePlan;

  const transport = new StdioClientTransport({
    command: plan.server.command,
    args: plan.server.args,
    env: spawnEnv(process.env, plan.server.env),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'pyric-fake-provider', version: '1' });
  await client.connect(transport);

  // A rejected call is part of what the eval measures, so a failure ends that
  // call and not the transcript.
  const handed: Handed = { cursor: null, token: null };
  for (const call of plan.transcript) {
    try {
      const result = await client.callTool({
        name: call.tool,
        arguments: withHanded(call.args, handed),
      });
      handed.cursor = dataField(result, 'nextCursor') ?? handed.cursor;
      handed.token = dataField(result, 'token') ?? handed.token;
      process.stdout.write(`${JSON.stringify({ tool: call.tool, result })}\n`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      process.stdout.write(`${JSON.stringify({ tool: call.tool, error: message })}\n`);
    }
  }

  await client.close();
  return 0;
}

process.exit(await main());
