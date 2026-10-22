/**
 * The package manager that ran `create pyric`, so the printed next steps
 * name the commands the user already uses.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/**
 * Reads the `npm_config_user_agent` value every package manager sets for
 * `create` and `exec`, such as `pnpm/9.0.0 npm/? node/v22.15.0 linux x64`.
 * Without one, the user ran the binary directly, and the docs use npm.
 */
export function detectPackageManager(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split('/')[0];
  const known = PACKAGE_MANAGERS.find((pm) => pm === name);
  return known ?? 'npm';
}

/** Rewrites each `bun <command>` step to the same command for `pm`. */
export function nextStepsFor(steps: readonly string[], pm: PackageManager): string[] {
  return steps.map((step) => {
    const isBunStep = step.startsWith('bun ');
    if (!isBunStep) return step;
    return `${pm} ${step.slice('bun '.length)}`;
  });
}
