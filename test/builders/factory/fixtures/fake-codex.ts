#!/usr/bin/env bun
/**
 * A scripted `codex exec --json` for the session runner's tests: no model.
 * It reads the base URL and model from its arguments as Codex would, sends
 * one turn through the bridge, and prints events in Codex's shape. Its mode
 * comes from FAKE_CODEX_MODE:
 *
 *   ok     one turn, then exit 0
 *   limit  one turn that comes back 429, then Codex's usage-limit failure, exit 1
 *   hang   start, then wait until stopped
 *
 * It also prints its environment's names and its stdin, so the tests can
 * check what reached it.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const setting = (key: string) => args.find((arg, index) => args[index - 1] === '-c' && arg.startsWith(`${key}=`))?.slice(key.length + 1);
const baseUrl = JSON.parse(setting('model_providers.pyric.base_url') ?? '""') as string;
const model = args[args.indexOf('-m') + 1];
const print = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
const LIMIT = 'You\'ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 11:11 AM.';

print({ type: 'thread.started', thread_id: 'fake' });
print({ type: 'fake.env', names: Object.keys(process.env).sort() });
print({ type: 'fake.stdin', text: readFileSync(0, 'utf8') });
const mode = process.env.FAKE_CODEX_MODE ?? 'ok';
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  print({ type: 'turn.started' });
  const response = await fetch(`${baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: [] }) });
  await response.text();
  if (response.status === 200) {
    print({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    process.exit(0);
  }
  print({ type: 'error', message: LIMIT });
  print({ type: 'turn.failed', error: { message: LIMIT } });
  process.exit(1);
}
