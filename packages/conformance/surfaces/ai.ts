import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 1,
  kind: 'mirror',
  registry: 'ai',
  censusSurface: 'ai',
  upstream: 'firebase/ai',
  mirrors: ['pyric/ai'],
  observationPrefixes: ['ai-'],
  coverage: true,
  scopeNote:
    'The core REST plane is mirrored. Deprecated Imagen exports, the Live API, server-side templates, hybrid/on-device inference, and their public types remain visible public-surface gaps; dispositions explain why each runtime symbol is absent without removing it from the denominator.',
  conformanceSuite: 'packages/pyric/test/ai',
  captureRigs: ['ai-logic'],
};
