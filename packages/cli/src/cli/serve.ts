/**
 * `pyric sandbox` CLI entry point and re-exports.
 *
 * Orchestration helpers live in sibling modules (`serve-runtime.ts`,
 * `serve-rules-watchers.ts`, `serve-startup-banner.ts`, `serve-functions.ts`)
 * so each file stays focused and compact.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import {
  formatBridgeTipLine,
  resolvePlannedChildAppOrigin,
} from './child-app-origin.js';
import {
  extractHosting,
  readFirebaseJson,
  readFirebaseRc,
  wantsSpaRewrite,
} from './firebase-json.js';
import { resolveFirebaseProject, type FirebaseProjectResolution } from './firebase-project.js';
import type { ParsedArgs } from './parse-args.js';
import { readPyricConfig, type PyricConfig } from './pyric-config.js';
import {
  describeInterlock,
  formatInterlockLine,
  startBeaconWatchdog,
  type BeaconWatchdog,
} from './sandbox-interlock.js';
import {
  ignoreShutdownError,
  installOutputPipeGuard,
  installServeProcessGuard,
  installServeShutdownSignals,
  runBoundedTeardown,
  writeStreamQuietly,
} from './sandbox-process-guard.js';
import {
  buildChildEnv,
  formatStartupEnvExport,
  registerModuleUrl,
  resolveSandboxChild,
  spawnSandboxChild,
  waitForSandboxPeer,
  type SandboxChildHandle,
} from './sandbox-runner.js';
import { startServeFunctionsRuntime } from './serve-functions.js';
import { serveErrorMessage } from './serve-rules-watchers.js';
import {
  serveJsonLine,
  startServe,
  type LiveServeStart,
  type ServeRuntime,
} from './serve-runtime.js';
import { undeployedStorageLine } from './serve-startup-banner.js';
import { checkSandboxChildLaunch } from './unsupported-runtime.js';
import type { FunctionsDevelopmentRuntime } from '../functions/development-runtime.js';
import { createFunctionsHttpGateway, type FunctionsHttpGateway } from '../functions/http/gateway.js';
import { servedLine } from '../functions/http/report.js';
import { hostingRewrites } from '../functions/http/rewrites.js';
import { discoverFunctionsProject, type FunctionsProject } from '../functions/project.js';
import { SANDBOX_APP_ORIGIN_ENV } from '../remote/app-origin.js';
import { parseTrustProxySetting, type RemoteAccessOptions } from '../serve/guard-policy.js';
import { openBrowser, shouldAutoOpen } from '../serve/open-browser.js';
import { resolveRemoteAccessConfig } from '../serve/remote-access-config.js';
import {
  parseAllowedHostsInput,
  parseAllowRemotePeersInput,
  parseTrustProxyInput,
} from '../serve/remote-access-parse.js';
import { resolveHostingFile } from '../serve/server.js';

export {
  extractHosting,
  installServeProcessGuard,
  serveJsonLine,
  startServe,
  undeployedStorageLine,
  wantsSpaRewrite,
  type ServeRuntime,
};

/**
 * `--ui` implies `--bridge` (hybrid-MCP plan Phase 3): a Studio user almost
 * always wants MCP too, and the two independent flags were a real setup footgun.
 * Pure + exported for unit coverage.
 */
export function bridgeEnabledFromFlags(flags: { get(key: string): unknown }): boolean {
  return Boolean(flags.get('bridge')) || Boolean(flags.get('ui'));
}

/**
 * A dev child also implies the bridge: the runner injects
 * `PYRIC_SANDBOX=remote:<url>` into the child, whose remote client dials the
 * `/__pyric/sandbox` WS -- without the bridge mount that upgrade 404s and
 * `pyric sandbox -- <cmd>` breaks its own child. Pure + exported for unit coverage.
 */
export function bridgeEnabledFor(
  flags: { get(key: string): unknown },
  childPlan: unknown,
  functionsProject: unknown = null,
): boolean {
  return bridgeEnabledFromFlags(flags) || childPlan != null || functionsProject != null;
}

