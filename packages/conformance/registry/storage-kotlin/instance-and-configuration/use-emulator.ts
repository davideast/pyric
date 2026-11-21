import { row } from './section.ts';

export default row({
  order: 50,
  api: "FirebaseStorage.useEmulator(host, port)",
  behavior: "Validates non-blank host and port in 1..65535 and records emulatorHost / emulatorPort on the instance.",
  featureKeys: ["useEmulator", "emulatorHost"],
  status: "diverged-documented",
  statusNote: "bridge transport",
  evidence: "`useEmulator(host, port)` validates arguments and records `emulatorHost` / `emulatorPort` as verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt`, while Storage wire operations route over `PyricBridgeClient` WebSocket and HTTP byte-route endpoints rather than the upstream Firebase Storage REST emulator protocol.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt",
  ],
});
