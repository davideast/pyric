/** Measurement definitions shared by the UI and portable investigation captures. */
export interface MeasurementNote { readonly label: string; readonly text: string }
const firestore: readonly MeasurementNote[] = [
  {
    "label": "Includes",
    "text": "Document fetches, initial listener results, added and updated documents, successful writes and deletes."
  },
  {
    "label": "Not measured",
    "text": "Index scans, rules-dependent reads, transactions, query removals, storage and network charges."
  },
  {
    "label": "Assumption",
    "text": "Local listener registrations represent new connections. Production caching, reconnects and shared connections can change charges."
  }
];
const rtdb: readonly MeasurementNote[] = [
  {
    "label": "Operations",
    "text": "Reads and writes count SDK requests, including failed attempts. Listener deliveries count callbacks, including initial results."
  },
  {
    "label": "Payload",
    "text": "UTF-8 JSON size of fetched values and listener snapshots."
  },
  {
    "label": "Not measured",
    "text": "Wire deltas, connection sharing, protocol and encryption overhead, stored data and onDisconnect execution."
  },
  {
    "label": "Billing limit",
    "text": "Snapshot size is not billed download size. A callback can contain a full value when the server only sends a change."
  }
];

const storage: readonly MeasurementNote[] = [
  { label: 'Operations', text: 'Reads, writes and deletes count public SDK calls, including failed attempts. Resumable uploads count once; progress callbacks do not add operations.' },
  { label: 'Transfer', text: 'Uploaded bytes count completed uploads. Downloaded bytes count data returned by getBytes and getBlob. Failed or canceled transfers contribute no bytes.' },
  { label: 'Not measured', text: 'Fetching a download URL outside the SDK, partial transfers, retries, protocol overhead, stored bytes over time, and provider billing operation classes.' },
  { label: 'Billing limit', text: 'These are local operation and payload measurements, not billed requests, network egress, or storage charges.' },
];

export function measurementNotes(service: string): readonly MeasurementNote[] {
  if (service === 'ai') return [
    { label: 'Requests', text: 'Started counts generation, streaming generation and countTokens calls when they begin. Completed counts successful responses when they finish; failures are separate. In progress is the current number awaiting an outcome. A stream counts once; chunks are render signals.' },
    { label: 'Tokens', text: 'Backend input and output tokens use final backend-reported usage. Estimated and scripted tokens are separate. Unknown usage is counted explicitly; countTokens estimates are not generation usage.' },
    { label: 'Timing', text: 'Duration measures the client request through response completion. First chunk measures receipt of the first streamed envelope, which may contain no text.' },
    { label: 'Identity', text: 'Requested aliases, configured routing and backend-reported models are distinct. Scripted model versions are not evidence of a real model. A proxy endpoint does not establish whether its upstream is local.' },
    { label: 'Billing', text: 'This page only. No pricing projection, project-wide usage, retries below the adapter, or billing totals are inferred.' },
  ];
  return service === 'firestore' ? firestore : service === 'rtdb' ? rtdb : service === 'storage' ? storage : [];
}
