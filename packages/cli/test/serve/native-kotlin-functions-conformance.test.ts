import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  callableBody,
  functionsCallableCaptureDir,
  sendProbeRequest,
} from '@pyric/conformance/functions-callable-fixture';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { functionsChildrenOf, isAlive } from '../functions-http/children.js';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const KT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/kt-client');
const CLI_ENTRY = join(CLI_ROOT, 'dist/cli/index.js');
const PROJECT_ID = 'demo-functions-callable';
const REGION = 'us-central1';

function detectCompatibleJavaMajor(): number | null {
  let javaBin = 'java';
  const javaHome = process.env.JAVA_HOME;
  if (typeof javaHome === 'string' && javaHome.length > 0) {
    const candidate = resolve(javaHome, 'bin/java');
    if (existsSync(candidate)) {
      javaBin = candidate;
    }
  }
  const probe = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
  if (probe.error !== undefined) {
    return null;
  }
  let combined = '';
  if (typeof probe.stderr === 'string') {
    combined += probe.stderr;
  }
  if (typeof probe.stdout === 'string') {
    combined += `\n${probe.stdout}`;
  }
  const match = /version "(\d+)(?:[."]|$)/.exec(combined);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  if (Number.isNaN(major)) {
    return null;
  }
  return major;
}

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await Bun.sleep(50);
  }
  return null;
}

interface LiveFunctionsPlane {
  readonly cwd: string;
  readonly baseUrl: string;
  readonly bridgeUrl: string;
  readonly command: ChildProcess;
  close(): Promise<void>;
}

