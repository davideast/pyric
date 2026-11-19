import { errorEnvelope } from './synthesizer.js';
import type { WireErrorEnvelope } from './types.js';

/** `ai-error-retired-model` (404 NOT_FOUND): captured message and ErrorInfo detail, verbatim. */
export function retiredModel(): WireErrorEnvelope {
  const envelope = errorEnvelope(
    404,
    'Gemini 1.5 models are retired as of September 24, 2025. Update to a newer model version. [Learn more.](https://firebase.google.com/docs/ai-logic/faq-and-troubleshooting#discontinued-models)',
    'NOT_FOUND',
  );
  envelope.error.details = [
    {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'RETIRED_MODEL',
      domain: 'firebasevertexai.googleapis.com',
    },
  ];
  return envelope;
}
