/**
 * Where a child's output was when the runner lost its `close` (#1797).
 *
 * When the runner loses a child's `close` (#1274), the driver records the
 * exit, and sometimes the output the child wrote never came as `data`
 * events. Two failures look the same from JS: the runner's reader lost its
 * poll event, so the bytes are still in the kernel, or the runner read
 * them into its own buffer and never passed them on. This reads nothing
 * from the child's sockets. It only reports how many bytes the kernel
 * still queues for the runner's ends of them, so the next failure says
 * which of the two it was.
 *
 * Both runtimes give a child's stdout and stderr a socketpair each. The
 * child's end comes from /proc/<pid>/fd at spawn, and the runner's end from
 * the kernel's peer record for it in `ss -xan`, read in the same turn while
 * both ends are open; it counts only if the runner holds that socket. Inode
 * numbers alone can't pair them: the kernel hands out socket inodes from
 * per-CPU batches of 1024, so the two ends of one pair are sometimes far
 * apart (#2511). A socket another thread opens during the spawn has another
 * peer, so it is never taken for one of them. Off Linux there is no /proc,
 * and nothing is reported.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import type { ExitSource } from './unreaped-exit.ts';

/** The runner's end of the socket a child writes one of its streams to. */
export interface OutputSocket {
  stream: 'stdout' | 'stderr';
  /** The inode /proc and `ss` name the runner's end by. */
  inode: number;
}

/** Reads a /proc link, or undefined when it is gone. */
export type ReadLink = (path: string) => string | undefined;

/** The inodes of the sockets this process holds open. */
export type OwnSockets = () => Set<number>;

/** The bytes the kernel queues to be read, by socket inode, or undefined when they can't be read. */
export type ReadQueues = () => Map<number, number> | undefined;

/** Each connected socket's inode, by the inode of its peer, or undefined when they can't be read. */
export type ReadPeers = () => Map<number, number> | undefined;

const hasProcFds = process.platform === 'linux' && existsSync('/proc/self/fd');

const readProcLink: ReadLink = (path) => {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
};

function socketInode(link: string | undefined): number | undefined {
  const match = link === undefined ? null : /^socket:\[(\d+)\]$/.exec(link);
  return match ? Number(match[1]) : undefined;
}

const readOwnSockets: OwnSockets = () => {
  const inodes = new Set<number>();
  for (const fd of readdirSync('/proc/self/fd')) {
    const inode = socketInode(readProcLink(`/proc/self/fd/${fd}`));
    if (inode !== undefined) inodes.add(inode);
  }
  return inodes;
};

/** One row of `ss -xan`: a unix socket, the bytes queued for it, and its peer (0 when it has none). */
interface UnixSocketRow {
  inode: number;
  received: number;
  peer: number;
}

/** `ss -xan`: one line per unix socket, `Netid State Recv-Q Send-Q Local Port Peer Port`. */
function parseUnixRows(table: string): UnixSocketRow[] {
  const rows: UnixSocketRow[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const row = { received: Number(fields[2]), inode: Number(fields[5]), peer: Number(fields[7]) };
    const isRow = fields.length >= 8 && Number.isInteger(row.received) && Number.isInteger(row.inode);
    if (isRow) rows.push(row);
  }
  return rows;
}

/** The bytes the kernel queues to be read for each unix socket, by inode. */
export function parseUnixQueues(table: string): Map<number, number> {
  return new Map(parseUnixRows(table).map((row) => [row.inode, row.received]));
}

/** Each connected unix socket's inode, by the inode of its peer. */
export function parseUnixPeers(table: string): Map<number, number> {
  const hasPeer = (row: UnixSocketRow) => Number.isInteger(row.peer) && row.peer !== 0;
  return new Map(parseUnixRows(table).filter(hasPeer).map((row) => [row.peer, row.inode]));
}

