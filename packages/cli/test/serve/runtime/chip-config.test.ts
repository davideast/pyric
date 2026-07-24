import { describe, expect, it } from 'bun:test';
import {
  readPyricRuntimeChipConfig,
  runtimeChipMetaValue,
} from '../../../src/serve/runtime/chip-config.js';

describe('Pyric runtime chip configuration', () => {
  it('defaults to collapsed and supports the small explicit option surface', () => {
    expect(runtimeChipMetaValue(undefined)).toBe('collapsed');
    expect(runtimeChipMetaValue(true)).toBe('collapsed');
    expect(runtimeChipMetaValue(false)).toBe('off');
    expect(runtimeChipMetaValue({ initiallyOpen: true })).toBe('expanded');
  });

  it('reads plugin-authored metadata values or defaults to collapsed when meta tag is omitted', () => {
    const documentWith = (content: string | null, studio = 'on') => ({
      querySelector: () => content === null ? null : {
        getAttribute: (name: string) => name === 'content' ? content : studio,
      },
    });
    expect(readPyricRuntimeChipConfig(documentWith('collapsed'))).toEqual({ initiallyOpen: false, studioEnabled: true });
    expect(readPyricRuntimeChipConfig(documentWith('expanded', 'off'))).toEqual({ initiallyOpen: true, studioEnabled: false });
    expect(readPyricRuntimeChipConfig(documentWith('off'))).toBeNull();
    expect(readPyricRuntimeChipConfig(documentWith('unexpected'))).toEqual({ initiallyOpen: false, studioEnabled: true });
    expect(readPyricRuntimeChipConfig(documentWith(null))).toEqual({ initiallyOpen: false, studioEnabled: true });
  });

  it('reads environment variables (from Next.js or bundlers) when meta tag is absent', () => {
    const emptyDoc = { querySelector: () => null };
    process.env.PYRIC_RUNTIME_CHIP = 'off';
    expect(readPyricRuntimeChipConfig(emptyDoc)).toBeNull();

    process.env.PYRIC_RUNTIME_CHIP = 'expanded';
    expect(readPyricRuntimeChipConfig(emptyDoc)).toEqual({ initiallyOpen: true, studioEnabled: true });

    delete process.env.PYRIC_RUNTIME_CHIP;
    expect(readPyricRuntimeChipConfig(emptyDoc)).toEqual({ initiallyOpen: false, studioEnabled: true });
  });
});
