/**
 * Augment Next.js configuration environment variables to pass Pyric runtime
 * options (such as chip state) down into browser client builds.
 */
import type { NextConfigObject, PyricNextOptions } from './types.js';
import { runtimeChipMetaValue } from '../serve/runtime/chip-config.js';

export function augmentRuntimeEnv(config: NextConfigObject, options?: PyricNextOptions): NextConfigObject {
  if (options === undefined || options.runtimeChip === undefined) {
    return config;
  }
  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const existingEnv = updatedConfig.env !== undefined ? Object.assign({}, updatedConfig.env) : {};
  const chipValue = runtimeChipMetaValue(options.runtimeChip);
  // Next.js only inlines `.env`-sourced values into the browser bundle when the
  // key carries the `NEXT_PUBLIC_` prefix, so client components must read the
  // prefixed name. The unprefixed name is kept for backwards compatibility with
  // any existing server-side or bundler-level readers of `PYRIC_RUNTIME_CHIP`.
  existingEnv.NEXT_PUBLIC_PYRIC_RUNTIME_CHIP = chipValue;
  existingEnv.PYRIC_RUNTIME_CHIP = chipValue;
  updatedConfig.env = existingEnv;
  return updatedConfig;
}
