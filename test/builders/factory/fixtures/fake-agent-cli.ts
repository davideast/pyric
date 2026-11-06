#!/usr/bin/env bun
/**
 * The made-up agent's CLI (`fake-agent.ts`): no model. It sends one request
 * through the bridge and prints JSON lines. Its mode comes from
 * FAKE_AGENT_MODE:
 *
 *   ok          one request, then exit 0
 *   limit       one request that comes back 429, then a rate-limit line, exit 1
 *   fail        one request that comes back 200, then a failure that is not a rate limit, exit 1
 *   crash       no request: exit 1 at once
 *   hang        start, then wait until stopped
 *   grandchild  start a process of its own that outlives it unless its group is signalled, print its pid, then wait
 *   browser     run `session-browser-probe.mjs`, a user agent's use of Chromium, under Node, then one request, exit 0
 *   trickle     no request: a line every 300 ms for 2.4 s, then exit 0
 *   big-line    no request: say whether its stdout is non-blocking, then print one 1 MiB line, exit 0
 *   tools       require `ffmpeg-static` from $APP_DIR under Node, print the path it gives and whether that
 *               and CHROME_PATH exist in the sandbox, then one request, exit 0
 *
 * It also prints its environment's names, its instructions, and what it
 * could do with the three directories the role skills name.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** O_NONBLOCK in the `flags:` line of `/proc/<pid>/fdinfo/<fd>`, which is octal. */
const O_NONBLOCK = 0o4000;

/** Whether fd 1 is non-blocking, read before anything here touches `process.stdout`. */
function stdoutIsNonBlocking(): boolean {
  const flags = /^flags:\s*([0-7]+)$/m.exec(readFileSync('/proc/self/fdinfo/1', 'utf8'))?.[1] ?? '0';
  return (Number.parseInt(flags, 8) & O_NONBLOCK) !== 0;
}

const stdoutNonBlocking = stdoutIsNonBlocking();
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

/** One line larger than a pipe's 64 KiB buffer, as an agent prints when it reads a whole large file. */
const BIG_LINE_BYTES = 1024 * 1024;

const TRICKLE_EVERY_MS = 300;
const TRICKLE_TICKS = 8;

/** What the app's own `ffmpeg-static` resolves to in the session, and whether the session can see it and Chromium. */
function toolsEvent(): unknown {
  const required = spawnSync('node', ['-e', "process.stdout.write(require('ffmpeg-static'))"], { cwd: process.env.APP_DIR, encoding: 'utf8' });
  const ffmpeg = required.stdout;
  const chrome = process.env.CHROME_PATH ?? '';
  return {
    type: 'tools',
    ffmpeg, ffmpegExists: ffmpeg !== '' && existsSync(ffmpeg), ffmpegPath: process.env.FFMPEG_PATH, requireError: required.stderr,
    chrome, chromeExists: chrome !== '' && existsSync(chrome),
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
} else if (mode === 'trickle') {
  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    print({ type: 'tick', ticks });
    if (ticks === TRICKLE_TICKS) process.exit(0);
  }, TRICKLE_EVERY_MS);
} else if (mode === 'big-line') {
  print({ type: 'stdout', nonBlocking: stdoutNonBlocking });
  // Exit once the line is written: an exit straight away drops what is still buffered.
  process.stdout.write(`${JSON.stringify({ type: 'big', text: 'x'.repeat(BIG_LINE_BYTES) })}\n`, () => process.exit(0));
} else if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  print({ type: 'grandchild', pid: child.pid });
  hang();
} else {
  if (mode === 'browser') spawnSync('node', [fileURLToPath(new URL('./session-browser-probe.mjs', import.meta.url))], { stdio: 'inherit' });
  if (mode === 'tools') print(toolsEvent());
  const response = await fetch(`${flag('--base-url')}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-model' }) });
  await response.text();
  if (response.status === 200 && mode !== 'fail') {
    print({ type: 'done' });
    process.exit(0);
  }
  print(response.status === 429 ? { type: 'rate-limit' } : { type: 'failed' });
  process.exit(1);
}
