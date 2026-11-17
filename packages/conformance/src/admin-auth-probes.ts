#!/usr/bin/env bun
/**
 * Modular firebase-admin Auth oracle probe runner (`rig: 'admin-auth'`).
 *
 * Executes probes under `packages/conformance/probes/auth-admin/*.ts` declaring
 * `rig: 'admin-auth'`. Prints an inert preview unless `--write` / `--capture`
 * is passed.
 *
 * Usage:
 *   bun run packages/conformance/src/admin-auth-probes.ts
 *   bun run packages/conformance/src/admin-auth-probes.ts --write --probe <name>
 */
import { runModularProbesCli, type ModularProbeRigConfig } from './sdk-probes.ts';

export const ADMIN_AUTH_RIG_CONFIG: ModularProbeRigConfig = {
  rig: 'admin-auth',
  scriptPath: 'packages/conformance/src/admin-auth-probes.ts',
  versionField: 'adminSdkVersion',
};

export async function runAdminAuthProbesCli(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  exitOnCli = true,
): Promise<void> {
  await runModularProbesCli({
    config: ADMIN_AUTH_RIG_CONFIG,
    argv,
    env,
    exitOnCli,
  });
}

if (import.meta.main) {
  await runAdminAuthProbesCli(process.argv.slice(2));
}
