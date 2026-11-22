import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

export const MISSING_NODE_ON_PATH_MESSAGE =
  "Required executable 'node' was not found on PATH. Install Node.js or add 'node' to PATH to run CLI serve fixtures.";

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const st = statSync(candidate);
    if (!st.isFile()) {
      return false;
    }
    if (platform !== 'win32') {
      accessSync(candidate, constants.X_OK);
    }
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

function searchPathForExecutable(
  name: string,
  pathEnv: string,
  platform: NodeJS.Platform,
): string | null {
  let candidates = [name];
  if (platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(name)) {
    candidates = [`${name}.exe`, `${name}.cmd`, name];
  }
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  for (const rawDir of pathEnv.split(pathDelimiter)) {
    const dir = rawDir.trim();
    if (dir === '') {
      continue;
    }
    for (const candidateName of candidates) {
      const fullPath = join(dir, candidateName);
      if (isExecutableFile(fullPath, platform)) {
        return fullPath;
      }
    }
  }
  return null;
}

/**
 * Shared fixture check (#1854): resolve `PYRIC_TEST_NODE` or `node` on `PATH`
 * before starting any Node host, Functions, or Vite restart fixture so missing
 * `node` fails immediately with one clear message instead of hanging or
 * reporting `(undefined): null`.
 */
export function resolveNodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.PYRIC_TEST_NODE?.trim();
  const pathEnv = env.PATH ?? '';
  if (configured !== undefined && configured !== '') {
    const hasPathSeparator = configured.includes('/') || configured.includes('\\');
    if (hasPathSeparator) {
      if (isExecutableFile(configured, platform)) {
        return configured;
      }
      throw new Error(
        `Required Node executable from PYRIC_TEST_NODE ('${configured}') was not found or is not executable.`,
      );
    }
    const resolvedConfigured = searchPathForExecutable(configured, pathEnv, platform);
    if (resolvedConfigured !== null) {
      return resolvedConfigured;
    }
    throw new Error(
      `Required executable '${configured}' (from PYRIC_TEST_NODE) was not found on PATH.`,
    );
  }
  const resolvedNode = searchPathForExecutable('node', pathEnv, platform);
  if (resolvedNode !== null) {
    return resolvedNode;
  }
  throw new Error(MISSING_NODE_ON_PATH_MESSAGE);
}