function resolveServePort(flagPort: unknown, configPort?: number): number {
  if (typeof flagPort === 'string') return Number(flagPort);
  if (typeof flagPort === 'number') return flagPort;
  if (typeof configPort === 'number') return configPort;
  return 3473;
}

function resolveExplicitCommand(parsed: ParsedArgs): string[] | null {
  if (parsed.passthrough && parsed.passthrough.length > 0) {
    return parsed.passthrough;
  }
  if (parsed.positional.length > 0) {
    return parsed.positional;
  }
  return null;
}

/** How a live host's clients reach it, in place of the sandbox's export block. */
const LIVE_HOST_CLIENTS =
  '\n  To show a Node process\'s calls here, start it in this project with:\n' +
  '    node --import @pyric/live/register server.js\n' +
  '  For a Vite app, add pyricLive() from @pyric/live/vite: its dev server is the live host.\n';

export interface ServeRunHost {
  liveHost?: LiveServeStart;
}

/** CLI entry. Resolves on SIGINT/SIGTERM after a clean stop. */
export async function runServe(parsed: ParsedArgs, runHost: ServeRunHost = {}): Promise<number> {
  const removeOutputPipeGuard = installOutputPipeGuard();
  try {
    return await runServeInner(parsed, runHost);
  } finally {
    removeOutputPipeGuard();
  }
}

