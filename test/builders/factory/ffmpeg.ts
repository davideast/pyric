/**
 * ffmpeg for Studio's tests. `ffmpeg-static` downloads its binary from
 * GitHub in an install script, which `--ignore-scripts` skips and the
 * sandbox couldn't reach anyway. Setup copies the binary the source
 * checkout's own install already downloaded into `tools/` once, and every
 * checkout gets a copy where `ffmpeg-static` looks for it.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppPaths, Checkout } from './app-paths.ts';

const PACKAGE = join('node_modules', 'ffmpeg-static');
const BINARY = 'ffmpeg';

function toolPath(paths: AppPaths): string {
  return join(paths.tools, BINARY);
}

/** Copies the source checkout's ffmpeg into `tools/`, and says whether there was one. */
export function fetchFfmpeg(paths: AppPaths, source: string): boolean {
  const binary = join(source, PACKAGE, BINARY);
  if (!existsSync(binary)) return false;
  mkdirSync(paths.tools, { recursive: true });
  copyFileSync(binary, toolPath(paths));
  chmodSync(toolPath(paths), 0o755);
  return true;
}

/** Puts `tools/ffmpeg` where the checkout's `ffmpeg-static` looks, when it is installed and the binary is missing. */
export function placeFfmpeg(paths: AppPaths, checkout: Checkout): void {
  const target = join(checkout.repo, PACKAGE, BINARY);
  const isInstalled = existsSync(join(checkout.repo, PACKAGE));
  const needsBinary = isInstalled && !existsSync(target) && existsSync(toolPath(paths));
  if (!needsBinary) return;
  copyFileSync(toolPath(paths), target);
  chmodSync(target, 0o755);
}
