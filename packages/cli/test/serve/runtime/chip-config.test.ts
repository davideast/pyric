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

  it('reads only known plugin-authored metadata values', () => {
    const documentWith = (content: string | null, studio = 'on') => ({
      querySelector: () => content === null ? null : {
        getAttribute: (name: string) => name === 'content' ? content : studio,
      },
    });
    expect(readPyricRuntimeChipConfig(documentWith('collapsed'))).toEqual({ initiallyOpen: false, studioEnabled: true });
    expect(readPyricRuntimeChipConfig(documentWith('expanded', 'off'))).toEqual({ initiallyOpen: true, studioEnabled: false });
    expect(readPyricRuntimeChipConfig(documentWith('off'))).toBeNull();
    expect(readPyricRuntimeChipConfig(documentWith('unexpected'))).toBeNull();
    expect(readPyricRuntimeChipConfig(documentWith(null))).toBeNull();
  });
});
