import { describe, expect, test } from 'bun:test';
import { childOutputSockets, describeOutputSockets, isExitWithoutClose, parseUnixQueues } from './output-sockets.ts';
import type { ExitSource } from './unreaped-exit.ts';

const onLinux = process.platform === 'linux';

/** `ss -xan` as it prints a runner's sockets: two children's pairs, and a socket another thread opened. */
const SS_TABLE = [
  'Netid State Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
  'u_str ESTAB 13     0                      * 100              * 0',
  'u_str ESTAB 0      0                      * 102              * 0',
  'u_str ESTAB 9000   0                      * 99               * 98',
  'u_str ESTAB 4096   0                      * 104              * 105',
  'u_str LISTEN 0     4096       /run/a b.sock 7                * 0',
].join('\n');

const ownAll = () => new Set([99, 100, 102, 104]);
const queues = () => parseUnixQueues(SS_TABLE);

describe('the child\'s output sockets (#1797)', () => {
  test('the runner\'s end is the socket one below the child\'s, and only if the runner holds it', () => {
    const links: Record<string, string> = { '/proc/7/fd/1': 'socket:[101]', '/proc/7/fd/2': 'socket:[103]' };
    const readLink = (path: string) => links[path];
    expect(childOutputSockets(7, readLink, () => new Set([99, 100, 102, 104]))).toEqual(onLinux ? [{ stream: 'stdout', inode: 100 }, { stream: 'stderr', inode: 102 }] : []);
    // A socket another thread opened during the spawn (104) never stands in for a missing end.
    expect(childOutputSockets(7, readLink, () => new Set([100, 104]))).toEqual(onLinux ? [{ stream: 'stdout', inode: 100 }] : []);
    expect(childOutputSockets(7, () => '/dev/null', ownAll)).toEqual([]);
    expect(childOutputSockets(undefined, readLink, ownAll)).toEqual([]);
  });

  test('ss rows give each socket\'s receive queue by inode, a path with a space skipped', () => {
    expect([...queues()]).toEqual([[100, 13], [102, 0], [99, 9000], [104, 4096]]);
  });

  test('only exits recorded without `close` get the line', () => {
    const sources: ExitSource[] = ['close', 'held-pipes', 'lost-close', 'unreaped'];
    expect(sources.filter(isExitWithoutClose)).toEqual(['lost-close', 'unreaped']);
  });
});

describe.if(onLinux)('the line about where the output went (#1797)', () => {
  const sockets = [{ stream: 'stdout', inode: 100 }, { stream: 'stderr', inode: 102 }] as const;

  test('bytes still queued say the reader stopped, counting only the child\'s sockets', () => {
    const line = describeOutputSockets('vite', sockets, queues, ownAll);
    expect(line).toBe("\n[driver] vite's output sockets: stdout 13 bytes queued in the kernel (socket 100, taken as the runner's end), stderr 0 bytes queued in the kernel (socket 102, taken as the runner's end); the kernel still holds 13 bytes the runner never read, so its reader stopped (#1797)\n");
    // The 9000 and 4096 bytes queued for sockets 99 and 104, which other code owns, are not the child's.
    expect(line).not.toContain('9000');
    expect(line).not.toContain('4096');
  });

  test('nothing queued says the runner read it, or the child wrote nothing', () => {
    const empty = () => new Map([[100, 0], [102, 0]]);
    expect(describeOutputSockets('vite', sockets, empty, ownAll)).toContain('the kernel holds none of the output, so the runner read it, or the child wrote nothing (#1797)');
  });

  test('ends the runner closed say it read them to the end', () => {
    expect(describeOutputSockets('vite', sockets, queues, () => new Set([99, 104]))).toContain('stdout closed by the runner (socket 100, taken as the runner\'s end), stderr closed by the runner (socket 102, taken as the runner\'s end); the runner closed its ends, so it read them to the end (#1797)');
  });

  test('unidentified sockets, or no ss, say the driver cannot tell', () => {
    expect(describeOutputSockets('vite', [], queues, ownAll)).toContain("vite: the driver could not identify the runner's ends of its output sockets");
    expect(describeOutputSockets('vite', sockets, () => undefined, ownAll)).toContain('vite: `ss -xan` did not run');
  });
});
