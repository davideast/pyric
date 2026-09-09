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
import { NEXT_CURSOR } from './fake.js';
import { spawnEnv } from './server-env.js';

/**
 * A canned transcript cannot name a cursor the run has not handed out yet, so
 * an argument written as the `<nextCursor>` placeholder is replaced with the
 * most recent one a call returned. Everything else is sent as written.
 */
function withCursor(args: Record<string, unknown>, cursor: string | null): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === NEXT_CURSOR) {
      if (cursor !== null) filled[key] = cursor;
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      filled[key] = withCursor(value as Record<string, unknown>, cursor);
      continue;
    }
    filled[key] = value;
  }
  return filled;
}

/** The cursor one tool result hands on, when its body carries one. */
function cursorFrom(result: unknown): string | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  for (const part of content) {
    if (part.type !== 'text' || part.text === undefined) continue;
    try {
      const body = JSON.parse(part.text) as { data?: { nextCursor?: unknown } };
      const next = body.data?.nextCursor;
      if (typeof next === 'string') return next;
    } catch {
      // A body that is not JSON carries no cursor; the next call sends none.
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
  let cursor: string | null = null;
  for (const call of plan.transcript) {
    try {
      const result = await client.callTool({
        name: call.tool,
        arguments: withCursor(call.args, cursor),
      });
      cursor = cursorFrom(result) ?? cursor;
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
