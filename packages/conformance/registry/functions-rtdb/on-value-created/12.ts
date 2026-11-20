import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ['onValueCreated'],
  diverged: {
    automation: 'oracle-backed',
    statusNote:
      'by-design: Pyric delivers RTDB create events directly over IPC in the isolated Functions child without an Eventarc HTTP push hop, so it records the rejected handler and marker without retrying while requestStatuses is [] instead of Cloud Run HTTP [200].',
  },
  api: 'onValueCreated(ref, handler)',
  behavior:
    'A handler that throws or returns a rejected Promise runs once without retry and reports its error marker to the runtime; production also logs an HTTP 200 Eventarc acknowledgement on Cloud Run, whereas Pyric delivers events over IPC with no HTTP request status.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-failed-execution.json` (`deliveryCount: 1`, `runtimeErrorReported: true`, `matchingRuntimeErrorCount: 1`, `requestStatuses: [200]`); Pyric matches the single delivery and reported runtime error marker and pins `requestStatuses: []` as a by-design transport divergence.',
  observations: ['functions-rtdb-onvaluecreated-failed-execution'],
});
