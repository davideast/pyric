import Foundation
import Testing
@testable import PyricCrashlytics
@testable import PyricFirestore

@Suite("PyricCrashlytics Phase 2 Parity Regression Suite")
struct CrashlyticsPhase2RegressionTests {
    @Test("P2-S13: boxed Optional.none encodes as null, syncDidCrashFlag clears false, and disposed log is ignored")
    func boxedOptionalNoneAndStateSync() async {
        let nilString: String? = nil
        let boxed: Any = nilString as Any
        let nestedNil: String?? = .some(nil)
        #expect(CrashlyticsValueNormalizer.normalizeCustomValue(boxed) == .null)
        #expect(CrashlyticsValueNormalizer.normalizeCustomValue(nestedNil as Any) == .null)
        let someBoxed: Any = Optional("ok") as Any
        #expect(CrashlyticsValueNormalizer.normalizeCustomValue(someBoxed) == .string("ok"))

        let app = FirebaseApp(name: "crash-p2-\(UUID().uuidString)")
        let client = PyricBridgeClient(endpoint: URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!)
        let crash = Crashlytics.crashlytics(app: app, bridgeClient: client)
        crash.simulatePreviousCrashForTesting(true)
        #expect(crash.didCrashDuringPreviousExecution() == true)
        crash.syncDidCrashFlag(false)
        #expect(crash.didCrashDuringPreviousExecution() == false)

        await crash.disconnect()
        crash.log("ignored-after-dispose")
        crash.setCrashlyticsCollectionEnabled(false)
        let crumbCount = crash.stateLock.withLock { crash._breadcrumbs.count }
        #expect(crumbCount == 0)
        await client.disconnect()
    }
}
