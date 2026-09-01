export type PyricRuntimeChipOption = boolean | { initiallyOpen?: boolean };

export interface PyricRuntimeChipConfig {
  initiallyOpen: boolean;
  studioEnabled: boolean;
}

export const PYRIC_RUNTIME_CHIP_META = 'pyric-runtime-chip';

/** Encode the Vite option as declarative HTML consumed by the init entry. */
export function runtimeChipMetaValue(option: PyricRuntimeChipOption | undefined): string {
  if (option === false) return 'off';
  return typeof option === 'object' && option.initiallyOpen ? 'expanded' : 'collapsed';
}

interface RuntimeChipDocument {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

/** Read the browser-inlined chip value, preferring the `NEXT_PUBLIC_`-prefixed
 * name (the only one Next.js is guaranteed to expose to client bundles) and
 * falling back to the unprefixed name for other bundlers/back-compat. */
function bundlerRuntimeChipValue(): string | undefined {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') return undefined;
  if (typeof process.env.NEXT_PUBLIC_PYRIC_RUNTIME_CHIP === 'string') {
    return process.env.NEXT_PUBLIC_PYRIC_RUNTIME_CHIP;
  }
  if (typeof process.env.PYRIC_RUNTIME_CHIP === 'string') {
    return process.env.PYRIC_RUNTIME_CHIP;
  }
  return undefined;
}

function hasBundlerRuntimeChipConfig(): boolean {
  return bundlerRuntimeChipValue() !== undefined;
}

/** Read plugin-authored values from DOM metadata or bundler environment variables, defaulting to collapsed UI when omitted. */
export function readPyricRuntimeChipConfig(
  documentLike: RuntimeChipDocument,
): PyricRuntimeChipConfig | null {
  const meta = documentLike.querySelector(`meta[name="${PYRIC_RUNTIME_CHIP_META}"]`);
  const hasMetaTag = meta !== null;
  let value = hasMetaTag ? meta.getAttribute('content') : null;

  const shouldFallbackToEnv = !hasMetaTag && hasBundlerRuntimeChipConfig();
  if (shouldFallbackToEnv) {
    value = bundlerRuntimeChipValue() as string;
  }
  if (value === 'off') {
    return null;
  }

  const studioEnabled = !hasMetaTag || meta.getAttribute('data-studio') !== 'off';
  const initiallyOpen = value === 'expanded';
  return { initiallyOpen, studioEnabled };
}
