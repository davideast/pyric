/**
 * The package manager that ran `create pyric`, so the printed next steps
 * name the commands the user already uses.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** A step a template writes for one package manager, such as `bun run dev`. */
const PACKAGE_MANAGER_STEP = /^(npm|bun) /;

/** The alternative a template names after a step, such as `# or: bun install`. */
const ALTERNATIVE_COMMENT = /\s+# or: .*$/;

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

/**
 * Rewrites each `npm <command>` or `bun <command>` step to the same command
 * for `pm`, and drops the `# or: ...` alternative, since the step now names
 * the package manager in use.
 */
export function nextStepsFor(steps: readonly string[], pm: PackageManager): string[] {
  return steps.map((step) => {
    const isPackageManagerStep = PACKAGE_MANAGER_STEP.test(step);
    if (!isPackageManagerStep) return step;
    return step.replace(PACKAGE_MANAGER_STEP, `${pm} `).replace(ALTERNATIVE_COMMENT, '');
  });
}
