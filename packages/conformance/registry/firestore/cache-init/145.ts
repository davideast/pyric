import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["initializeFirestore"],
  api: "initializeFirestore",
  behavior: "Delegates to sandbox `getFirestore(app)` and returns the same handle. Accepts the `settings` argument (so the explicit-init pattern doesn't crash at import) but no-ops the cache/network settings — persistence is always on",
  status: "diverged-documented",
  statusNote: "settings accepted but cache/network settings are no-ops",
});
