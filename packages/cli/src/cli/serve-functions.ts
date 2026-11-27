/**
 * Functions development runtime startup and event reporting for `runServe`.
 */
import { relative } from 'node:path';
import type { FirebaseProjectResolution } from './firebase-project.js';
import { formatPyricCommand } from './command-hint.js';
import { registerModuleUrl } from './sandbox-runner.js';
import {
  ignoreShutdownError,
  runBoundedTeardown,
  writeStreamQuietly,
} from './sandbox-process-guard.js';
import type { ServeRuntime } from './serve-runtime.js';
import { resolveProjectAndDefaultInstance } from '../bridge/surface/database-instance-project.js';
import {
  createFunctionsDevelopmentRuntime,
  createHttpFunctionsPeerReadiness,
  type FunctionsDevelopmentEvent,
  type FunctionsDevelopmentRuntime,
} from '../functions/development-runtime.js';
import type { FunctionsHttpGateway } from '../functions/http/gateway.js';
import {
  createPrivateInvokerWarnings,
  functionsTriggersLine,
  httpFunctionLines,
  stateAfterStart,
  UNRESPONSIVE_LINE,
  uncaughtErrorLine,
  unexpectedExitLine,
} from '../functions/http/report.js';
import type { FunctionsProject } from '../functions/project.js';

export interface StartServeFunctionsOptions {
  cwd: string;
  json: boolean;
  usesHostedSandbox: boolean;
  runtime: ServeRuntime;
  firebaseProject: FirebaseProjectResolution;
  functionsProject: FunctionsProject;
  functionsProjectId: string;
  functionsGateway: FunctionsHttpGateway | null;
  waitOrSignal: <T>(pending: Promise<T>) => Promise<{ value: T } | { signal: NodeJS.Signals }>;
  stopAfterSignal: () => Promise<number>;
  cleanupLifecycleListeners: () => void;
  setFunctionsRuntime: (next: FunctionsDevelopmentRuntime) => void;
  getCrashRestartWait: () => { promise: Promise<void>; resolve: () => void } | null;
  setCrashRestartWait: (next: { promise: Promise<void>; resolve: () => void } | null) => void;
  resolveCrashRestartWait: () => void;
}

/**
 * Starts the Functions child runtime for `pyric sandbox`, printing event and
 * startup summaries. Returns an exit code when startup aborts or fails, or
 * `null` when `runServe` should continue.
 */
