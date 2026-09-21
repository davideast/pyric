import type { CanIUseOptions, CanIUseResult } from './.generated/can-i-use-browser.js';
import { SERVED_MODULES } from './.generated/served-availability.js';

export interface ServedModule {
  surface: string;
  expected: readonly string[];
  exports: readonly string[];
  importsOnly: readonly string[];
}

export type ServedAvailability = 'supported' | 'imports-only' | 'missing';
interface FeatureSupport {
  feature: string;
  surface: string;
  importPaths: readonly string[];
  summary: string;
  caveats: readonly string[];
}
type ServedSupport<T> = T & { served?: ServedAvailability };
type Resolver<T extends FeatureSupport> = (supports: readonly T[], query: string, options?: CanIUseOptions) => CanIUseResult<T>;

export function classifyServedExport(module: ServedModule, feature: string): ServedAvailability {
  const missingExport = !module.exports.includes(feature);
  if (missingExport) return 'missing';
  const importsOnly = module.importsOnly.includes(feature);
  return importsOnly ? 'imports-only' : 'supported';
}

function describeServedSupport<T extends FeatureSupport>(support: T): ServedSupport<T> {
  const entry = Object.entries(SERVED_MODULES).find(([, module]) => module.surface === support.surface);
  const missingModule = entry === undefined;
  if (missingModule) return support;
  const [service, module] = entry;
  const isRuntimeExport = module.expected.includes(support.feature) || module.exports.includes(support.feature);
  // Type-only evidence survives; erased interfaces have no runtime to classify.
  const isTypeOnly = !isRuntimeExport;
  if (isTypeOnly) return support;
  const served = classifyServedExport(module, support.feature);
  const caveats = [...support.caveats];
  const isImportsOnly = served === 'imports-only';
  const isMissing = served === 'missing';
  if (isImportsOnly) caveats.unshift(`In Pyric served mode, ${support.feature} is safe to import but throws when called. Do not call it from a served application.`);
  if (isMissing) caveats.unshift(`Pyric served mode does not export ${support.feature} from firebase/${service}; importing it prevents the application from loading.`);
  return { ...support, served, caveats, summary: `${support.summary} Served mode: ${served}.` };
}

/** Keep served runtime availability separate from the canonical engine evidence. */
export function createServedQuery<T extends FeatureSupport>(supports: readonly T[], resolve: Resolver<T>) {
  return (query: string, options?: CanIUseOptions): CanIUseResult<ServedSupport<T>> => {
    const importPath = options?.importPath ?? '';
    const service = importPath.slice('firebase/'.length);
    const isServedImport = importPath.startsWith('firebase/') && SERVED_MODULES[service] !== undefined;
    const surface = SERVED_MODULES[service]?.surface;
    const scoped = isServedImport ? supports.filter(support => support.surface === surface) : supports;
    const queryOptions = isServedImport ? undefined : options;
    const result = resolve(scoped, query, queryOptions);
    return { ...result, supports: result.supports.map(describeServedSupport) };
  };
}
