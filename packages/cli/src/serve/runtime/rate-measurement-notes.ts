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

export function measurementNotes(service: string): readonly MeasurementNote[] {
  return service === 'firestore' ? firestore : service === 'rtdb' ? rtdb : [];
}
