import Foundation
import Testing
import PyricAppCheck
import PyricFirestore
import PyricCrashlytics

private final class MonotonicTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var currentMillis: Int64

    init(startMillis: Int64 = 1_700_000_000_000) {
        self.currentMillis = startMillis
    }

    func nextMillis() -> Int64 {
        lock.withLock {
            currentMillis += 25
            return currentMillis
        }
    }
}

@Suite("PyricCrashlytics Unit Suite", .serialized)
struct PyricCrashlyticsUnitTests {
    private static func makeIsolatedApp(prefix: String) -> FirebaseApp {
        let name = "\(prefix)-\(UUID().uuidString)"
        let options = FirebaseOptions(
            projectID: "demo-unit-crashlytics",
            apiKey: "unit-crashlytics-key",
            googleAppID: "1:888888888888:ios:unitcrashlytics"
        )
        return FirebaseApp(name: name, options: options, environment: [:])
    }

    @Test("Preserves FIFO order across log, custom keys, userID, NSError cause chains, ExceptionModel, and flush")
    func fifoOrderingCustomKeysErrorCausesAndExceptionModel() async throws {
        let app = Self.makeIsolatedApp(prefix: "unit-fifo")
        let channel = MockCrashlyticsBridgeChannel()
        let clock = MonotonicTestClock()
        let crashlytics = Crashlytics.crashlytics(
            app: app,
            transport: channel,
            clockMillis: { clock.nextMillis() }
        )

        crashlytics.setUserID("ios-user-42")
        crashlytics.setCustomValue(true, forKey: "isSubscriber")
        crashlytics.setCustomValue(7, forKey: "cartCount")
        crashlytics.setCustomValue(Int64(9_000_000_000), forKey: "quotaBytes")
        crashlytics.setCustomValue(0.875, forKey: "confidence")
        crashlytics.setCustomValue(Float(2.5), forKey: "scale")
        crashlytics.setCustomValue(Double.infinity, forKey: "infiniteMetric")
        crashlytics.setCustomValue(URL(string: "https://example.test/checkout"), forKey: "checkoutURL")
        crashlytics.setCustomKeysAndValues([
            "tier": "enterprise",
            "obsolete": "temp",
        ])
        crashlytics.setCustomValue(nil, forKey: "obsolete")

        crashlytics.log("step-1: open checkout")
        crashlytics.log(format: "step-%d: items=%d ratio=%.2f", 2, 3, 0.75)

        let leafCause = NSError(
            domain: "NSPOSIXErrorDomain",
            code: 54,
            userInfo: [NSLocalizedDescriptionKey: "Connection reset by peer"]
        )
        let middleCause = NSError(
            domain: "NSURLErrorDomain",
            code: -1005,
            userInfo: [
                NSLocalizedDescriptionKey: "Network connection was lost",
                NSUnderlyingErrorKey: leafCause,
            ]
        )
        let topError = NSError(
            domain: "com.example.checkout",
            code: 502,
            userInfo: [
                NSLocalizedDescriptionKey: "Payment capture failed",
                NSUnderlyingErrorKey: middleCause,
                "gateway": "stripe-sandbox",
            ]
        )
        crashlytics.record(
            error: topError,
            userInfo: ["attempt": 2, "retryable": true]
        )

        let model = ExceptionModel(name: "DartPluginException", reason: "Unhandled channel timeout")
        model.stackTrace = [
            StackFrame(symbol: "CheckoutBridge.invoke()", file: "CheckoutBridge.swift", line: 88),
            StackFrame.stackFrame(address: 0x1040a2b0),
            StackFrame.stackFrame(symbol: "_start_main"),
        ]
        #expect(model.stackTrace[0].isSymbolicated == true)
        #expect(model.stackTrace[0].description == "{CheckoutBridge.swift - CheckoutBridge.invoke():88}")
        #expect(model.stackTrace[1].isSymbolicated == false)
        #expect(model.stackTrace[1].description.contains("0x1040a2b0"))
        crashlytics.record(exceptionModel: model)

        try await crashlytics.flush()
        let state = try await crashlytics.getState()

        #expect(state.userID == "ios-user-42")
        #expect(state.customKeys["isSubscriber"] == .bool(true))
        #expect(state.customKeys["cartCount"] == .int(7))
        #expect(state.customKeys["quotaBytes"] == .int(9_000_000_000))
        #expect(state.customKeys["confidence"] == .double(0.875))
        #expect(state.customKeys["scale"] == .double(2.5))
        #expect(state.customKeys["infiniteMetric"] == .string("inf"))
        #expect(state.customKeys["checkoutURL"] == .string("https://example.test/checkout"))
        #expect(state.customKeys["tier"] == .string("enterprise"))
        #expect(state.customKeys["obsolete"] == nil)

        #expect(state.logs.count == 2)
        #expect(state.logs[0].message == "step-1: open checkout")
        #expect(state.logs[1].message == "step-2: items=3 ratio=0.75")

        #expect(state.reports.count == 2)
        let firstReport = state.reports[0]
        #expect(firstReport.appID == app.name)
        #expect(firstReport.name == "com.example.checkout")
        #expect(firstReport.code == "502")
        #expect(firstReport.message == "Payment capture failed")
        #expect(firstReport.cause == "NSURLErrorDomain(-1005): Network connection was lost <- NSPOSIXErrorDomain(54): Connection reset by peer")
        #expect(firstReport.sdkPlatform == "ios")
        #expect(firstReport.fatal == false)
        #expect(firstReport.flushed == true)
        #expect(firstReport.userID == "ios-user-42")
        #expect(firstReport.attributes["gateway"] == .string("stripe-sandbox"))
        #expect(firstReport.attributes["attempt"] == .int(2))
        #expect(firstReport.attributes["retryable"] == .bool(true))
        #expect(firstReport.breadcrumbs.map(\.message) == [
            "step-1: open checkout",
            "step-2: items=3 ratio=0.75",
        ])

        let secondReport = state.reports[1]
        #expect(secondReport.name == "DartPluginException")
        #expect(secondReport.message == "Unhandled channel timeout")
        #expect(secondReport.flushed == true)
        let secondStack = try #require(secondReport.stack)
        #expect(secondStack.contains("{CheckoutBridge.swift - CheckoutBridge.invoke():88}"))
        #expect(secondStack.contains("0x1040a2b0"))
        #expect(secondStack.contains("_start_main"))

        // Clearing userID with nil sends empty string on wire
        crashlytics.setUserID(nil)
        let clearedState = try await crashlytics.getState()
        #expect(clearedState.userID == "")

        await crashlytics.disconnect()
        await app.delete()
    }

    @Test("Manages disabled collection unsent queue, checkAndUpdateUnsentReports, completion handlers, and fatal crash flag")
    func unsentReportQueueLifecycleCompletionCallbacksAndFatalFlag() async throws {
        let app = Self.makeIsolatedApp(prefix: "unit-unsent")
        let channel = MockCrashlyticsBridgeChannel()
        let crashlytics = Crashlytics.crashlytics(app: app, transport: channel)

        #expect(crashlytics.isCrashlyticsCollectionEnabled() == true)
        #expect(crashlytics.didCrashDuringPreviousExecution() == false)

        crashlytics.setCrashlyticsCollectionEnabled(false)
        #expect(crashlytics.isCrashlyticsCollectionEnabled() == false)

        let deferredErr = NSError(
            domain: "com.example.offline",
            code: 409,
            userInfo: [NSLocalizedDescriptionKey: "Deferred conflict"]
        )
        crashlytics.record(error: deferredErr)

        let fatalModel = ExceptionModel(name: "SIGABRT", reason: "Simulated fatal crash")
        fatalModel.isFatal = true
        crashlytics.record(exceptionModel: fatalModel)
        #expect(crashlytics.didCrashDuringPreviousExecution() == true)

        // Verify completion-handler overload of checkForUnsentReports
        let hasUnsentViaCallback: Bool = await withCheckedContinuation { continuation in
            crashlytics.checkForUnsentReports { hasUnsent in
                continuation.resume(returning: hasUnsent)
            }
        }
        #expect(hasUnsentViaCallback == true)

        // Verify checkAndUpdateUnsentReports returns newest unsent CrashlyticsReport and forwards annotations
        let unsentReport = try #require(await crashlytics.checkAndUpdateUnsentReports())
        #expect(!unsentReport.reportID.isEmpty)
        #expect(unsentReport.hasCrash == true)
        unsentReport.log("post-crash user feedback: tapped retry")
        unsentReport.setCustomValue("feedback-submitted", forKey: "recoveryState")
        unsentReport.setUserID("feedback-user-9")
        #expect(unsentReport.loggedMessagesSnapshot == ["post-crash user feedback: tapped retry"])
        #expect(unsentReport.customValuesSnapshot["recoveryState"] == .string("feedback-submitted"))
        #expect(unsentReport.userIDSnapshot == "feedback-user-9")

        // Promote unsent reports via sendUnsentReports
        crashlytics.sendUnsentReports()
        #expect(await crashlytics.checkForUnsentReports() == false)
        #expect(await crashlytics.checkAndUpdateUnsentReports() == nil)

        let promotedState = try await crashlytics.getState()
        #expect(promotedState.unsentReports.isEmpty)
        #expect(promotedState.reports.count == 2)
        #expect(promotedState.reports.allSatisfy { $0.flushed })
        #expect(promotedState.userID == "feedback-user-9")
        #expect(promotedState.customKeys["recoveryState"] == .string("feedback-submitted"))

        // Queue another unsent report and discard via deleteUnsentReports()
        crashlytics.record(
            error: NSError(
                domain: "com.example.discard",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "To be deleted"]
            )
        )
        #expect(await crashlytics.checkForUnsentReports() == true)
        crashlytics.deleteUnsentReports()
        #expect(await crashlytics.checkForUnsentReports() == false)

        // Reset collection override with nil
        crashlytics.setCrashlyticsCollectionEnabled(nil)
        #expect(crashlytics.isCrashlyticsCollectionEnabled() == true)

        // Verify completion-handler overload of flush
        let flushErr: (any Error)? = await withCheckedContinuation { continuation in
            crashlytics.flush { err in
                continuation.resume(returning: err)
            }
        }
        #expect(flushErr == nil)

        await crashlytics.disconnect()
        await app.delete()
    }

    @Test("Caches per-app instances, omits appId on [DEFAULT], attaches AppCheck tokens, and reconfigures emulator host")
    func instanceCachingDefaultAppWireOmissionAppCheckAndEmulator() async throws {
        let appA = Self.makeIsolatedApp(prefix: "unit-cache-a")
        let appB = Self.makeIsolatedApp(prefix: "unit-cache-b")

        let cachedA1 = Crashlytics.crashlytics(app: appA)
        let cachedA2 = Crashlytics.crashlytics(app: appA)
        let cachedB = Crashlytics.crashlytics(app: appB)
        #expect(cachedA1 === cachedA2)
        #expect(cachedA1 !== cachedB)
        #expect(cachedA1.wireAppID == appA.name)

        cachedA1.useEmulator(withHost: "10.0.2.2", port: 9444)
        let endpoint = await cachedA1.bridgeClient.endpoint
        #expect(endpoint.host == "127.0.0.1")
        #expect(endpoint.port == 9444)

        await Crashlytics.evictInstance(for: appA)
        let cachedA3 = Crashlytics.crashlytics(app: appA)
        #expect(cachedA3 !== cachedA1)
        await Crashlytics.evictInstance(for: appA)
        await Crashlytics.evictInstance(for: appB)

        // Verify [DEFAULT] app omits appId on wire and AppCheck attaches appCheckToken
        let defaultAppInstance = FirebaseApp(
            name: FirebaseApp.defaultAppName,
            options: FirebaseOptions(projectID: "demo-default-wire"),
            environment: [:]
        )
        let defaultChannel = MockCrashlyticsBridgeChannel()
        let defaultCrashlytics = Crashlytics.crashlytics(app: defaultAppInstance, transport: defaultChannel)
        #expect(defaultCrashlytics.wireAppID == nil)
        defaultCrashlytics.setUserID("default-wire-user")
        try await defaultCrashlytics.flush()

        let defaultOps = defaultChannel.snapshotOps()
        #expect(defaultOps.count == 2)
        #expect(defaultOps[0].payload["appId"] == nil)
        await defaultCrashlytics.disconnect()

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            let appWithCheck = Self.makeIsolatedApp(prefix: "unit-appcheck")
            let checkChannel = MockCrashlyticsBridgeChannel()
            let checkBridge = PyricBridgeClient(channel: checkChannel)
            _ = AppCheck.createForTesting(
                app: appWithCheck,
                providerFactory: AppCheckDebugProviderFactory(),
                bridgeClient: checkBridge
            )
            let checkedCrashlytics = Crashlytics.crashlytics(app: appWithCheck, bridgeClient: checkBridge)
            checkedCrashlytics.log("protected breadcrumb")
            try await checkedCrashlytics.flush()

            let crashOps = checkChannel.snapshotOps().filter { $0.method.hasPrefix("crashlytics.") }
            #expect(crashOps.count == 2)
            #expect(crashOps.allSatisfy { $0.payload["appCheckToken"]?.stringValue == "mock-crashlytics-appcheck-jwt" })

            await checkedCrashlytics.disconnect()
            await checkBridge.disconnect()
            await appWithCheck.delete()
        }
        await appA.delete()
        await appB.delete()
    }
}
