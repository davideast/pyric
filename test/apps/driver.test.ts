import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DependencyStore } from './dependency-store.ts';
import { AppProcess, AppRun, freePort, portIssuer, probePort, type PortIssuer, type ProcessTiming, type SpawnChild } from './driver.ts';
import { runTimedCommand } from './install.ts';

/** A child that never gets a pid, so the driver sends it no signal. */
function standIn(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined });
  return child;
}

function spawnError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: spawn failed, epoll_ctl`), { code });
}

/** A spawner whose children each do what the next script entry says, one tick after they start. */
function scriptedSpawner(script: Array<(child: ChildProcess) => void>): { spawnChild: SpawnChild; spawned: () => number } {
  let count = 0;
  const spawnChild: SpawnChild = () => {
    const child = standIn();
    const act = script[count] ?? script[script.length - 1]!;
    count += 1;
    queueMicrotask(() => act(child));
    return child;
  };
  return { spawnChild, spawned: () => count };
}

const failsWith = (code: string) => (child: ChildProcess) => { child.emit('error', spawnError(code)); };
const closesWith = (code: number) => (child: ChildProcess) => { child.emit('close', code, null); };

function appProcess(spawnChild: SpawnChild): AppProcess {
  return new AppProcess('stand-in', 'node', ['server.mjs'], '.', {}, spawnChild);
}

describe('spawn retry', () => {
  test('an EBADF before any output starts the child once more', async () => {
    const { spawnChild, spawned } = scriptedSpawner([failsWith('EBADF'), closesWith(0)]);
    const child = appProcess(spawnChild);
    expect(await child.exited).toBe(0);
    expect(spawned()).toBe(2);
    expect(child.output).toContain('could not start node: EBADF: spawn failed, epoll_ctl; the child wrote no output, so the driver starts it once more');
  });

  test('a second EBADF fails the process', async () => {
    const { spawnChild, spawned } = scriptedSpawner([failsWith('EBADF'), failsWith('EBADF')]);
    const child = appProcess(spawnChild);
    expect(await child.exited).toBeNull();
    expect(spawned()).toBe(2);
    expect(child.running).toBe(false);
    expect(child.output.trimEnd().endsWith('[driver] could not start node: EBADF: spawn failed, epoll_ctl')).toBe(true);
  });

  test('another spawn error does not retry', async () => {
    const { spawnChild, spawned } = scriptedSpawner([failsWith('ENOENT'), closesWith(0)]);
    const child = appProcess(spawnChild);
    expect(await child.exited).toBeNull();
    expect(spawned()).toBe(1);
  });

  test('an EBADF after the child wrote output does not retry', async () => {
    const wroteThenFailed = (child: ChildProcess) => {
      child.stdout!.emit('data', 'listening\n');
      child.emit('error', spawnError('EBADF'));
    };
    const { spawnChild, spawned } = scriptedSpawner([wroteThenFailed, closesWith(0)]);
    const child = appProcess(spawnChild);
    expect(await child.exited).toBeNull();
    expect(spawned()).toBe(1);
    expect(child.output).toStartWith('listening\n');
  });

  test('events from the abandoned child are ignored', async () => {
    let first: ChildProcess | undefined;
    const failThenClose = (child: ChildProcess) => {
      first = child;
      child.emit('error', spawnError('EBADF'));
    };
    const { spawnChild } = scriptedSpawner([failThenClose, () => {}]);
    const child = appProcess(spawnChild);
    await Promise.resolve();
    await Promise.resolve();
    first!.emit('close', 1, null);
    first!.stdout!.emit('data', 'late\n');
    expect(child.running).toBe(true);
    expect(child.output).not.toContain('late');
  });
});

describe('stop', () => {
  test('a child that never closes after SIGKILL is recorded as gone', async () => {
    // The group's shell and sleep die, but a sleep in its own session keeps
    // the stdout pipe open, so the child exits and never emits `close`.
    const child = new AppProcess(
      'pipe holder',
      'sh',
      ['-c', `setsid sh -c 'echo $$; exec sleep 30' & exec sleep 30`],
      '.',
      { PATH: process.env.PATH },
    );
    const match = await child.waitForLog(/^(\d+)$/m, { timeoutMs: 5_000 });
    const holder = Number(match[1]);
    try {
      await child.stop({ termMs: 200, killMs: 200 });
      expect(child.running).toBe(false);
      expect(await child.exited).toBeNull();
      expect(child.output).toContain('[driver] pipe holder did not close within 0.2s of SIGKILL; the driver records it as gone');
    } finally {
      try { process.kill(holder, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  test('a child that closes on SIGTERM stops without the SIGKILL note', async () => {
    const child = new AppProcess('sleeper', 'sleep', ['30'], '.', { PATH: process.env.PATH });
    await child.stop({ termMs: 2_000, killMs: 200 });
    expect(child.running).toBe(false);
    expect(child.output).toContain('[driver] exited on SIGTERM');
    expect(child.output).not.toContain('records it as gone');
  });
});

/** A probe that returns each scripted port in turn, then repeats the last one. */
function scriptedProbe(script: number[]): { probe: () => Promise<number>; probes: () => number } {
  let count = 0;
  const probe = async (): Promise<number> => {
    const port = script[count] ?? script[script.length - 1]!;
    count += 1;
    return port;
  };
  return { probe, probes: () => count };
}

describe('port issuer', () => {
  test('a probe that repeats a port is asked again, so the second port differs', async () => {
    const { probe, probes } = scriptedProbe([33093, 33093, 33094]);
    const ports = portIssuer(probe);
    const first = await ports.next();
    const second = await ports.next();
    expect([first, second]).toEqual([33093, 33094]);
    expect(probes()).toBe(3);
  });

  test('a probe that only repeats fails with the ports it returned', async () => {
    const { probe, probes } = scriptedProbe([33093]);
    const ports = portIssuer(probe);
    await ports.next();
    await expect(ports.next()).rejects.toThrow(/^no unissued port after 32 probes; the probe only returned 33093$/);
    expect(probes()).toBe(33);
  });

});

/** An app run that is never installed or browsed, with its ports from `ports`. */
function bareRun(ports: PortIssuer): AppRun {
  const noBrowser = () => Promise.reject(new Error('no browser in this test'));
  return new AppRun('stand-in', '.', '.', noBrowser, undefined, ports);
}

describe('allowances that match nothing', () => {
  const run = () => bareRun(portIssuer(probePort));

  test('an expectHostError pattern no error matched fails the app, as an expectedCrashes entry does', () => {
    const app = run();
    app.expectHostError(/^403 POST \/__pyric\/diagnostics$/);
    app.noteErrorResponse(404, 'GET', 'http://127.0.0.1:5173/missing.png');
    expect(app.unexpectedHostErrors()).toEqual([
      'expectHostError(/^403 POST \\/__pyric\\/diagnostics$/) matched no error response from a /__pyric/ route; remove it or fix its pattern',
    ]);
  });

  test('a pattern that matched an error passes, and an error no pattern matched still fails', () => {
    const app = run();
    app.expectHostError(/^403 GET \/__pyric\/storage\/.*token=wrong$/);
    app.noteErrorResponse(403, 'GET', 'http://127.0.0.1:5173/__pyric/storage/v0/b/demo/o/a.txt?alt=media&token=wrong');
    app.noteErrorResponse(500, 'POST', 'http://127.0.0.1:5173/__pyric/denials');
    expect(app.unexpectedHostErrors()).toEqual(['500 POST /__pyric/denials (during "setup")']);
  });

  test('a pattern whose error comes only in some runs says so, and passes a run without it', () => {
    const app = run();
    app.expectHostError(/^404 POST \/__pyric\/diagnostics$/, { mayNotHappen: 'a race decides whether the post lands before the routes mount (#2098)' });
    expect(app.unexpectedHostErrors()).toEqual([]);
  });

  test('a mayNotHappen reason that is blank or cites no issue is refused, naming the pattern', () => {
    const app = run();
    for (const reason of ['', '   ', 'a race decides it']) {
      expect(() => app.expectHostError(/^404 POST \/__pyric\/diagnostics$/, { mayNotHappen: reason }))
        .toThrow('expectHostError(/^404 POST \\/__pyric\\/diagnostics$/): mayNotHappen must say why the error comes only in some runs and cite its issue');
    }
    expect(app.unexpectedHostErrors()).toEqual([]);
  });

  test('an expectLeftoverProcess pattern no leftover matched fails the app', () => {
    const app = run();
    app.expectLeftoverProcess(/^esbuild$/);
    expect(app.unexpectedLeftoverProcesses()).toEqual([
      'expectLeftoverProcess(/^esbuild$/) matched no leftover process; remove it or fix its pattern',
    ]);
  });
});

describe('app ports', () => {
  test('freePort() asks the issuer, so a repeated probe gives a different port', async () => {
    const { probe } = scriptedProbe([33093, 33093, 33094]);
    const ports = portIssuer(probe);
    expect([await freePort(ports), await freePort(ports)]).toEqual([33093, 33094]);
  });

  test('app.freePort() asks the run issuer, so a repeated probe gives a different port', async () => {
    const { probe } = scriptedProbe([33093, 33093, 33094]);
    const app = bareRun(portIssuer(probe));
    expect([await app.freePort(), await app.freePort()]).toEqual([33093, 33094]);
  });

  test('a blackholed port is issued, so a later app.freePort() never returns it', async () => {
    const real = await probePort();
    const { probe } = scriptedProbe([real, real, 33094]);
    const app = bareRun(portIssuer(probe));
    try {
      expect(await app.blackholedPort()).toBe(real);
      expect(await app.freePort()).toBe(33094);
    } finally {
      await app.close();
    }
  });
});

/**
 * A stand-in npm: every call writes a debug log to its --logs-dir and leaves
 * a file in node_modules. The calls listed in `hangs` (1-based) then wait on
 * a child, as npm waits on an install script, until stopped; the others
 * write a lockfile and exit 0. A call that finds an earlier call's
 * node_modules says so in `leftovers`.
 */
function fakeNpm(dir: string, hangs: number[]): string {
  const script = join(dir, 'fake-npm.sh');
  writeFileSync(script, `#!/bin/bash
