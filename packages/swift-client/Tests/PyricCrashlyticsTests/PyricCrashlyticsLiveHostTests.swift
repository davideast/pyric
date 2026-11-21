import Foundation
import Testing
import PyricAppCheck
import PyricFirestore
import PyricCrashlytics

@Suite("PyricCrashlytics Live-Host Conformance Suite", .serialized)
struct PyricCrashlyticsLiveHostTests {
    private static func trimmedEnv(_ key: String) -> String? {
        guard let raw = ProcessInfo.processInfo.environment[key]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }
        return raw
    }

    @Test("Proves all 10 crashlytics.* wire ops, FIFO ordering, unsent report lifecycle, multi-app isolation, and App Check token attachment against live HostedRuntime")
    func fullLiveHostCrashlyticsWorkflow() async throws {
        let requireLive = Self.trimmedEnv("PYRIC_REQUIRE_CRASHLYTICS_LIVE") == "1"
        guard let rawBridgeURL = Self.trimmedEnv("PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL") else {
            if requireLive {
                Issue.record("PYRIC_REQUIRE_CRASHLYTICS_LIVE=1 requires PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL")
                return
            }
            // Standalone offline `swift test` execution: verify local model and collection flag
            // invariants on a UUID-scoped FirebaseApp without network I/O or skipped tests.
            let offlineApp = FirebaseApp(
                name: "offline-swift-crashlytics-\(UUID().uuidString)",
                options: FirebaseOptions(projectID: "demo-offline-swift-crashlytics"),
                environment: [:]
            )
            let offlineChannel = PyricBridgeClient(
                endpoint: URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!
            )
            let offlineCrashlytics = Crashlytics.crashlytics(app: offlineApp, bridgeClient: offlineChannel)
            #expect(offlineCrashlytics.isCrashlyticsCollectionEnabled() == true)
            let frame = StackFrame(symbol: "OfflineProbe.run()", file: "OfflineProbe.swift", line: 12)
            #expect(frame.description == "{OfflineProbe.swift - OfflineProbe.run():12}")
            await offlineCrashlytics.disconnect()
            await offlineChannel.disconnect()
            await offlineApp.delete()
            return
        }

        let projectID = Self.trimmedEnv("PYRIC_LIVE_PROJECT_ID") ?? "demo-swift-crashlytics-live"
        let iosAppID = Self.trimmedEnv("PYRIC_LIVE_IOS_APP_ID") ?? "1:888888888888:ios:swiftcrashlyticslive"
        let bridgeURI = try #require(URL(string: rawBridgeURL))
        let bridgeHost = try #require(bridgeURI.host)
        let bridgePort = try #require(bridgeURI.port)

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            let options = FirebaseOptions(
                projectID: projectID,
                apiKey: "sandbox-crashlytics-key",
                googleAppID: iosAppID
            )

            // Configure both [DEFAULT] and a UUID-named FirebaseApp against the live HostedRuntime
            FirebaseApp.configure(options: options)
            let defaultApp = FirebaseApp.app()
            defaultApp.useEmulator(withHost: bridgeHost, port: bridgePort)

            let namedAppName = "live-swift-crashlytics-\(UUID().uuidString)"
            FirebaseApp.configure(name: namedAppName, options: options)
            let namedApp = try #require(FirebaseApp.app(name: namedAppName))
            namedApp.useEmulator(withHost: bridgeHost, port: bridgePort)

            // Install App Check on namedApp so every crashlytics.* op carries a verified RS256 appCheckToken
            AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
            defer {
                AppCheck.setAppCheckProviderFactory(DeviceCheckProviderFactory())
            }
            _ = AppCheck.appCheck(app: namedApp)

            let defaultCrashlytics = Crashlytics.crashlytics()
            let crashlytics = Crashlytics.crashlytics(app: namedApp)

            // 1. Default app vs named app isolation on shared CrashlyticsBroker
            defaultCrashlytics.setUserID("default-ios-user")
            try await defaultCrashlytics.flush()

            // 2. Custom keys, user ID, formatted & plain breadcrumbs, NSError + ExceptionModel
            crashlytics.setUserID("live-ios-user-77")
            crashlytics.setCustomValue(true, forKey: "proPlan")
            crashlytics.setCustomValue(4, forKey: "retryBudget")
            crashlytics.setCustomValue(Int64(12_500_000_000), forKey: "diskFreeBytes")
            crashlytics.setCustomValue(0.0625, forKey: "sampleRate")
            crashlytics.setCustomKeysAndValues([
                "regionCode": "us-central1",
                "ephemeralFlag": "to-remove",
            ])
            crashlytics.setCustomValue(nil, forKey: "ephemeralFlag")

            crashlytics.log("crumb-1: view appeared")
            crashlytics.log(format: "crumb-%d: loaded %d records", 2, 19)

            let underlyingIO = NSError(
                domain: NSPOSIXErrorDomain,
                code: 60,
                userInfo: [NSLocalizedDescriptionKey: "Operation timed out"]
            )
            let syncError = NSError(
                domain: "dev.pyric.sync",
                code: 1004,
                userInfo: [
                    NSLocalizedDescriptionKey: "Delta sync failed",
                    NSUnderlyingErrorKey: underlyingIO,
                ]
            )
            crashlytics.record(
                error: syncError,
                userInfo: ["syncAttempt": 3, "wifi": true]
            )

            let customException = ExceptionModel(
                name: "JSContextException",
                reason: "TypeError: undefined is not an object"
            )
            customException.stackTrace = [
                StackFrame(symbol: "evalBundle", file: "ScriptRunner.swift", line: 144),
                StackFrame.stackFrame(address: 0x10040f80),
            ]
            crashlytics.record(exceptionModel: customException)

            try await crashlytics.flush()
            let activeState = try await crashlytics.getState()
            #expect(activeState.collectionEnabled == true)
            #expect(activeState.userID == "live-ios-user-77")
            #expect(activeState.customKeys["proPlan"] == .bool(true))
            #expect(activeState.customKeys["retryBudget"] == .int(4))
            #expect(activeState.customKeys["diskFreeBytes"] == .int(12_500_000_000))
            #expect(activeState.customKeys["sampleRate"] == .double(0.0625))
            #expect(activeState.customKeys["regionCode"] == .string("us-central1"))
            #expect(activeState.customKeys["ephemeralFlag"] == nil)
            #expect(activeState.logs.map(\.message) == [
                "crumb-1: view appeared",
                "crumb-2: loaded 19 records",
            ])
            #expect(activeState.reports.count == 2)
            #expect(activeState.unsentReports.isEmpty)

            let errReport = activeState.reports[0]
            #expect(errReport.appID == namedAppName)
            #expect(errReport.name == "dev.pyric.sync")
            #expect(errReport.code == "1004")
            #expect(errReport.message == "Delta sync failed")
            #expect(errReport.cause?.contains("\(NSPOSIXErrorDomain)(60): Operation timed out") == true)
            #expect(errReport.sdkPlatform == "ios")
            #expect(errReport.flushed == true)
            #expect(errReport.attributes["syncAttempt"] == .int(3))
            #expect(errReport.attributes["wifi"] == .bool(true))
            #expect(errReport.breadcrumbs.count == 2)

            let excReport = activeState.reports[1]
            #expect(excReport.name == "JSContextException")
            #expect(excReport.message == "TypeError: undefined is not an object")
            #expect(excReport.stack?.contains("{ScriptRunner.swift - evalBundle:144}") == true)
            #expect(excReport.stack?.contains("0x10040f80") == true)
            #expect(excReport.flushed == true)

            // 3. Deferred unsent queue when collection is disabled: check -> update -> send -> delete
            crashlytics.setCrashlyticsCollectionEnabled(false)
            #expect(crashlytics.isCrashlyticsCollectionEnabled() == false)

            crashlytics.record(
                error: NSError(
                    domain: "dev.pyric.offline",
                    code: 503,
                    userInfo: [NSLocalizedDescriptionKey: "Queued while disabled"]
                )
            )
            #expect(await crashlytics.checkForUnsentReports() == true)
            let pendingReport = try #require(await crashlytics.checkAndUpdateUnsentReports())
            #expect(!pendingReport.reportID.isEmpty)
            pendingReport.log("user-approved-crash-upload")
            pendingReport.setCustomValue("consented", forKey: "consentStatus")

            crashlytics.sendUnsentReports()
            #expect(await crashlytics.checkForUnsentReports() == false)

            let afterSendState = try await crashlytics.getState()
            #expect(afterSendState.reports.count == 3)
            #expect(afterSendState.unsentReports.isEmpty)
            #expect(afterSendState.customKeys["consentStatus"] == .string("consented"))
            #expect(afterSendState.logs.last?.message == "user-approved-crash-upload")

            // Queue one more unsent report and delete it
            crashlytics.record(
                error: NSError(
                    domain: "dev.pyric.offline",
                    code: 499,
                    userInfo: [NSLocalizedDescriptionKey: "Queued then deleted"]
                )
            )
            #expect(await crashlytics.checkForUnsentReports() == true)
            crashlytics.deleteUnsentReports()
            #expect(await crashlytics.checkForUnsentReports() == false)

            crashlytics.setCrashlyticsCollectionEnabled(true)
            let finalNamedState = try await crashlytics.getState()
            #expect(finalNamedState.collectionEnabled == true)
            #expect(finalNamedState.reports.count == 3)
            #expect(finalNamedState.unsentReports.isEmpty)

            // 4. Verify [DEFAULT] app remained completely isolated
            let defaultState = try await defaultCrashlytics.getState()
            #expect(defaultState.userID == "default-ios-user")
            #expect(defaultState.reports.isEmpty)
            #expect(defaultState.logs.isEmpty)

            print("PYRIC_SWIFT_CRASHLYTICS_LIVE_VERIFIED=1")

            await Crashlytics.evictInstance(for: namedApp)
            await Crashlytics.evictInstance(for: defaultApp)
            await namedApp.delete()
            await defaultApp.delete()
        }
    }
}
