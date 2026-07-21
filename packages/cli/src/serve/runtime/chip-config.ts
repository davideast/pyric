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

/** Read only plugin-authored values; absent/unknown metadata keeps the UI off. */
export function readPyricRuntimeChipConfig(
  documentLike: RuntimeChipDocument,
): PyricRuntimeChipConfig | null {
  const meta = documentLike.querySelector(`meta[name="${PYRIC_RUNTIME_CHIP_META}"]`);
  const value = meta?.getAttribute('content');
  const studioEnabled = meta?.getAttribute('data-studio') !== 'off';
  if (value === 'collapsed') return { initiallyOpen: false, studioEnabled };
  if (value === 'expanded') return { initiallyOpen: true, studioEnabled };
  return null;
}
