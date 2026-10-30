/**
 * The plants each side must report, by name. The verdict fails a side whose
 * report is missing one or has one this list doesn't name, so an empty or
 * shortened plant list can't pass. `canary-verdict.test.ts` checks that each
 * name appears in the file that plants it.
 */
export interface ExpectedPlants {
  node: readonly string[];
  browser: readonly string[];
  unhooked: readonly string[];
}

export const EXPECTED_PLANTS: ExpectedPlants = {
  /** `app/node-plants.mjs`. */
  node: [
    'fetch to Cloud Firestore',
    'fetch to the metadata server by address',
    'http.request to the metadata server by name',
    'https.request to a Google host the catalog does not list',
    'raw socket to the metadata server',
    'raw socket to the metadata server, respelled',
    'raw TLS socket to Firebase Rules',
    'dns.lookup of Firebase Authentication',
    'http.request through a local proxy to Cloud Firestore',
    'fetch from a worker thread to Cloud Storage',
  ],
  /** `browser-plants.ts`. */
  browser: [
    'page fetch to Cloud Firestore',
    'page fetch to the metadata server',
    'image from a Google host the catalog does not list',
    'WebSocket to the Realtime Database',
    'service-worker fetch to Firebase Authentication',
  ],
  /** `plant-phase.ts`. */
  unhooked: [
    'Bun fetch to a Google host the catalog does not list',
    'Bun fetch to the metadata server by address',
    'curl to Firebase Installations',
  ],
};
