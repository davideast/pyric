// Starts `serve.ts` in a `node` process and reads what it saw over HTTP. A
// caller in Bun (a test, an app scenario) uses this whenever it needs the
// gRPC streams, which only Node's HTTP/2 server carries for grpc-js.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AiReceived } from './ai.ts';
import type { Received, Unmatched } from './firestore.ts';
import type { MessagingReceived } from './messaging.ts';
import type { RtdbReceived } from './rtdb.ts';
import type { StorageReceived } from './storage.ts';

export const SERVE_SCRIPT = fileURLToPath(new URL('./serve.ts', import.meta.url));

export interface ReplayProcessOptions {
  /** Also serve RTDB capture A for this project (`--rtdb-capture`). */
  rtdbCapture?: string;
  /** Also serve Storage capture S for this project, on its default and second buckets (`--storage-capture`). */
  storageCapture?: string;
  /** Also serve Messaging capture M for this project (`--messaging-capture`). */
  messagingCapture?: string;
  /** Also serve capture A (Admin) for this project (`--admin-capture`); its Firestore calls need `grpcProjectDir`. */
  adminCapture?: string;
  /** Also answer AI Logic from the committed observations (`--ai`). */
  ai?: boolean;
}

/**
 * The `node` arguments that run a replay server for `recordings`, with gRPC
 * from the SDK installed in `grpcProjectDir`, capture A with `rtdbCapture`,
 * capture S with `storageCapture`, capture M with `messagingCapture`, capture
 * A (Admin) with `adminCapture`, and AI Logic with `ai`.
 */
export function replayServerArgs(recordings: string[], grpcProjectDir?: string, options: ReplayProcessOptions = {}): string[] {
  const grpc = grpcProjectDir ? ['--grpc', grpcProjectDir] : [];
  const capture = options.rtdbCapture ? ['--rtdb-capture', options.rtdbCapture] : [];
  const storage = options.storageCapture ? ['--storage-capture', options.storageCapture] : [];
  const messaging = options.messagingCapture ? ['--messaging-capture', options.messagingCapture] : [];
  const admin = options.adminCapture ? ['--admin-capture', options.adminCapture] : [];
  const ai = options.ai ? ['--ai'] : [];
  return ['--experimental-transform-types', '--no-warnings', SERVE_SCRIPT, ...grpc, ...capture, ...storage, ...messaging, ...admin, ...ai, ...recordings];
}

/** A replay server in another process, by the origins it printed. */
export interface ReplayEndpoints {
  /** `http://127.0.0.1:<port>`: Auth REST, WebChannel streams, and the reports. */
  origin: string;
  /** `127.0.0.1:<port>` for gRPC, or null without `--grpc`. */
  grpc: string | null;
}

const READY = /^REPLAY (\{.*\})$/m;

/** The endpoints a replay server's output names, or null before it printed them. */
export function endpointsIn(output: string): ReplayEndpoints | null {
  const line = READY.exec(output)?.[1];
  return line ? (JSON.parse(line) as ReplayEndpoints) : null;
}

/** Every request the server at `origin` received: Firestore and Auth in arrival order, then RTDB frames, then AI Logic, Storage and Messaging calls, each in arrival order. */
export async function receivedBy(origin: string): Promise<Array<Received | RtdbReceived | AiReceived | StorageReceived | MessagingReceived>> {
  return (await (await fetch(`${origin}/__replay/received`)).json()) as Array<Received | RtdbReceived | AiReceived | StorageReceived | MessagingReceived>;
}

/** Every request the server at `origin` had no recording for. */
export async function unmatchedBy(origin: string): Promise<Unmatched[]> {
  return (await (await fetch(`${origin}/__replay/unmatched`)).json()) as Unmatched[];
}

export interface ReplayProcess extends ReplayEndpoints {
  child: ChildProcess;
  stop(): Promise<void>;
}

/** Starts a replay server process and waits for its endpoints. */
export function startReplayProcess(recordings: string[], grpcProjectDir?: string, options: ReplayProcessOptions = {}): Promise<ReplayProcess> {
  const child = spawn('node', replayServerArgs(recordings, grpcProjectDir, options), { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  };
  return new Promise((resolve, reject) => {
    const read = (part: Buffer) => {
      output += part.toString();
      const endpoints = endpointsIn(output);
      if (endpoints) resolve({ ...endpoints, child, stop });
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', (part: Buffer) => { output += part.toString(); });
    child.once('exit', (code) => reject(new Error(`the replay server exited (code ${code}) before it listened:\n${output}`)));
  });
}
