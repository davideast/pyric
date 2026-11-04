// Starts `serve.ts` in a `node` process and reads what it saw over HTTP. A
// caller in Bun (a test, an app scenario) uses this whenever it needs the
// gRPC streams, which only Node's HTTP/2 server carries for grpc-js.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Received, Unmatched } from './firestore.ts';

export const SERVE_SCRIPT = fileURLToPath(new URL('./serve.ts', import.meta.url));

/** The `node` arguments that run a replay server for `recordings`, with gRPC from the SDK installed in `grpcProjectDir`. */
export function replayServerArgs(recordings: string[], grpcProjectDir?: string): string[] {
  const grpc = grpcProjectDir ? ['--grpc', grpcProjectDir] : [];
  return ['--experimental-transform-types', '--no-warnings', SERVE_SCRIPT, ...grpc, ...recordings];
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

/** Every request the server at `origin` received. */
export async function receivedBy(origin: string): Promise<Received[]> {
  return (await (await fetch(`${origin}/__replay/received`)).json()) as Received[];
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
export function startReplayProcess(recordings: string[], grpcProjectDir?: string): Promise<ReplayProcess> {
  const child = spawn('node', replayServerArgs(recordings, grpcProjectDir), { stdio: ['ignore', 'pipe', 'pipe'] });
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
