/**
 * `create-pyric` — scaffold engine for `npm create pyric` and `pyric init`.
 */

export {
  TEMPLATES,
  TEMPLATE_NAMES,
  isTemplateName,
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
  type TemplateName,
} from './scaffold.js';
export { parseCreateArgs, type CreateArgs, type FlagValue } from './parse-args.js';
