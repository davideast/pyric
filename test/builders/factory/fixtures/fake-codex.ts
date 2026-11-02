#!/usr/bin/env bun
/**
 * A scripted `codex exec --json` for the session runner's tests: no model.
 * It reads the base URL, model and developer instructions from its
 * arguments as Codex would, sends one turn through the bridge, and prints
 * events in Codex's shape. Its mode comes from FAKE_CODEX_MODE:
 *
 *   ok     one turn, then exit 0
 *   limit  one turn that comes back 429, then Codex's usage-limit failure, exit 1
 *   hang   start, then wait until stopped
 *
 * It also prints its environment's names, its instructions, and what it
 * could do with the three directories the role skills name: read
 * `$BRIEF_DIR/BRIEF.md`, write `$RUN_DIR` and `$APP_DIR`, and not write
 * `$BRIEF_DIR`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const setting = (key: string) => args.find((arg, index) => args[index - 1] === '-c' && arg.startsWith(`${key}=`))?.slice(key.length + 1);
const baseUrl = JSON.parse(setting('model_providers.pyric.base_url') ?? '""') as string;
const model = args[args.indexOf('-m') + 1];
const print = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
const LIMIT = 'You\'ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 11:11 AM.';

/** What happened when it tried: `ok`, or the error's code. */
function attempt(action: () => unknown): string {
  try {
    action();
    return 'ok';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'error';
  }
}

function dirsEvent(): unknown {
  const { BRIEF_DIR: brief = '', RUN_DIR: run = '', APP_DIR: app = '' } = process.env;
  return {
    type: 'fake.dirs',
    brief, run, app,
    readBrief: attempt(() => readFileSync(join(brief, 'BRIEF.md'), 'utf8')),
    writeRun: attempt(() => writeFileSync(join(run, 'from-session.txt'), 'written in the session')),
    writeApp: attempt(() => writeFileSync(join(app, 'from-session.txt'), 'written in the session')),
    writeBrief: attempt(() => writeFileSync(join(brief, 'from-session.txt'), 'must not land')),
  };
}

print({ type: 'thread.started', thread_id: 'fake' });
print({ type: 'fake.env', names: Object.keys(process.env).sort() });
print({ type: 'fake.instructions', text: JSON.parse(setting('developer_instructions') ?? '""') });
print(dirsEvent());
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
