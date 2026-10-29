/**
 * The hint `pyric sandbox` adds when `hosting.public` does not exist.
 *
 * A missing `dist/` almost always means "no build yet": the web scaffold's
 * hosting.public is the Vite output, so the hint points at the dev and build
 * loop. With `--hosted` in a Vite project the user wants the Node host for a
 * Vite app, and that runs inside Vite's dev server with `pyric({ hosted: true })`
 * (#1423); `pyric sandbox` only serves a built directory.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const VITE_CONFIG_FILES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'];

/** The Vite config file in `cwd`, or `null` when the project has none. */
function viteConfigIn(cwd: string): string | null {
  return VITE_CONFIG_FILES.find((file) => existsSync(join(cwd, file))) ?? null;
}

/** The text to append to the missing-directory error, starting with a newline, or `''`. */
export function missingPublicDirHint(publicDir: string, opts: { cwd: string; hosted: boolean }): string {
  const viteConfig = opts.hosted ? viteConfigIn(opts.cwd) : null;
  if (viteConfig !== null) {
    return (
      `\n  For a Vite app, the Node host runs in the Vite dev server: set pyric({ hosted: true }) in ${viteConfig}, ` +
      'then start Vite on its own, without pyric sandbox.'
    );
  }
  const looksLikeBuildOutput = /(^|[\\/])(dist|build|out)$/.test(publicDir);
  if (!looksLikeBuildOutput) return '';
  return (
    `\n  No build yet? Run \`bun run dev\` for the live sandbox dev server, ` +
    `or \`bun run build\` then \`pyric sandbox\` to preview the production build.`
  );
}
