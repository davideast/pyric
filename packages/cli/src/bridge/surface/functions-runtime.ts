/**
 * Isolated child-process discovery and synthetic execution for the `functions`
 * tool's methods (`ADR 0022` / `ADR 0023` Swap-or-Stop).
 *
 * `discoverFunctionsProject` answers three ways: no `firebase.json`, or a
 * `firebase.json` with no `functions` key, both mean the project declares no
 * Functions source and this reports an empty discovery rather than an error;
 * a declared source that does not resolve (a missing directory, a malformed
 * config) throws, which this lets propagate, because that is a project
 * mistake rather than an absent capability.
 *
 * Whenever a Functions source exists, user code is loaded and executed inside a
 * fresh isolated Node child preloaded with `@pyric/cli/register` and stripped
 * of `GOOGLE_APPLICATION_CREDENTIALS`, wired either to the running host's URL
 * or over IPC to `ctx.sandbox`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getClock } from 'pyric/sandbox';
import { buildChildEnv, registerModuleUrl } from '../../cli/sandbox-runner.js';
import { resolveFirebaseProject } from '../../cli/firebase-project.js';
import { discoverFunctionsProject } from '../../functions/project.js';
import type {
  DiscoveredOnValueCreated,
  UnsupportedOnValueCreated,
} from '../../functions/rtdb/discovery.js';
import { buildFunctionsChildEnv, resolveChildDatabaseHost } from '../../functions/spawn.js';
import { readPyricConfigProjectSync } from '../../serve/live-project.js';
import { resolveProjectAndDefaultInstance } from './database-instance-project.js';
import {
  FUNCTIONS_RUNNER_CHILD_ENV,
  type FunctionsParentToChild,
  type FunctionsRunnerReply,
  type FunctionsRunnerRequest,
  type SerializedTriggerDescriptor,
} from './functions-child-runner.js';
import { startEphemeralFunctionsHost, type EphemeralFunctionsHost } from './functions-ephemeral-host.js';
import type { SurfaceContext } from './types.js';

export interface FunctionsDiscovery {
  /** Where this project's Functions source was looked for. */
  lookedAt: string;
  triggers: DiscoveredOnValueCreated[];
  unsupported: UnsupportedOnValueCreated[];
}

export type IsolatedFireOutcome =
  | { kind: 'not-found' }
  | { kind: 'mismatch'; trigger: SerializedTriggerDescriptor }
  | {
      kind: 'timed-out';
      trigger: SerializedTriggerDescriptor;
      params: Record<string, string>;
      startedAt: number;
      durationMs: number;
    }
  | {
      kind: 'executed';
      trigger: SerializedTriggerDescriptor;
      params: Record<string, string>;
      startedAt: number;
      durationMs: number;
      status: 'fulfilled' | 'rejected';
      event: Record<string, unknown>;
      result?: unknown;
      errorMessage?: string;
    };

const DEFAULT_LOCATION = 'us-central1';
const BOOT_DEADLINE_MS = 15_000;

function resolveRunnerModulePath(): string {
  const siblingJs = fileURLToPath(new URL('./functions-child-runner.js', import.meta.url));
  if (existsSync(siblingJs)) return siblingJs;
  const distJs = fileURLToPath(
    new URL('../../../dist/bridge/surface/functions-child-runner.js', import.meta.url),
  );
  if (existsSync(distJs)) return distJs;
  return fileURLToPath(new URL('./functions-child-runner.ts', import.meta.url));
}

function buildIsolatedEnv(options: {
  entry: string;
  projectId: string;
  defaultInstance: string;
  databaseHost: string;
  functionsHost?: SurfaceContext['functionsHost'];
}): NodeJS.ProcessEnv {
  const registerUrl = registerModuleUrl();
  let activatedBase: NodeJS.ProcessEnv;
  if (options.functionsHost !== undefined) {
    activatedBase = buildChildEnv(process.env, {
      serveUrl: options.functionsHost.serveUrl(),
      registerUrl,
      instanceId: options.functionsHost.instanceId,
      sessionToken: options.functionsHost.sessionToken,
    });
  } else {
    const importFlag = `--import ${registerUrl}`;
    let nodeOptions = importFlag;
    if (process.env.NODE_OPTIONS) {
      nodeOptions = `${process.env.NODE_OPTIONS} ${importFlag}`;
    }
    activatedBase = {
      ...process.env,
      PYRIC_SANDBOX: '1',
      NODE_OPTIONS: nodeOptions,
    };
  }
  const childEnv = buildFunctionsChildEnv({
    baseEnv: activatedBase,
    entry: options.entry,
    instance: options.defaultInstance,
    location: DEFAULT_LOCATION,
    databaseHost: options.databaseHost,
    projectId: options.projectId,
  });
  delete childEnv.PYRIC_FUNCTIONS_RTDB_CHILD;
  childEnv[FUNCTIONS_RUNNER_CHILD_ENV] = '1';
  childEnv.PYRIC_PROCESS_HEALTH = 'off';
  childEnv.PYRIC_SANDBOX_FORCE = '1';
  return childEnv;
}

