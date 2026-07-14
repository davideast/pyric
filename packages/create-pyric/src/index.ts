/**
 * `create-pyric` — scaffold engine for `npm create pyric` and `pyric init`.
 */

export {
  TEMPLATES,
  applyDepsMode,
  mergeIntoExistingPackageJson,
  packageJsonFor,
  normalizeBoolFlags,
  runScaffold,
  type ScaffoldTemplate,
  type DepsMode,
  type ScaffoldResult,
  type ScaffoldRequest,
  type ScaffoldIo,
  type PackageJsonMerge,
} from './scaffold.js';
export { parseCreateArgs, type CreateArgs, type FlagValue } from './parse-args.js';
