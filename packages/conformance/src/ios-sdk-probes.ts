#!/usr/bin/env bun
/**
 * Modular upstream Apple / iOS Firebase SDK oracle runner (`rig: 'ios-sdk-probes'`).
 *
 * Executes probes under `packages/conformance/probes/{auth-swift,rtdb-swift}/*.ts`
 * declaring `rig: 'ios-sdk-probes'`:
 *   - `rtdb-swift` probes run as a headless macOS SwiftPM CLI (`RtdbOracleCLI`)
 *     with zero iOS Simulator overhead.
 *   - `auth-swift` probes run on an unsigned iOS Simulator via `xcodebuild test`
 *     (`CODE_SIGNING_ALLOWED=NO`) so `AuthKeychainServices` succeeds cleanly.
 *
 * Prints an inert preview unless `--write` / `--capture` is passed.
 *
 * Usage:
 *   bun run packages/conformance/src/ios-sdk-probes.ts
 *   bun run packages/conformance/src/ios-sdk-probes.ts --write --probe <name>
 */
import { runModularProbesCli, type ModularProbeRigConfig } from './sdk-probes.ts';

export const IOS_SDK_PROBES_RIG_CONFIG: ModularProbeRigConfig = {
  rig: 'ios-sdk-probes',
  scriptPath: 'packages/conformance/src/ios-sdk-probes.ts',
  versionField: 'iosSdkVersion',
};

export async function runIosSdkProbesCli(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  exitOnCli = true,
): Promise<void> {
  await runModularProbesCli({
    config: IOS_SDK_PROBES_RIG_CONFIG,
    argv,
    env,
    exitOnCli,
  });
}

if (import.meta.main) {
  await runIosSdkProbesCli(process.argv.slice(2));
}