function toDiscoveredTrigger(descriptor: SerializedTriggerDescriptor): DiscoveredOnValueCreated {
  return {
    ...descriptor,
    callable: () => {
      throw new Error(
        'Discovered trigger descriptors from isolated discovery must be invoked via fireFunctionsTriggerIsolated.',
      );
    },
  };
}

/** Discover the RTDB triggers one project's Functions source defines, if it has one. */
export async function discoverFunctionsTriggers(
  projectDir: string,
  options: {
    functionsHost?: SurfaceContext['functionsHost'];
    defaultInstance?: string;
  } = {},
): Promise<FunctionsDiscovery> {
  const lookedAt = `${projectDir}/firebase.json`;
  const project = discoverFunctionsProject(projectDir);
  if (project === null) return { lookedAt, triggers: [], unsupported: [] };

  const resolved = await resolveProjectAndDefaultInstance(projectDir);
  const projectId = resolved.projectId;
  const defaultInstance = options.defaultInstance ?? resolved.defaultInstance;
  const databaseHost = resolveChildDatabaseHost();
  const env = buildIsolatedEnv({
    entry: project.entry,
    projectId,
    defaultInstance,
    databaseHost,
    functionsHost: options.functionsHost,
  });

  const runnerPath = resolveRunnerModulePath();
  const child = spawn('node', [runnerPath], {
    cwd: project.sourceDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  return await new Promise<FunctionsDiscovery>((resolvePromise, rejectPromise) => {
    let settled = false;
    const bootTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPromise(new Error(`Functions discovery timed out after ${BOOT_DEADLINE_MS}ms`));
    }, BOOT_DEADLINE_MS);
    bootTimer.unref();

    child.on('message', (raw: unknown) => {
      if (settled || typeof raw !== 'object' || raw === null) return;
      const reply = raw as FunctionsRunnerReply;
      if (reply.type === 'discovered') {
        settled = true;
        clearTimeout(bootTimer);
        resolvePromise({
          lookedAt,
          triggers: reply.triggers.map(toDiscoveredTrigger),
          unsupported: reply.unsupported,
        });
      } else if (reply.type === 'fatal') {
        settled = true;
        clearTimeout(bootTimer);
        rejectPromise(new Error(reply.message));
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(bootTimer);
      rejectPromise(err);
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(bootTimer);
      const detail = stderr.trim();
      rejectPromise(
        new Error(
          `Functions discovery child exited prematurely (code ${code ?? 1})` +
            (detail ? `\n${detail}` : ''),
        ),
      );
    });

    const request: FunctionsRunnerRequest = {
      type: 'discover',
      entry: project.entry,
      projectId,
      defaultInstance,
      databaseHost,
    };
    child.send(request satisfies FunctionsParentToChild);
  });
}

/** Execute one synthetic RTDB trigger inside an isolated Swap-or-Stop child process. */
export async function fireFunctionsTriggerIsolated(
  ctx: SurfaceContext,
  input: {
    triggerName: string;
    path: string;
    ref: string;
    value: unknown;
    timeoutMs: number;
    onFiring(trigger: SerializedTriggerDescriptor, params: Record<string, string>): void;
  },
): Promise<IsolatedFireOutcome> {
  const project = discoverFunctionsProject(ctx.projectDir);
  if (project === null) return { kind: 'not-found' };

  const projectId =
    resolveFirebaseProject({
      projectDir: ctx.projectDir,
      configProject: readPyricConfigProjectSync(ctx.projectDir),
    }).projectId ?? 'demo-project';
  const configuredDefaultInstance = (await ctx.databaseInstances()).known().defaultInstance;
  const defaultInstance = configuredDefaultInstance ?? `${projectId}-default-rtdb`;
  const databaseHost = resolveChildDatabaseHost();
  let ephemeralHost: EphemeralFunctionsHost | undefined;
  let activeHost = ctx.functionsHost;
  if (activeHost === undefined) {
    ephemeralHost = await startEphemeralFunctionsHost(ctx.sandbox, { projectId, defaultInstance });
    activeHost = ephemeralHost;
  }
  const env = buildIsolatedEnv({
    entry: project.entry,
    projectId,
    defaultInstance,
    databaseHost,
    functionsHost: activeHost,
  });

  const runnerPath = resolveRunnerModulePath();
  const child = spawn('node', [runnerPath], {
    cwd: project.sourceDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  const childClosed = new Promise<void>((resolveClosed) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveClosed();
      return;
    }
    child.once('close', () => resolveClosed());
  });

  const waitForTeardown = async (boundMs = 1_000): Promise<void> => {
    await Promise.race([
      childClosed,
      new Promise<void>((resolveBound) => {
        const timer = setTimeout(resolveBound, boundMs);
        timer.unref();
      }),
    ]);
    await ephemeralHost?.close();
  };

  return await new Promise<IsolatedFireOutcome>((resolvePromise, rejectPromise) => {
    let settled = false;
    let firingTrigger: SerializedTriggerDescriptor | null = null;
    let firingParams: Record<string, string> | null = null;
    let startedAt = 0;
    let startedMonotonic = 0;
    let executionTimer: ReturnType<typeof setTimeout> | undefined;

    const bootTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      void waitForTeardown(500).finally(() => {
        rejectPromise(new Error(`Functions child failed to start within ${BOOT_DEADLINE_MS}ms`));
      });
    }, BOOT_DEADLINE_MS);
    bootTimer.unref();

    const cleanupTimers = (): void => {
      clearTimeout(bootTimer);
      if (executionTimer !== undefined) clearTimeout(executionTimer);
    };

    child.on('message', (raw: unknown) => {
      if (settled || typeof raw !== 'object' || raw === null) return;
      const reply = raw as FunctionsRunnerReply;

      if (reply.type === 'not-found') {
        settled = true;
        cleanupTimers();
        void waitForTeardown(500).finally(() => resolvePromise({ kind: 'not-found' }));
        return;
      }
      if (reply.type === 'mismatch') {
        settled = true;
        cleanupTimers();
        void waitForTeardown(500).finally(() =>
          resolvePromise({ kind: 'mismatch', trigger: reply.trigger }),
        );
        return;
      }
      if (reply.type === 'firing') {
        clearTimeout(bootTimer);
        firingTrigger = reply.trigger;
        firingParams = reply.params;
        input.onFiring(reply.trigger, reply.params);
        startedAt = getClock(ctx.sandbox).now();
        startedMonotonic = performance.now();
        executionTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const durationMs = performance.now() - startedMonotonic;
          child.kill('SIGKILL');
          void waitForTeardown(500).finally(() =>
            resolvePromise({
              kind: 'timed-out',
              trigger: reply.trigger,
              params: reply.params,
              startedAt,
              durationMs,
            }),
          );
        }, input.timeoutMs);
        return;
      }
      if (reply.type === 'executed') {
        settled = true;
        cleanupTimers();
        const durationMs = performance.now() - startedMonotonic;
        const outcome: IsolatedFireOutcome = {
          kind: 'executed',
          trigger: firingTrigger!,
          params: firingParams!,
          startedAt,
          durationMs,
          status: reply.status,
          event: reply.event,
        };
        if (reply.status === 'fulfilled') {
          outcome.result = reply.result;
        } else {
          outcome.errorMessage = reply.errorMessage ?? 'Trigger threw an unknown error';
        }
        void waitForTeardown(1_000).finally(() => resolvePromise(outcome));
        return;
      }
      if (reply.type === 'fatal') {
        settled = true;
        cleanupTimers();
        void waitForTeardown(500).finally(() => rejectPromise(new Error(reply.message)));
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      void (ephemeralHost?.close() ?? Promise.resolve()).finally(() => rejectPromise(err));
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const detail = stderr.trim();
      const suffix = detail ? `\n${detail}` : '';
      void (ephemeralHost?.close() ?? Promise.resolve()).finally(() =>
        rejectPromise(new Error(`Functions child exited unexpectedly (code ${code ?? 1})${suffix}`)),
      );
    });

    const eventTime = new Date(getClock(ctx.sandbox).now()).toISOString();
    const request: FunctionsRunnerRequest = {
      type: 'fire',
      entry: project.entry,
      projectId,
      defaultInstance,
      databaseHost,
      triggerName: input.triggerName,
      path: input.path,
      ref: input.ref,
      value: input.value,
      eventId: randomUUID(),
      eventTime,
    };
    child.send(request satisfies FunctionsParentToChild);
  });
}
