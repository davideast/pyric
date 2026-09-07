import type { RequestEvent } from 'pyric/sandbox';

/** Classify primary proof evidence without treating rejected siblings as failures. */
export function isQueryProofUnsupported(event: {
  result?: string;
  queryProof?: RequestEvent['queryProof'];
}): boolean {
  if (event.result === 'allow') return false;
  const kind = event.queryProof?.kind;
  return kind === 'unsupported-predicate' || kind === 'unsupported-path';
}
