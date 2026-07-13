import type { DeployStep } from './deploy-plan';

interface FirebaseProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
}

interface FirebaseSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: 'inherit';
  stdout: 'inherit' | 'pipe';
  stderr: 'inherit';
}

export interface FirebaseRunnerOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  spawn(command: readonly string[], options: FirebaseSpawnOptions): FirebaseProcess;
  log?: (message: string) => void;
}

export class FirebaseCommandFailed extends Error {
  constructor(readonly exitCode: number) {
    super(`firebase-tools exited with status ${exitCode}`);
  }
}

export function createFirebaseRunner(options: FirebaseRunnerOptions) {
  const log = options.log ?? console.log;
  return async (step: DeployStep): Promise<unknown> => {
    const command = ['firebase', ...step.args];
    const capturesJson = step.kind === 'discover-endpoint';
    log(`\n  ${command.join(' ')}`);
    const child = options.spawn(command, {
      cwd: options.cwd,
      env: options.environment,
      stdin: 'inherit',
      stdout: capturesJson ? 'pipe' : 'inherit',
      stderr: 'inherit',
    });
    const stdout = capturesJson && child.stdout
      ? await new Response(child.stdout).text()
      : undefined;
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new FirebaseCommandFailed(exitCode);
    if (!capturesJson) return undefined;
    if (stdout === undefined) {
      throw new Error('firebase-tools did not expose JSON output');
    }
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new Error('firebase-tools returned invalid JSON while discovering inferenceApi');
    }
  };
}
