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
  existingEnv.PYRIC_RUNTIME_CHIP = chipValue;
  updatedConfig.env = existingEnv;
  return updatedConfig;
}
