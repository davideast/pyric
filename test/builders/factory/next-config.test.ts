// Setup's withPyric adaptation of Studio's next.config.ts: it applies to the
// shape Studio has, and stops with the edit's name on any other shape.
import { describe, expect, test } from 'bun:test';
import { applyEdits, ConfigEditMissing, WITH_PYRIC_EDITS } from './next-config.ts';

const STUDIO_SHAPE = `export default async function buildConfig(): Promise<NextConfig> {
  const { withPyric } = (await dynamicImport(adapterUrl)) as {
    withPyric: (config: NextConfig, options?: Record<string, unknown>) => any;
  };
  const config = withPyric({
    ...nextConfig,
  }, {
    url: sandboxUrl,
    runtimeChip: true,
  });
  config.turbopack = config.turbopack ?? {};
  return config;
}
`;

describe('the withPyric adaptation', () => {
  test('makes buildConfig call the function withPyric returns', () => {
    const adapted = applyEdits(STUDIO_SHAPE, WITH_PYRIC_EDITS);
    expect(adapted).toContain('async function buildConfig(phase: string, defaults: { defaultConfig: NextConfig })');
    expect(adapted).toContain('const config = await withPyric({');
    expect(adapted).toContain('  })(phase, defaults);');
  });

  test('stops, naming the edit, when the file has a different shape', () => {
    const adapted = applyEdits(STUDIO_SHAPE, WITH_PYRIC_EDITS);
    expect(() => applyEdits(adapted, WITH_PYRIC_EDITS)).toThrow(ConfigEditMissing);
    expect(() => applyEdits(STUDIO_SHAPE.replace('runtimeChip: true,', 'runtimeChip: false,'), WITH_PYRIC_EDITS)).toThrow(/called with phase and defaults/);
  });
});
