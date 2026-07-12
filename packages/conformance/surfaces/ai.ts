import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 1,
  maturity: 'Experimental, climbed under Conformance Driven Development',
  kind: 'mirror',
  registry: 'ai',
  censusSurface: 'ai',
  upstream: 'firebase/ai',
  mirrors: ['pyric/ai'],
  observationPrefixes: ['ai-'],
  coverage: true,
  scopeNote:
    'V1 scope is the core REST plane (getAI/generateContent/streaming/chat/function-calling/countTokens); every in-scope export is mirrored. Out of scope: Imagen only (deprecated, June 2026 shutdown upstream), including its template-served models. Deferred: the Live API family, server-side templates, and hybrid/on-device inference — intended and buildable through existing sandbox seams, counted as coverage debt.',
  conformanceSuite: 'packages/pyric/test/ai',
  captureRigs: ['ai-logic'],
};