calls="${dir}/calls"
n=$(( $(cat "$calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$calls"
logs=""
for arg in "$@"; do case "$arg" in --logs-dir=*) logs="\${arg#--logs-dir=}";; esac; done
mkdir -p "$logs"
printf '0 verbose cli fake npm call %s\\n1 http fetch GET https://registry.npmjs.org/stalled-%s\\n' "$n" "$n" > "$logs/2026-10-28T12_0\${n}_00_000Z-debug-0.log"
[ -e node_modules/left-by-call ] && echo "call $n found node_modules from an earlier call" >> "${dir}/leftovers"
mkdir -p node_modules && touch node_modules/left-by-call
case " ${hangs.join(' ')} " in *" $n "*) sleep 31 & wait;; esac
echo '{"lockfileVersion":3,"packages":{"":{}}}' > package-lock.json
echo "added 1 package"
`);
  chmodSync(script, 0o755);
  return script;
}

/** An app run whose nested installs come from a store in its own directory, warmed by the stand-in npm. */
function installRun(hangs: number[], app = 'create-pyric-chat-app-check') {
  const work = mkdtempSync(join(tmpdir(), 'pyric-install-project-'));
  mkdirSync(join(work, 'app', 'my-chat'), { recursive: true });
  writeFileSync(join(work, 'app', 'my-chat', 'package.json'), '{"name":"my-chat","private":true}\n');
  const lines: string[] = [];
  const npm = fakeNpm(work, hangs);
  const store = new DependencyStore({
    dir: join(work, 'deps'),
    offline: false,
    packed: [],
    platform: { nodeMajor: '24', npm: '11.13.0', os: 'linux', arch: 'x64' },
    npmCache: join(work, 'cache'),
    runNpm: (args, { cwd, timeoutMs }) => runTimedCommand(npm, args, { cwd, timeoutMs }),
  });
  const noBrowser = () => Promise.reject(new Error('no browser in this test'));
  const nested = { tarballs: new Map(), store, attemptMs: 1_000, report: (line: string) => lines.push(line) };
  const run = new AppRun(app, join(work, 'app'), join(work, 'home'), noBrowser, nested);
  const read = (name: string) => (existsSync(join(work, name)) ? readFileSync(join(work, name), 'utf8') : '');
  return { run, lines, read, work, done: () => rmSync(work, { recursive: true, force: true }) };
}

describe('installProject through the dependency store (#1514)', () => {
  test('a path test/apps/nested-projects.ts does not declare throws, names the list, and installs nothing', async () => {
    const { run, read, done } = installRun([], 'storage-rules-lookup-paths');
    try {
      const failure = await run.installProject('my-chat').then(() => undefined, (error: Error) => error);
      expect(failure?.message).toContain('test/apps/nested-projects.ts does not declare');
      expect(failure?.message).toContain('storage-rules-lookup-paths');
      expect(failure?.message).toContain('my-chat');
      expect(read('calls')).toBe('');
    } finally {
      await run.close();
      done();
    }
  });

  test('a declared project warms its store entry once, and a second install of it comes from the store', async () => {
    const { run, lines, read, work, done } = installRun([]);
    try {
      expect((await run.installProject('my-chat')).code).toBe(0);
      expect(existsSync(join(work, 'app', 'my-chat', 'node_modules', 'left-by-call'))).toBe(true);
      expect(lines.at(-1)).toMatch(/^\[runner\] nested project my-chat for create-pyric-chat-app-check: warmed store entry [0-9a-f]+ from the registry/);
      rmSync(join(work, 'app', 'my-chat', 'node_modules'), { recursive: true, force: true });
      expect((await run.installProject('my-chat')).code).toBe(0);
      expect(read('calls').trim()).toBe('1');
      expect(lines.at(-1)).toMatch(/: from the store, entry [0-9a-f]+/);
    } finally {
      await run.close();
      done();
    }
  }, 20_000);
});

describe('installProject when npm hangs (#1476)', () => {
  test('a hung attempt prints its npm debug log to the run output at once, and a fresh attempt passes', async () => {
    const { run, lines, read, done } = installRun([1]);
    try {
      const result = await run.installProject('my-chat');
      expect(result.code).toBe(0);
      expect(read('calls').trim()).toBe('2');
      expect(read('leftovers')).toBe('');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toStartWith('[runner] create-pyric-chat-app-check: install of my-chat from the dependency store stopped after 1 s');
      expect(lines[0]).toContain('stopped after 1 s; processes in its group:');
      expect(lines[0]).toMatch(/pid \d+ parent \d+ state \w: \S*bash \S*fake-npm\.sh install/);
      expect(lines[0]).toMatch(/pid \d+ parent \d+ state \w: sleep 31/);
      expect(lines[0]).toContain("[runner] the end of npm's debug log 2026-10-28T12_01_00_000Z-debug-0.log");
      expect(lines[0]).toContain('http fetch GET https://registry.npmjs.org/stalled-1');
      expect(lines[1]).toStartWith('[runner] infrastructure retry: create-pyric-chat-app-check: install of my-chat from the dependency store timed out');
      expect(lines[2]).toMatch(/exited 0 in \d+ s, 2 attempts \(1 infrastructure retry\)$/);
      expect(lines[3]).toMatch(/^\[runner\] nested project my-chat for create-pyric-chat-app-check: warmed store entry/);
    } finally {
      await run.close();
      done();
    }
  }, 20_000);

  test('a second hang fails the install with both debug logs, and is not tried a third time', async () => {
    const { run, lines, read, done } = installRun([1, 2]);
    try {
      const failure = await run.installProject('my-chat').then(() => undefined, (error: Error) => error);
      expect(failure?.message).toContain('the install of my-chat timed out on both attempts');
      expect(failure?.message).toContain('stalled-1');
      expect(failure?.message).toContain('stalled-2');
      expect(read('calls').trim()).toBe('2');
      expect(lines.filter((line) => line.includes('from the dependency store stopped after'))).toHaveLength(2);
      expect(lines.at(-2)).toMatch(/timed out in \d+ s, 2 attempts \(1 infrastructure retry\)$/);
    } finally {
      await run.close();
      done();
    }
  }, 20_000);
});

/** The inode of the socket process `pid` writes descriptor `fd` to. */
function socketOf(pid: number | undefined, fd: number): number {
  const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
  if (!match) throw new Error(`fd ${fd} of pid ${pid} is not a socket`);
  return Number(match[1]);
}

/**
 * The socket whose peer is `inode`, from the Peer column of `ss -xan`: the
 * kernel's own record of the other end, read while both ends are open.
 */
function peerOf(inode: number): number {
  const rows = execFileSync('ss', ['-xan'], { encoding: 'utf8' }).split('\n').map((line) => line.trim().split(/\s+/));
  const row = rows.find((fields) => Number(fields[7]) === inode);
  if (row === undefined) throw new Error(`ss lists no socket whose peer is ${inode}`);
  return Number(row[5]);
}

/** The runner's ends of the sockets `pid` writes stdout and stderr to, from the kernel. */
const runnerEndsOf = (pid: number | undefined) => [peerOf(socketOf(pid, 1)), peerOf(socketOf(pid, 2))];

/**
 * A spawner whose children never report `close`, as when the runner loses
 * it (#1274). After each spawn, before the driver looks for the child's
 * sockets, it starts a neighbor with output sockets of its own: sockets the
 * runner opened after the spawn. It notes the runner's end of each socket
 * from the kernel's peer record, not from the driver's numbering rule.
 */
function losingCloseWithNeighbor(): { spawnChild: SpawnChild; childEnds: number[]; neighborEnds: number[]; neighborOutput: Promise<string> } {
  const childEnds: number[] = [];
  const neighborEnds: number[] = [];
  let neighborText = '';
  let neighborDone: (text: string) => void = () => {};
  const neighborOutput = new Promise<string>((resolve) => { neighborDone = resolve; });
  const spawnChild: SpawnChild = (command, args, options) => {
    const child = spawn(command, args, options);
    const neighbor = spawn('sh', ['-c', 'sleep 0.3; echo neighbor-output'], { stdio: ['ignore', 'pipe', 'pipe'] });
    childEnds.push(...runnerEndsOf(child.pid));
    neighborEnds.push(...runnerEndsOf(neighbor.pid));
    neighbor.stdout?.on('data', (chunk) => { neighborText += String(chunk); });
    neighbor.on('close', () => neighborDone(neighborText));
    const emit = child.emit.bind(child);
    child.emit = ((event: string | symbol, ...rest: unknown[]) => (event === 'close' ? false : emit(event, ...rest))) as ChildProcess['emit'];
    return child;
  };
  return { spawnChild, childEnds, neighborEnds, neighborOutput };
}

const LOST_CLOSE_TIMING: ProcessTiming = {
  exit: { outputCloseGraceMs: 200, zombie: { intervalMs: 50, graceMs: 5_000 } },
  stop: { termMs: 200, killMs: 200 },
};

describe('where the output went when the runner lost close (#1797)', () => {
  test.if(process.platform === 'linux')('an exit recorded without `close` logs what the kernel still queues for the child\'s sockets, and only the child\'s', async () => {
    const { spawnChild, childEnds, neighborEnds, neighborOutput } = losingCloseWithNeighbor();
    const script = 'sleep 0.3; echo started; echo refused >&2; exit 1';
    const child = new AppProcess('refuser', 'sh', ['-c', script], '.', { PATH: process.env.PATH }, spawnChild, LOST_CLOSE_TIMING);
    expect(await child.exited).toBe(1);
    expect(child.output).toContain('the runner lost `close`; the driver records the exit (#1274)');
    const [stdoutEnd, stderrEnd] = childEnds;
    expect(child.output).toMatch(new RegExp(`\\[driver\\] refuser's output sockets: stdout [^(]+ \\(socket ${stdoutEnd}, taken as the runner's end\\), stderr [^(]+ \\(socket ${stderrEnd}, taken as the runner's end\\); .+ \\(#1797\\)`));
    for (const end of neighborEnds) expect(child.output).not.toContain(`socket ${end}`);
    // The neighbor's sockets were left alone: its output arrives whole, through its own reader.
    expect(await neighborOutput).toBe('neighbor-output\n');
  });

  test.if(process.platform === 'linux')('a command whose exit is recorded without `close` logs the same line', async () => {
    const { spawnChild, childEnds } = losingCloseWithNeighbor();
    const result = await runTimedCommand('sh', ['-c', 'sleep 0.3; echo installed; exit 3'], { cwd: '.', spawnChild, timeoutMs: 5_000, timing: { exit: LOST_CLOSE_TIMING.exit, leftoverTermMs: 200 } });
    expect(result.code).toBe(3);
    expect(result.output).toContain('the runner lost `close`');
    expect(result.output).toContain(`[driver] sh's output sockets: stdout`);
    expect(result.output).toContain(`(socket ${childEnds[0]}, taken as the runner's end)`);
  });
});