async function runServeInner(parsed: ParsedArgs, runHost: ServeRunHost): Promise<number> {
  checkSandboxChildLaunch(null);
  const cwd = process.cwd();
  let pyricConfig: PyricConfig = {};
  try {
    pyricConfig = await readPyricConfig(cwd);
  } catch (error) {
    process.stderr.write(`${serveErrorMessage(error)}\n`);
    return 2;
  }

  const flagPort = parsed.flags.get('port');
  const port = resolveServePort(flagPort, pyricConfig.port);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    process.stderr.write(`pyric: invalid --port '${flagPort}'.\n`);
    return 1;
  }
  const flagHost = parsed.flags.get('host');
  const host = typeof flagHost === 'string' ? flagHost : 'localhost';

  const only = parsed.flags.get('only');
  if (typeof only === 'string' && only !== 'hosting') {
    process.stderr.write(
      `pyric: --only '${only}' is not supported. pyric sandbox serves hosting with the in-page sandbox standing in for Firestore and Auth.\n`,
    );
    return 1;
  }
  if (parsed.flags.has('no-session-token') || parsed.flags.get('session-token') === 'false') {
    process.stderr.write(
      runHost.liveHost !== undefined
        ? `pyric-live: '--no-session-token' is not supported; live mode always requires a session token.\n`
        : `pyric: unknown option '--no-session-token' for pyric sandbox.\n`,
    );
    return 1;
  }

  const json = Boolean(parsed.flags.get('json'));
  const usesHumanOutput = !json;
  const usesHostedSandbox = Boolean(parsed.flags.get('hosted'));
  const needsBrowserConnectionNotice = usesHumanOutput && !usesHostedSandbox;

  const explicitUi = Boolean(parsed.flags.get('ui'));
  const uiOn = !parsed.flags.get('no-ui');

  // Resolve the child plan BEFORE the server starts: a planned child implies
  // the bridge (see bridgeEnabledFor).
  let discoveredFunctionsProject: FunctionsProject | null;
  let firebaseProject: FirebaseProjectResolution;
  try {
    discoveredFunctionsProject = discoverFunctionsProject(cwd);
    const flagProject = parsed.flags.get('project');
    firebaseProject = resolveFirebaseProject({
      projectDir: cwd,
      option: typeof flagProject === 'string' ? flagProject : undefined,
      configProject: pyricConfig.project,
      rc: await readFirebaseRc(cwd),
    });
  } catch (error) {
    process.stderr.write(`${serveErrorMessage(error)}\n`);
    return 2;
  }
  const functionsProject = discoveredFunctionsProject;
  const functionsProjectId = functionsProject === null ? null : firebaseProject.projectId ?? 'demo-project';
  let functionsGateway: FunctionsHttpGateway | null = null;

  const explicitCommand = resolveExplicitCommand(parsed);
  const plan = resolveSandboxChild({
    explicitCommand,
    configCommand: pyricConfig.command,
    noRun: Boolean(parsed.flags.get('no-run')),
    json,
  });
  if (checkSandboxChildLaunch(plan)) return 1;
  const bridgeOn = bridgeEnabledFor(parsed.flags, plan, functionsProject);

  let runtime: ServeRuntime;
  try {
    const flagSeed = parsed.flags.get('seed');
    const seed = typeof flagSeed === 'string' ? flagSeed : undefined;
    const watch = Boolean(parsed.flags.get('no-watch')) ? false : undefined;
    const capture = !parsed.flags.get('no-capture');
    const flagAllowedHosts = parsed.flags.get('allowed-host');
    let allowedHosts: string[] | undefined;
    if (flagAllowedHosts !== undefined) {
      if (typeof flagAllowedHosts === 'boolean') {
        throw new Error('pyric: --allowed-host requires a hostname or comma-separated list.');
      }
      const hostInputs = Array.isArray(flagAllowedHosts)
        ? flagAllowedHosts.filter((entry): entry is string => typeof entry === 'string')
        : [flagAllowedHosts];
      allowedHosts = parseAllowedHostsInput(hostInputs);
    }
    const flagAllowPeers = parsed.flags.get('allow-remote-peers');
    const flagTrustProxy = parsed.flags.get('trust-proxy');
    const allowLiveRemotePeers = runHost.liveHost?.allowRemotePeers === true;
    let remoteAccess: RemoteAccessOptions | undefined;
    if (flagAllowPeers !== undefined || flagTrustProxy !== undefined || allowLiveRemotePeers) {
      const parsedRemote: RemoteAccessOptions = {};
      if (flagAllowPeers !== undefined) {
        const lastPeer = Array.isArray(flagAllowPeers)
          ? flagAllowPeers[flagAllowPeers.length - 1]
          : flagAllowPeers;
        if (lastPeer !== undefined) {
          parsedRemote.allowPeers = parseAllowRemotePeersInput(lastPeer);
        }
      }
      if (flagTrustProxy !== undefined) {
        const lastTrust = Array.isArray(flagTrustProxy)
          ? flagTrustProxy[flagTrustProxy.length - 1]
          : flagTrustProxy;
        if (lastTrust !== undefined) {
          parsedRemote.trustProxy = parseTrustProxyInput(lastTrust);
        }
      }
      if (allowLiveRemotePeers) {
        parsedRemote.allowLiveRemotePeers = true;
      }
      remoteAccess = parsedRemote;
    }
    const resolvedGatewayRemote = resolveRemoteAccessConfig({
      option: remoteAccess,
      allowedHosts,
      configAllowedHosts: pyricConfig.allowedHosts,
      configRemoteAccess: pyricConfig.remoteAccess,
      env: process.env,
    });
    const gatewayTrustProxy = parseTrustProxySetting(resolvedGatewayRemote.remoteAccess?.trustProxy);
    const infoTarget = json ? process.stderr : process.stdout;
    const logger: Parameters<typeof startServe>[0]['logger'] = {
      info: (message) => writeStreamQuietly(infoTarget, `${message}\n`),
      note: (message) => writeStreamQuietly(process.stderr, `${message}\n`),
    };
    if (functionsProjectId !== null) {
      const served = json ? process.stderr : process.stdout;
      const gatewaySandbox: (() => LocalSandbox | null | undefined) | undefined =
        usesHostedSandbox && runHost.liveHost === undefined ? () => runtime?.hostedSandbox : undefined;
      functionsGateway = createFunctionsHttpGateway({
        projectId: functionsProjectId,
        initial: { kind: 'starting' },
        rewrites: hostingRewrites(
          await readFirebaseJson(cwd).catch(() => null),
          (warning) => writeStreamQuietly(process.stderr, `  \u26a0 ${warning}\n`),
        ),
        staticFileExists: (pathname) =>
          runtime !== undefined &&
          runtime.publicDir !== null &&
          resolveHostingFile(runtime.publicDir, pathname) !== null,
        trustProxy: gatewayTrustProxy,
        sandbox: gatewaySandbox,
        onWarning: (warning) => writeStreamQuietly(process.stderr, `  \u26a0 ${warning}\n`),
        onServed: (record) => {
          const { failed, line } = servedLine(record);
          if (failed) writeStreamQuietly(process.stderr, `\u2716 ${line}\n`);
          else writeStreamQuietly(served, `\u2714 ${line}\n`);
        },
        plane: 'pyric-sandbox',
      });
    }
    runtime = await startServe({
      cwd: process.cwd(),
      port,
      host,
      logger,
      noCache: Boolean(parsed.flags.get('no-cache')),
      bridge: bridgeOn,
      hosted: usesHostedSandbox,
      seed,
      watch,
      persist: Boolean(parsed.flags.get('persist')),
      fresh: Boolean(parsed.flags.get('fresh')),
      permissive: Boolean(parsed.flags.get('permissive')),
      ui: uiOn,
      capture,
      allowedHosts,
      remoteAccess,
      project: firebaseProject.projectId,
      firebaseProject,
      functionsHandler: functionsGateway?.handle,
      hasChildCommand: plan !== null,
      sessionToken: parsed.flags.get('session-token') === true ? true : undefined,
      liveHost: runHost.liveHost,
    });
  } catch (e) {
    process.stderr.write(`${serveErrorMessage(e)}\n`);
    return 2;
  }

  const uninstallProcessGuard = installServeProcessGuard((m) => writeStreamQuietly(process.stderr, `${m}\n`));
  if (json) writeStreamQuietly(process.stdout, `${serveJsonLine(runtime)}\n`);
  if (runtime.mcpUrl === null && usesHumanOutput) {
    writeStreamQuietly(process.stderr, formatBridgeTipLine());
  }

  const opened = shouldAutoOpen({
    json,
    noOpen: Boolean(parsed.flags.get('no-open')),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (opened) {
    const studioUrl = runtime.uiUrl;
    const targetUrl = explicitUi && studioUrl !== null ? studioUrl : runtime.handle.url;
    void openBrowser(targetUrl);
  }

  let devChild: SandboxChildHandle | null = null;
  let beaconWatchdog: BeaconWatchdog | null = null;
  let functionsRuntime: FunctionsDevelopmentRuntime | null = null;
  let crashRestartWait: { promise: Promise<void>; resolve: () => void } | null = null;
  const resolveCrashRestartWait = (): void => {
    if (crashRestartWait !== null) {
      crashRestartWait.resolve();
      crashRestartWait = null;
    }
  };
  const shutdownSignals = installServeShutdownSignals();
  const { signal } = shutdownSignals;
  const cleanupLifecycleListeners = (): void => {
    shutdownSignals.dispose();
    uninstallProcessGuard();
  };
  const waitOrSignal = async <T>(pending: Promise<T>): Promise<{ value: T } | { signal: NodeJS.Signals }> =>
    Promise.race([
      pending.then((value) => ({ value })),
      signal.then((received) => ({ signal: received })),
    ]);
  const stopAfterSignal = async (): Promise<number> => {
    const output = json ? process.stderr : process.stdout;
    writeStreamQuietly(output, '\nShutting down...\n');
    beaconWatchdog?.stop();
    const activeChild = devChild;
    if (activeChild !== null && activeChild.child.exitCode === null && activeChild.child.signalCode === null) {
      activeChild.signal(await signal);
    }
    resolveCrashRestartWait();
    await runBoundedTeardown(async () => {
      await functionsRuntime?.close().catch(ignoreShutdownError);
      await runtime.handle.stop().catch(ignoreShutdownError);
    });
    cleanupLifecycleListeners();
    return 0;
  };

  if (functionsProject !== null && functionsProjectId !== null && functionsProjectId.length > 0) {
    const exitCode = await startServeFunctionsRuntime({
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
      setFunctionsRuntime: (next) => {
        functionsRuntime = next;
      },
      getCrashRestartWait: () => crashRestartWait,
      setCrashRestartWait: (next) => {
        crashRestartWait = next;
      },
      resolveCrashRestartWait,
    });
    if (exitCode !== null) return exitCode;
  }

  if (plan !== null) {
    const info = json ? process.stderr : process.stdout;
    const childAppOrigin = resolvePlannedChildAppOrigin(plan.argv, cwd, process.env);
    const browserTargetUrl = childAppOrigin ?? runtime.handle.url;
    if (opened) {
      writeStreamQuietly(info, '\u2022 run      waiting for the browser tab to connect the sandbox\u2026\n');
      const connectedOutcome = await waitOrSignal(waitForSandboxPeer(runtime.handle.url));
      if ('signal' in connectedOutcome) return stopAfterSignal();
      if (!connectedOutcome.value) {
        writeStreamQuietly(
          info,
          `  \u26a0 no browser tab connected after 30s \u2014 starting your command anyway; sandbox ops will fail until ${browserTargetUrl} is open.\n`,
        );
      }
    } else if (needsBrowserConnectionNotice) {
      writeStreamQuietly(
        info,
        `  \u24d8 Auto-open is disabled (--no-open/CI). The pyric sandbox is browser-resident: ` +
          `open ${browserTargetUrl} to connect if your command performs Firebase operations.\n`,
      );
    }
    writeStreamQuietly(
      info,
      `\u2714 run      \`${plan.label}\` \u2014 firebase-admin/firebase imports are routed to the sandbox at ${runtime.handle.url}\n`,
    );
    const childEnv = buildChildEnv(process.env, {
      serveUrl: runtime.handle.url,
      registerUrl: registerModuleUrl(),
      beaconToken: runtime.beaconToken,
      instanceId: runtime.instanceId,
      workerInit: runtime.workerInit,
      sessionToken: runtime.sessionToken,
    });
    if (childAppOrigin !== undefined) {
      childEnv[SANDBOX_APP_ORIGIN_ENV] = childAppOrigin;
    }
    const interlock = describeInterlock(childEnv, registerModuleUrl());
    writeStreamQuietly(info, formatInterlockLine(interlock));

    devChild = spawnSandboxChild(plan, { cwd, json, env: childEnv });
    const beaconsAtSpawn = runtime.beaconCount();
    beaconWatchdog = startBeaconWatchdog({
      label: plan.label,
      beacon: interlock.beacon,
      sawBeacon: () => runtime.beaconCount() > beaconsAtSpawn,
      isAlive: () => devChild !== null && devChild.child.exitCode === null && devChild.child.signalCode === null,
      warn: (line) => writeStreamQuietly(process.stderr, `${line}\n`),
    });
  } else if (usesHumanOutput && runHost.liveHost !== undefined) {
    writeStreamQuietly(process.stdout, LIVE_HOST_CLIENTS);
  } else if (usesHumanOutput) {
    writeStreamQuietly(
      process.stdout,
      formatStartupEnvExport({
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
        beaconToken: runtime.beaconToken,
      }),
    );
  }

  return await new Promise<number>((resolveExit) => {
    let settled = false;
    let shuttingDown = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      void (async () => {
        beaconWatchdog?.stop();
        resolveCrashRestartWait();
        await runBoundedTeardown(async () => {
          await functionsRuntime?.close().catch(ignoreShutdownError);
          const activeChild = devChild;
          if (activeChild !== null && activeChild.child.exitCode === null && activeChild.child.signalCode === null) {
            activeChild.signal('SIGTERM');
          }
          if (activeChild !== null) {
            await activeChild.exited.catch(ignoreShutdownError);
          }
          await runtime.handle.stop().catch(ignoreShutdownError);
        });
        cleanupLifecycleListeners();
        resolveExit(code);
      })();
    };
    const shutdown = (receivedSignal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      const output = json ? process.stderr : process.stdout;
      writeStreamQuietly(output, '\nShutting down...\n');
      resolveCrashRestartWait();
      void functionsRuntime?.close().catch(ignoreShutdownError);
      const activeChild = devChild;
      if (activeChild !== null && activeChild.child.exitCode === null && activeChild.child.signalCode === null) {
        activeChild.signal(receivedSignal);
      } else {
        finish(0);
      }
    };
    const activeChild = devChild;
    if (activeChild !== null) void activeChild.exited.then((code) => finish(code));
    void signal.then(shutdown);
  });
}
