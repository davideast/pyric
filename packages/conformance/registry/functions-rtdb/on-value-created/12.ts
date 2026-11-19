import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["onValueCreated"],
  api: 'onValueCreated(ref, handler)',
  behavior:
    'A handler that throws or returns a rejected Promise is reported by the managed runtime; with retry disabled, the Eventarc request can still be acknowledged with HTTP 200.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-failed-execution.json`; Pyric observes the rejected handler and marker, but has no Eventarc HTTP request seam with which to replay the captured 200 acknowledgement.',
  observations: ['functions-rtdb-onvaluecreated-failed-execution'],
});
