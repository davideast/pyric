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

/** Read plugin-authored values from DOM metadata or bundler environment variables, defaulting to collapsed UI when omitted. */
export function readPyricRuntimeChipConfig(
  documentLike: RuntimeChipDocument,
): PyricRuntimeChipConfig | null {
  const meta = documentLike.querySelector(`meta[name="${PYRIC_RUNTIME_CHIP_META}"]`);
  let value = meta !== null ? meta.getAttribute('content') : null;
  if (value === null && typeof process !== 'undefined' && typeof process.env !== 'undefined' && typeof process.env.PYRIC_RUNTIME_CHIP === 'string') {
    value = process.env.PYRIC_RUNTIME_CHIP;
  }
  if (value === 'off') {
    return null;
  }
  const studioEnabled = meta === null || meta.getAttribute('data-studio') !== 'off';
  const initiallyOpen = value === 'expanded';
  return { initiallyOpen, studioEnabled };
}
