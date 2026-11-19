import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["connectStorageEmulator"],
  api: "connectStorageEmulator(storage, host, port)",
  behavior: "Exported by `firebase/storage`; reroutes a `FirebaseStorage` handle to a local emulator",
  status: "unsupported",
  evidence: "not implemented in `pyric/storage` — the sandbox IS the local-target alternative; emulator parity is out of scope per `index.ts`",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 2 specific value(s)"],
  automation: "unsupported",
  exceptionReason: "unsupported / intentionally out of scope",
});
