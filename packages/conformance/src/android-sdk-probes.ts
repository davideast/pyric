#!/usr/bin/env bun
/**
 * Modular upstream Android Firebase SDK Robolectric oracle runner
 * (`rig: 'android-sdk-probes'`).
 *
 * Executes probes under `packages/conformance/probes/{auth-kotlin,rtdb-kotlin,firestore-kotlin}/*.ts`
 * declaring `rig: 'android-sdk-probes'`. Prints an inert preview unless
 * `--write` / `--capture` is passed.
 *
 * Usage:
 *   bun run packages/conformance/src/android-sdk-probes.ts
 *   bun run packages/conformance/src/android-sdk-probes.ts --write --probe <name>
 */
import { runModularProbesCli, type ModularProbeRigConfig } from './sdk-probes.ts';

export const ANDROID_SDK_PROBES_RIG_CONFIG: ModularProbeRigConfig = {
  rig: 'android-sdk-probes',
  scriptPath: 'packages/conformance/src/android-sdk-probes.ts',
  versionField: 'androidBomVersion',
};

export async function runAndroidSdkProbesCli(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  exitOnCli = true,
): Promise<void> {
  await runModularProbesCli({
    config: ANDROID_SDK_PROBES_RIG_CONFIG,
    argv,
    env,
    exitOnCli,
  });
}

if (import.meta.main) {
  await runAndroidSdkProbesCli(process.argv.slice(2));
}