function readSsTable(): string | undefined {
  try {
    return execFileSync('ss', ['-xan'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

const readSsQueues: ReadQueues = () => {
  const table = readSsTable();
  return table === undefined ? undefined : parseUnixQueues(table);
};

const readSsPeers: ReadPeers = () => {
  const table = readSsTable();
  return table === undefined ? undefined : parseUnixPeers(table);
};

/**
 * The runner's ends of the sockets child `pid` writes stdout and stderr to,
 * read once the spawn returns. A stream whose end can't be identified is
 * left out: it is not a socket, the child is gone already, `ss` did not
 * run, or the runner does not hold the socket's peer.
 */
export function childOutputSockets(
  pid: number | undefined,
  readLink: ReadLink = readProcLink,
  ownSockets: OwnSockets = readOwnSockets,
  readPeers: ReadPeers = readSsPeers,
): OutputSocket[] {
  if (!hasProcFds || pid === undefined) return [];
  const childEnds = ([[1, 'stdout'], [2, 'stderr']] as const).map(([fd, stream]) => ({ stream, inode: socketInode(readLink(`/proc/${pid}/fd/${fd}`)) }));
  const hasChildSocket = childEnds.some((end) => end.inode !== undefined);
  const peers = hasChildSocket ? readPeers() : undefined;
  if (peers === undefined) return [];
  const held = ownSockets();
  const sockets: OutputSocket[] = [];
  for (const end of childEnds) {
    const runnerEnd = end.inode === undefined ? undefined : peers.get(end.inode);
    const isRunnerEnd = runnerEnd !== undefined && held.has(runnerEnd);
    if (isRunnerEnd) sockets.push({ stream: end.stream, inode: runnerEnd });
  }
  return sockets;
}

/** The exits recorded without `close`, whose output may never have come as `data` events. */
export function isExitWithoutClose(source: ExitSource): boolean {
  return source === 'lost-close' || source === 'unreaped';
}

type SocketState = { kind: 'queued'; bytes: number } | { kind: 'closed' } | { kind: 'unlisted' };

function describeState(state: SocketState): string {
  if (state.kind === 'queued') return `${state.bytes} bytes queued in the kernel`;
  if (state.kind === 'closed') return 'closed by the runner';
  return 'not listed by ss';
}

function explain(states: readonly SocketState[]): string {
  const queued = states.reduce((sum, state) => sum + (state.kind === 'queued' ? state.bytes : 0), 0);
  if (queued > 0) return `the kernel still holds ${queued} bytes the runner never read, so its reader stopped`;
  const isAllClosed = states.every((state) => state.kind === 'closed');
  if (isAllClosed) return 'the runner closed its ends, so it read them to the end';
  return 'the kernel holds none of the output, so the runner read it, or the child wrote nothing';
}

/**
 * The line a log gets when an exit was recorded without `close`: how many
 * bytes the kernel still queues for each of the child's output sockets,
 * and which failure that points to. It reads no socket.
 */
export function describeOutputSockets(
  name: string,
  sockets: readonly OutputSocket[],
  readQueues: ReadQueues = readSsQueues,
  ownSockets: OwnSockets = readOwnSockets,
): string {
  if (!hasProcFds) return '';
  if (sockets.length === 0) return `\n[driver] ${name}: the driver could not identify the runner's ends of its output sockets, so it can't say where its output went (#1797)\n`;
  const held = ownSockets();
  const queues = readQueues();
  if (queues === undefined) return `\n[driver] ${name}: \`ss -xan\` did not run, so the driver can't say where its output went (#1797)\n`;
  const states = sockets.map((socket): SocketState => {
    if (!held.has(socket.inode)) return { kind: 'closed' };
    const bytes = queues.get(socket.inode);
    return bytes === undefined ? { kind: 'unlisted' } : { kind: 'queued', bytes };
  });
  const parts = sockets.map((socket, index) => `${socket.stream} ${describeState(states[index]!)} (socket ${socket.inode}, the runner's end)`);
  return `\n[driver] ${name}'s output sockets: ${parts.join(', ')}; ${explain(states)} (#1797)\n`;
}