export async function startServeFunctionsRuntime(
  opts: StartServeFunctionsOptions,
): Promise<number | null> {
  const {
    cwd,
    json,
    usesHostedSandbox,
    runtime,
    firebaseProject,
    functionsProject,
    functionsProjectId,
    functionsGateway,
    waitOrSignal,
    stopAfterSignal,
    cleanupLifecycleListeners,
    setFunctionsRuntime,
    getCrashRestartWait,
    setCrashRestartWait,
    resolveCrashRestartWait,
  } = opts;

  const info = json ? process.stderr : process.stdout;
  writeStreamQuietly(info, '\u2022 functions waiting for the browser tab to connect the sandbox\u2026\n');
  const serveUrl = runtime.handle.url;
  functionsGateway?.update(usesHostedSandbox ? { kind: 'starting' } : { kind: 'waiting-peer', serveUrl });
  const warnPrivateInvokers = createPrivateInvokerWarnings();
  const reportFunctionsEvent = (event: FunctionsDevelopmentEvent): void => {
    if (event.type === 'starting') {
      if (getCrashRestartWait() === null) {
        let nextKind: 'starting' | 'reloading' = 'starting';
        if (event.mode === 'reload') {
          nextKind = 'reloading';
        }
        functionsGateway?.update({ kind: nextKind });
      }
      return;
    }
    if (event.type === 'output') {
      const output = event.stream === 'stdout' ? info : process.stderr;
      writeStreamQuietly(output, event.line);
      return;
    }
    if (event.type === 'unexpected-exit') {
      resolveCrashRestartWait();
      const isRestarting = event.restarting !== false;
      if (isRestarting) {
        const wait = Promise.withResolvers<void>();
        setCrashRestartWait(wait);
        functionsGateway?.update({
          kind: 'restarting',
          code: event.code,
          ready: wait.promise,
        });
      } else {
        functionsGateway?.update({ kind: 'exited', code: event.code });
      }
      writeStreamQuietly(process.stderr, `pyric sandbox: ${unexpectedExitLine(event.code, isRestarting)}\n`);
      return;
    }
    if (event.type === 'unresponsive') {
      functionsGateway?.update({ kind: 'unresponsive' });
      writeStreamQuietly(process.stderr, `\u2716 ${UNRESPONSIVE_LINE}\n`);
      return;
    }
    if (event.type === 'restarted') {
      functionsGateway?.update(stateAfterStart(event.result, serveUrl));
      resolveCrashRestartWait();
      if (event.result.kind === 'ready') {
        writeStreamQuietly(info, '\u21bb functions restarted\n');
      } else {
        const reason = event.result.kind === 'failed' ? event.result.error.message : 'no sandbox peer';
        writeStreamQuietly(process.stderr, `\u2716 functions did not restart (${reason})\n`);
      }
      return;
    }
    const childEvent = event.event;
    const codebaseTag = childEvent.codebase !== undefined ? `[${childEvent.codebase}] ` : '';
    if (childEvent.type === 'uncaught-error') {
      writeStreamQuietly(process.stderr, `\u2716 ${codebaseTag}${uncaughtErrorLine(childEvent.error)}\n`);
      return;
    }
    if (childEvent.type === 'execution') {
      const params = Object.entries(childEvent.params)
        .map(([name, value]) => `${name}=${value}`)
        .join(', ');
      const paramsSuffix = params.length > 0 ? ` (${params})` : '';
      if (childEvent.status === 'fulfilled') {
        writeStreamQuietly(
          info,
          `\u2714 function  ${codebaseTag}${childEvent.exportName} \u2190 /${childEvent.ref}${paramsSuffix}\n`,
        );
      } else {
        writeStreamQuietly(
          process.stderr,
          `\u2716 function  ${codebaseTag}${childEvent.exportName} \u2190 /${childEvent.ref}${paramsSuffix}: ${childEvent.error.message}\n`,
        );
      }
    } else {
      writeStreamQuietly(
        process.stderr,
        `\u2716 functions delivery for ${codebaseTag}${childEvent.exportName}: ${childEvent.error.message}\n`,
      );
    }
  };

  const functionsRuntime = createFunctionsDevelopmentRuntime({
    sourceDir: functionsProject.sourceDir,
    entry: functionsProject.entry,
    ...(functionsProject.codebase === undefined ? {} : { codebase: functionsProject.codebase }),
    ...(functionsProject.codebases === undefined ? {} : { codebases: functionsProject.codebases }),
    baseEnv: process.env,
    serveUrl: runtime.handle.url,
    registerUrl: registerModuleUrl(),
    beaconToken: runtime.beaconToken,
    hostInstanceId: runtime.instanceId,
    sessionToken: runtime.sessionToken,
    instance: (await resolveProjectAndDefaultInstance(cwd, firebaseProject)).defaultInstance,
    location: process.env.PYRIC_FUNCTIONS_RTDB_REGION ?? 'us-central1',
    projectId: functionsProjectId,
    readiness: createHttpFunctionsPeerReadiness(runtime.handle.url),
    onEvent: reportFunctionsEvent,
  });
  setFunctionsRuntime(functionsRuntime);

  const startOutcome = await waitOrSignal(functionsRuntime.start());
  if ('signal' in startOutcome) return stopAfterSignal();
  const result = startOutcome.value;
  functionsGateway?.update(stateAfterStart(result, serveUrl));
  if (result.kind === 'no-peer') {
    writeStreamQuietly(
      process.stderr,
      `  \u26a0 functions not started \u2014 no browser tab connected after 30s. ` +
        `Open ${runtime.handle.url} and restart ${formatPyricCommand('sandbox')}.\n`,
    );
    return null;
  }
  if (result.kind === 'failed') {
    writeStreamQuietly(process.stderr, `${result.error.message}\n`);
    await runBoundedTeardown(async () => {
      await functionsRuntime.close().catch(ignoreShutdownError);
      await runtime.handle.stop().catch(ignoreShutdownError);
    });
    cleanupLifecycleListeners();
    return 2;
  }
  const ready = result.ready;
  const reportsTriggers = ready.triggerCount > 0 || ready.http === undefined;
  if (reportsTriggers) {
    if (ready.codebases !== undefined && ready.codebases.length > 1) {
      for (const cb of ready.codebases) {
        writeStreamQuietly(
          info,
          `\u2714 ${functionsTriggersLine(cb.triggerCount, relative(cwd, cb.entry), cb.codebase)}\n`,
        );
      }
    } else {
      writeStreamQuietly(
        info,
        `\u2714 ${functionsTriggersLine(ready.triggerCount, relative(cwd, functionsProject.entry), functionsProject.codebase)}\n`,
      );
    }
  }
  if (ready.http) {
    const [heading, ...urls] = httpFunctionLines(ready.http, serveUrl, functionsProjectId);
    writeStreamQuietly(info, `\u2714 ${heading}\n${urls.map((line) => `${line}\n`).join('')}`);
    for (const warning of warnPrivateInvokers(ready.http)) {
      writeStreamQuietly(process.stderr, `  \u26a0 ${warning}\n`);
    }
  }
  for (const unsupported of ready.unsupportedTriggers) {
    const cbSuffix = unsupported.codebase !== undefined ? ` [${unsupported.codebase}]` : '';
    writeStreamQuietly(
      process.stderr,
      `  \u26a0 functions export ${unsupported.exportName}${cbSuffix} uses unsupported trigger ` +
        `${unsupported.eventType}; it will not run in pyric sandbox.\n`,
    );
  }
  return null;
}
