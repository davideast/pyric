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
    env: { ...(process.env as Record<string, string>), ...plan.server.env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'pyric-fake-provider', version: '1' });
  await client.connect(transport);

  // A rejected call is part of what the eval measures, so a failure ends that
  // call and not the transcript.
  for (const call of plan.transcript) {
    try {
      const result = await client.callTool({ name: call.tool, arguments: call.args });
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