async function startLiveFunctionsPlane(): Promise<LiveFunctionsPlane> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`Build @pyric/cli before running live-host Functions conformance: ${CLI_ENTRY}`);
  }
  const cwd = createPrivateJobTmpDir('kt-fn-live');
  cpSync(join(functionsCallableCaptureDir, 'firebase.json'), join(cwd, 'firebase.json'));
  cpSync(join(functionsCallableCaptureDir, 'public'), join(cwd, 'public'), { recursive: true });
  mkdirSync(join(cwd, 'fixture/node_modules'), { recursive: true });
  for (const file of ['index.cjs', 'package.json']) {
    cpSync(join(functionsCallableCaptureDir, 'fixture', file), join(cwd, 'fixture', file));
  }
  symlinkSync(
    join(REPO_ROOT, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'fixture/node_modules/firebase-functions'),
  );
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));

  let output = '';
  const command = spawn(
    'node',
    [
      CLI_ENTRY,
      'sandbox',
      '--hosted',
      '--no-run',
      '--port=0',
      '--host=127.0.0.1',
      '--no-open',
      '--no-capture',
    ],
    {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  command.stdout?.setEncoding('utf8');
  command.stderr?.setEncoding('utf8');
  command.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  command.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });

  const close = async (): Promise<void> => {
    const cliPid = command.pid;
    let children: number[] = [];
    if (cliPid !== undefined) {
      children = functionsChildrenOf(cliPid);
    }
    if (command.exitCode === null && command.signalCode === null) {
      command.kill('SIGTERM');
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          command.kill('SIGKILL');
          resolveExit();
        }, 5_000);
        command.once('exit', () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
    for (const pid of children) {
      if (isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already exited.
        }
      }
    }
    removePrivateJobTmpDir(cwd);
  };

  try {
    const pointer = await waitFor(() => {
      const servePath = join(cwd, '.pyric/serve.json');
      if (!existsSync(servePath)) {
        return null;
      }
      try {
        return JSON.parse(readFileSync(servePath, 'utf8')) as { url: string };
      } catch {
        return null;
      }
    }, 20_000);
    if (pointer === null) {
      throw new Error(`pyric sandbox --hosted did not write .pyric/serve.json:\n${output}`);
    }
    const baseUrl = pointer.url.replace(/\/$/, '');
    const echoUrl = `${baseUrl}/${PROJECT_ID}/${REGION}/pyricCallableEcho`;

    const ready = await waitFor(async () => {
      const res = await sendProbeRequest(echoUrl, {
        id: 'kt-ready',
        function: 'pyricCallableEcho',
        via: 'cloudfunctions',
        clientTimeoutMs: 2_000,
        ...callableBody({}),
      });
      if (res.status === 200) {
        return true;
      }
      return null;
    }, 30_000);
    if (ready === null) {
      throw new Error(`Callable child did not become ready on ${echoUrl}:\n${output}`);
    }

    const parsedBase = new URL(baseUrl);
    let wsScheme = 'ws:';
    if (parsedBase.protocol === 'https:') {
      wsScheme = 'wss:';
    }
    const bridgeUrl = `${wsScheme}//${parsedBase.host}/__pyric/sandbox`;

    return {
      cwd,
      baseUrl,
      bridgeUrl,
      command,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

const requireKotlinLive = process.env.PYRIC_REQUIRE_KOTLIN_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireKotlinLive;
const detectedJavaMajor = detectCompatibleJavaMajor();
const hasCompatibleJdk =
  detectedJavaMajor !== null && detectedJavaMajor >= 11 && detectedJavaMajor <= 24;
const shouldSkipGradleRun = !requireKotlinLive && (isGenericCiShard || !hasCompatibleJdk);

describe('native Kotlin Cloud Functions callable live-host conformance', () => {
  test(
    'serves Int64Value callable JSON and SSE message + result streams on live hosted plane',
    async () => {
      const plane = await startLiveFunctionsPlane();
      const cliPid = plane.command.pid;
      let spawnedChildren: number[] = [];
      if (cliPid !== undefined) {
        spawnedChildren = functionsChildrenOf(cliPid);
      }
      try {
        const echoUrl = `${plane.baseUrl}/${PROJECT_ID}/${REGION}/pyricCallableEcho`;
        const echoRes = await fetch(echoUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            data: {
              largeLong: {
                '@type': 'type.googleapis.com/google.protobuf.Int64Value',
                value: '9007199254740991',
              },
            },
          }),
        });
        expect(echoRes.status).toBe(200);
        const echoJson = (await echoRes.json()) as {
          result: { data: { largeLong: unknown } };
        };
        expect(String(echoJson.result.data.largeLong)).toBe('9007199254740991');

        const streamUrl = `${plane.baseUrl}/${PROJECT_ID}/${REGION}/pyricCallableStream`;
        const streamRes = await fetch(streamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            data: { chunks: ['m1', 'm2'] },
          }),
        });
        expect(streamRes.status).toBe(200);
        const sseText = await streamRes.text();
        expect(sseText).toContain('data: {"message":"m1"}');
        expect(sseText).toContain('data: {"message":"m2"}');
        expect(sseText).toContain('"acceptsStreaming":true');
      } finally {
        await plane.close();
      }
      for (const pid of spawnedChildren) {
        expect(isAlive(pid)).toBe(false);
      }
    },
    90_000,
  );

  test.skipIf(shouldSkipGradleRun)(
    'runs FunctionsLiveHostConformanceTest against live pyric sandbox --hosted callable & SSE server',
    async () => {
      if (!hasCompatibleJdk) {
        throw new Error(
          `PYRIC_REQUIRE_KOTLIN_LIVE=1 requires JDK 11..24 on PATH or JAVA_HOME (detected: ${String(detectedJavaMajor)})`,
        );
      }

      const plane = await startLiveFunctionsPlane();
      const cliPid = plane.command.pid;
      let spawnedChildren: number[] = [];
      if (cliPid !== undefined) {
        spawnedChildren = functionsChildrenOf(cliPid);
      }
      try {
        const gradlew = resolve(KT_CLIENT_DIR, 'gradlew');
        const proc = Bun.spawn(
          [
            gradlew,
            '-p',
            KT_CLIENT_DIR,
            ':cleanTest',
            ':test',
            '--tests',
            'dev.pyric.e2e.FunctionsLiveHostConformanceTest',
            '--stacktrace',
            '--no-daemon',
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              PYRIC_LIVE_BRIDGE_URL: plane.bridgeUrl,
              PYRIC_FUNCTIONS_BASE_URL: plane.baseUrl,
              PYRIC_REQUIRE_FUNCTIONS_LIVE: '1',
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (exitCode !== 0) {
          throw new Error(
            `Gradle FunctionsLiveHostConformanceTest exited ${String(exitCode)}:\n${stdout}\n${stderr}`,
          );
        }

        const xmlPath = join(
          KT_CLIENT_DIR,
          'build/test-results/test/TEST-dev.pyric.e2e.FunctionsLiveHostConformanceTest.xml',
        );
        expect(existsSync(xmlPath)).toBe(true);
        const xml = readFileSync(xmlPath, 'utf8');
        const testsMatch = /\btests="(\d+)"/.exec(xml);
        expect(testsMatch).not.toBeNull();
        let executedTests = 0;
        if (testsMatch !== null && testsMatch[1] !== undefined) {
          executedTests = Number.parseInt(testsMatch[1], 10);
        }
        expect(executedTests).toBeGreaterThanOrEqual(1);
        expect(xml).toContain('skipped="0"');
        expect(xml).toContain('failures="0"');
        expect(xml).toContain('errors="0"');
        expect(xml).toContain('PYRIC_KT_FUNCTIONS_LIVE_VERIFIED=1');
      } finally {
        await plane.close();
      }
      for (const pid of spawnedChildren) {
        expect(isAlive(pid)).toBe(false);
      }
    },
    180_000,
  );
});
