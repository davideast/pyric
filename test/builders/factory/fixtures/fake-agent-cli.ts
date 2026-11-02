#!/usr/bin/env bun
/**
 * The made-up agent's CLI (`fake-agent.ts`): no model. It sends one request
 * through the bridge and prints JSON lines. Its mode comes from
 * FAKE_AGENT_MODE:
 *
 *   ok          one request, then exit 0
 *   limit       one request that comes back 429, then a usage-limit line, exit 1
 *   fail        one request that comes back 200, then a failure that is not a usage limit, exit 1
 *   crash       no request: exit 1 at once
 *   hang        start, then wait until stopped
 *   grandchild  start a process of its own that outlives it unless its group is signalled, print its pid, then wait
 *
 * It also prints its environment's names, its instructions, and what it
 * could do with the three directories the role skills name.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1] ?? '';
const print = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);

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
    type: 'dirs',
    brief, run, app,
    readBrief: attempt(() => readFileSync(join(brief, 'BRIEF.md'), 'utf8')),
    writeRun: attempt(() => writeFileSync(join(run, 'from-session.txt'), 'written in the session')),
    writeApp: attempt(() => writeFileSync(join(app, 'from-session.txt'), 'written in the session')),
    writeBrief: attempt(() => writeFileSync(join(brief, 'from-session.txt'), 'must not land')),
  };
}

const hang = () => setInterval(() => {}, 1000);

print({ type: 'env', names: Object.keys(process.env).sort() });
print({ type: 'instructions', text: flag('--instructions') });
print(dirsEvent());
const mode = process.env.FAKE_AGENT_MODE ?? 'ok';
if (mode === 'crash') {
  print({ type: 'failed' });
  process.exit(1);
} else if (mode === 'hang') {
  hang();
} else if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  print({ type: 'grandchild', pid: child.pid });
  hang();
} else {
  const response = await fetch(`${flag('--base-url')}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-model' }) });
  await response.text();
  if (response.status === 200 && mode !== 'fail') {
    print({ type: 'done' });
    process.exit(0);
  }
  print(response.status === 429 ? { type: 'usage-limit' } : { type: 'failed' });
  process.exit(1);
}
