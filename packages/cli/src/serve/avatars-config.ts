/**
 * The `avatars` option's resolution: what `pyric({ avatars })` (or the
 * `PYRIC_AVATARS` env var) means for the `/__pyric/assets/avatar/<uid>`
 * route, reduced to a plain shape `sandbox-session.ts` can build a resolver
 * from. Shaped like `vite-ai-config.ts`'s resolution — a pure function of
 * the caller's option value and its environment, with any config-time
 * validation (a set directory that doesn't exist or has no manifest) thrown
 * here, at startup, rather than deferred to the first request. See
 * `docs/auth-avatars-design.md` for the design.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadManifest } from './assets/manifest.js';
import type { AssetSource } from './assets/resolver.js';

/**
 * Profile photos for sandbox provider users. Default: deterministic
 * generated avatars. A string selects a pre-created avatar set (directory
 * path, resolved from the project root). `false` disables the avatar route
 * entirely. An object supplies a custom source that runs in the dev server,
 * never the browser.
 */
export type PyricAvatarsOptions = false | string | { source: AssetSource };

export interface ResolvedAvatarsConfig {
  /** Whether `/__pyric/assets/avatar/<uid>` is mounted at all. */
  enabled: boolean;
  /** A pre-created avatar set directory, resolved against the project root.
   *  Mutually exclusive with `source` — the option shape guarantees it. */
  setDir?: string;
  /** A source that runs in the dev server. Mutually exclusive with `setDir`. */
  source?: AssetSource;
}

/** `PYRIC_AVATARS=0` and `PYRIC_AVATARS=false` both mean "off"; any other
 *  non-empty value names a set directory path. */
function isDisablingEnvValue(value: string): boolean {
  return value === '0' || value === 'false';
}

/** Resolve, and validate, a `string` avatars option (or its env equivalent)
 *  into a set-directory config. Throws a config-time error — never a
 *  first-request one — when the directory or its manifest is missing or
 *  invalid. */
function resolveSetDirConfig(setPath: string, projectRoot: string): ResolvedAvatarsConfig {
  const setDir = path.resolve(projectRoot, setPath);
  if (!existsSync(setDir)) {
    throw new Error(
      `pyric: avatars set directory not found: ${setDir} (configured as ${JSON.stringify(setPath)}).`,
    );
  }
  let manifest;
  try {
    manifest = loadManifest(setDir);
  } catch (error) {
    throw new Error(
      `pyric: avatars set at ${setDir} has an invalid manifest.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest === null) {
    throw new Error(
      `pyric: avatars set directory ${setDir} has no manifest.json. ` +
        `See docs/auth-avatars-design.md for the set format.`,
    );
  }
  return { enabled: true, setDir };
}

/**
 * Resolve the plugin's explicit-options-over-environment avatars convention.
 * Precedence: an explicit `options` value, then `PYRIC_AVATARS`, then the
 * zero-config default (enabled, generated avatars, no set directory or
 * source).
 */
export function resolveAvatarsConfig(
  options: PyricAvatarsOptions | undefined,
  env: Record<string, string | undefined>,
  projectRoot: string,
): ResolvedAvatarsConfig {
  if (options === false) {
    return { enabled: false };
  }
  if (typeof options === 'string') {
    return resolveSetDirConfig(options, projectRoot);
  }
  if (options !== undefined) {
    return { enabled: true, source: options.source };
  }

  const envValue = env.PYRIC_AVATARS;
  const hasEnvValue = envValue !== undefined && envValue.length > 0;
  if (hasEnvValue) {
    if (isDisablingEnvValue(envValue)) {
      return { enabled: false };
    }
    return resolveSetDirConfig(envValue, projectRoot);
  }

  return { enabled: true };
}
