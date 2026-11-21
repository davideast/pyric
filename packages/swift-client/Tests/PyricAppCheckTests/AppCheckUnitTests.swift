import Foundation
import Testing
@testable import PyricAppCheck
import PyricFirestore

private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ initial: Date) {
        self.current = initial
    }

    func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func advance(seconds: TimeInterval) {
        lock.lock()
        current = current.addingTimeInterval(seconds)
        lock.unlock()
    }
}

private final class AtomicCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int = 0

    @discardableResult
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }

    func get() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private final class ObservedTokens: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(token: String, appName: String)] = []

    func append(token: String, appName: String) {
        lock.lock()
        items.append((token: token, appName: appName))
        lock.unlock()
    }

    func snapshot() -> [(token: String, appName: String)] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

// Intentionally omits `Sendable` and `@Sendable` on `completion` to verify
// source compatibility with upstream `firebase-ios-sdk` `AppCheckProvider` conformers.
private final class UpstreamStyleCustomProvider: NSObject, AppCheckProvider {
    private let counter: AtomicCounter
    private let clock: MutableClock

    init(counter: AtomicCounter, clock: MutableClock) {
        self.counter = counter
        self.clock = clock
    }

    func getToken(completion handler: @escaping (AppCheckToken?, Error?) -> Void) {
        let seq = counter.increment()
        let token = AppCheckToken(
            token: "custom-jwt-\(seq)",
            expirationDate: clock.now().addingTimeInterval(60.0)
        )
        handler(token, nil)
    }
}

private final class UpstreamStyleCustomFactory: NSObject, AppCheckProviderFactory {
    private let counter: AtomicCounter
    private let clock: MutableClock

    init(counter: AtomicCounter, clock: MutableClock) {
        self.counter = counter
        self.clock = clock
    }

    func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
        _ = app
        return UpstreamStyleCustomProvider(counter: counter, clock: clock)
    }
}

@Suite("PyricAppCheck Unit Suite", .serialized)
struct AppCheckUnitTests {

    private func resetAll() {
        AppCheck.reset()
        FirebaseApp.resetAppsForTesting()
    }

    @Test("Singleton identity, per-app scoping, and nil factory handling match FirebaseAppCheck")
    func singletonIdentityAndAppScoping() throws {
        resetAll()
        defer { resetAll() }

        AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
        FirebaseApp.configure(
            options: FirebaseOptions(
                projectID: "demo-appcheck-unit",
                googleAppID: "1:111111111111:ios:defaultapp"
            )
        )

        let defaultCheck = AppCheck.appCheck()
        let viaExplicitDefault = try #require(AppCheck.appCheck(app: FirebaseApp.app()))
        #expect(defaultCheck === viaExplicitDefault)

        let secondaryOptions = FirebaseOptions(
            projectID: "demo-appcheck-unit",
            googleAppID: "1:111111111111:ios:secondaryapp"
        )
        FirebaseApp.configure(name: "secondary-ios", options: secondaryOptions)
        let secondaryApp = try #require(FirebaseApp.app(name: "secondary-ios"))
        let secondaryCheck = try #require(AppCheck.appCheck(app: secondaryApp))
        #expect(secondaryCheck !== defaultCheck)
        #expect(secondaryCheck.app === secondaryApp)

        // Setting provider factory to nil causes appCheck(app:) for uninstantiated apps to return nil.
        AppCheck.setAppCheckProviderFactory(nil)
        FirebaseApp.configure(
            name: "unconfigured-provider-app",
            options: FirebaseOptions(
                projectID: "demo-appcheck-unit",
                googleAppID: "1:111111111111:ios:thirdapp"
            )
        )
        let thirdApp = try #require(FirebaseApp.app(name: "unconfigured-provider-app"))
        #expect(AppCheck.appCheck(app: thirdApp) == nil)
    }

    @Test("Debug, AppAttest, and DeviceCheck providers validate googleAppID and resolve debug tokens")
    func builtInProvidersAndDebugTokenPriority() throws {
        resetAll()
        defer { resetAll() }

        let emptyIdApp = FirebaseApp(
            name: "empty-id",
            options: FirebaseOptions(projectID: "demo", googleAppID: "   ")
        )
        #expect(AppCheckDebugProvider(app: emptyIdApp) == nil)
        #expect(AppAttestProvider(app: emptyIdApp) == nil)
        #expect(DeviceCheckProvider(app: emptyIdApp) == nil)

        let validApp = FirebaseApp(
            name: "debug-token-app",
            options: FirebaseOptions(
                projectID: "demo",
                googleAppID: "1:222222222222:ios:debugapp"
            )
        )
        let generatedOnly = try #require(AppCheckDebugProvider(app: validApp, environment: [:]))
        let local1 = generatedOnly.localDebugToken()
        let local2 = generatedOnly.localDebugToken()
        #expect(!local1.isEmpty)
        #expect(local1 == local2)
        #expect(generatedOnly.currentDebugToken() == local1)

        let withLegacyEnv = try #require(
            AppCheckDebugProvider(
                app: validApp,
                environment: ["FIRAAppCheckDebugToken": "legacy-env-secret"]
            )
        )
        #expect(withLegacyEnv.currentDebugToken() == "legacy-env-secret")

        let withPrimaryEnv = try #require(
            AppCheckDebugProvider(
                app: validApp,
                environment: [
                    "AppCheckDebugToken": "primary-env-secret",
                    "FIRAAppCheckDebugToken": "legacy-env-secret"
                ]
            )
        )
        #expect(withPrimaryEnv.currentDebugToken() == "primary-env-secret")
    }

    @Test("Custom provider caches valid tokens, coalesces concurrent mints, supports forceRefresh, expiry, limitedUseToken, and notifications")
    func cachingForceRefreshExpiryLimitedUseAndNotifications() async throws {
        resetAll()
        defer { resetAll() }

        let clock = MutableClock(Date(timeIntervalSince1970: 1_700_000_000))
        let calls = AtomicCounter()
        let center = NotificationCenter()
        let observed = ObservedTokens()

        let app = FirebaseApp(
            name: "custom-cache-app",
            options: FirebaseOptions(
                projectID: "demo-appcheck-unit",
                googleAppID: "1:333333333333:ios:customapp"
            )
        )
        let appCheck = AppCheck.createForTesting(
            app: app,
            providerFactory: UpstreamStyleCustomFactory(counter: calls, clock: clock),
            notificationCenter: center,
            isTokenAutoRefreshEnabled: false,
            clockNow: { clock.now() }
        )
        #expect(appCheck.isTokenAutoRefreshEnabled == false)

        let observer = center.addObserver(
            forName: .AppCheckTokenDidChange,
            object: appCheck,
            queue: nil
        ) { notification in
            let token = notification.userInfo?[AppCheckTokenNotificationKey] as? String ?? ""
            let appName = notification.userInfo?[AppCheckAppNameNotificationKey] as? String ?? ""
            observed.append(token: token, appName: appName)
        }
        defer { center.removeObserver(observer) }

        // Concurrent non-forced calls coalesce onto a single provider invocation.
        async let concurrentA = appCheck.token(forcingRefresh: false)
        async let concurrentB = appCheck.token(forcingRefresh: false)
        let (firstA, firstB) = try await (concurrentA, concurrentB)
        #expect(firstA.token == "custom-jwt-1")
        #expect(firstB.token == "custom-jwt-1")
        #expect(calls.get() == 1)
        #expect(observed.snapshot().map(\.token) == ["custom-jwt-1"])
        #expect(observed.snapshot().map(\.appName) == ["custom-cache-app"])

        // Cached hit does not call provider or post another notification.
        let cached = try await appCheck.token(forcingRefresh: false)
        #expect(cached == firstA)
        #expect(calls.get() == 1)
        #expect(observed.snapshot().count == 1)

        // Completion-handler overload returns the cached token when forcingRefresh is false.
        let completionToken = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<AppCheckToken, Error>) in
            appCheck.token(forcingRefresh: false) { token, error in
                if let error {
                    cont.resume(throwing: error)
                } else if let token {
                    cont.resume(returning: token)
                }
            }
        }
        #expect(completionToken.token == "custom-jwt-1")
        #expect(calls.get() == 1)

        // forcingRefresh: true mints a new token and posts Notification.Name.AppCheckTokenDidChange.
        let forced = try await appCheck.token(forcingRefresh: true)
        #expect(forced.token == "custom-jwt-2")
        #expect(calls.get() == 2)
        #expect(observed.snapshot().map(\.token) == ["custom-jwt-1", "custom-jwt-2"])

        // Advancing clock past expiration causes forcingRefresh: false to mint again.
        clock.advance(seconds: 61.0)
        let afterExpiry = try await appCheck.token(forcingRefresh: false)
        #expect(afterExpiry.token == "custom-jwt-3")
        #expect(calls.get() == 3)

        // limitedUseToken falls back to getToken on custom providers without mutating cached session token or posting notifications.
        let limited = try await appCheck.limitedUseToken()
        #expect(limited.token == "custom-jwt-4")
        #expect(calls.get() == 4)
        let stillCached = try await appCheck.token(forcingRefresh: false)
        #expect(stillCached.token == "custom-jwt-3")
        #expect(calls.get() == 4)
        #expect(observed.snapshot().map(\.token) == ["custom-jwt-1", "custom-jwt-2", "custom-jwt-3"])
    }

    @Test("Auto-refresh schedules background renewal when enabled and cancels when disabled")
    func autoRefreshRenewsExpiringToken() async throws {
        resetAll()
        defer { resetAll() }

        let calls = AtomicCounter()
        let center = NotificationCenter()
        let observed = ObservedTokens()

        final class ShortLivedProvider: NSObject, AppCheckProvider, @unchecked Sendable {
            let calls: AtomicCounter
            init(calls: AtomicCounter) { self.calls = calls }
            func getToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
                let seq = calls.increment()
                let ttl: TimeInterval = seq == 1 ? 0.12 : 3600.0
                handler(
                    AppCheckToken(
                        token: "autorefresh-jwt-\(seq)",
                        expirationDate: Date().addingTimeInterval(ttl)
                    ),
                    nil
                )
            }
        }

        final class ShortLivedFactory: NSObject, AppCheckProviderFactory, @unchecked Sendable {
            let calls: AtomicCounter
            init(calls: AtomicCounter) { self.calls = calls }
            func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
                _ = app
                return ShortLivedProvider(calls: calls)
            }
        }

        let app = FirebaseApp(
            name: "autorefresh-ios-app",
            options: FirebaseOptions(
                projectID: "demo-appcheck-unit",
                googleAppID: "1:444444444444:ios:autorefresh"
            )
        )
        let appCheck = AppCheck.createForTesting(
            app: app,
            providerFactory: ShortLivedFactory(calls: calls),
            notificationCenter: center,
            isTokenAutoRefreshEnabled: true
        )
        let observer = center.addObserver(
            forName: AppCheckTokenDidChangeNotification,
            object: appCheck,
            queue: nil
        ) { notification in
            let token = notification.userInfo?[AppCheckTokenNotificationKey] as? String ?? ""
            let appName = notification.userInfo?[AppCheckAppNameNotificationKey] as? String ?? ""
            observed.append(token: token, appName: appName)
        }
        defer { center.removeObserver(observer) }

        let initial = try await appCheck.token(forcingRefresh: false)
        #expect(initial.token == "autorefresh-jwt-1")

        // Wait up to 2s for background auto-refresh to renew into autorefresh-jwt-2.
        let deadline = Date().addingTimeInterval(2.0)
        while observed.snapshot().count < 2 && Date() < deadline {
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(observed.snapshot().map(\.token) == ["autorefresh-jwt-1", "autorefresh-jwt-2"])
        let renewed = try await appCheck.token(forcingRefresh: false)
        #expect(renewed.token == "autorefresh-jwt-2")

        appCheck.isTokenAutoRefreshEnabled = false
        #expect(appCheck.isTokenAutoRefreshEnabled == false)
    }

    @Test("Bridge providers send appCheck.getToken, appCheck.getLimitedUseToken, attach opWithAppCheck, and map errors to AppCheckErrorCode")
    func bridgeWireOperationsAndErrorMapping() async throws {
        resetAll()
        defer { resetAll() }

        let mintCounter = AtomicCounter()
        let channel = MockAppCheckBridgeChannel { frame, transport in
            let type = frame["type"]?.stringValue
            if type == "attach" {
                transport.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "clientSessionId": "swift-appcheck-mock"
                ])
                return
            }
            guard type == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue,
                  let method = op["method"]?.stringValue else {
                return
            }
            switch method {
            case "appCheck.getToken":
                let seq = mintCounter.increment()
                let provider = op["provider"]?.stringValue ?? "unknown"
                let expMs = Int64((Date().timeIntervalSince1970 * 1000.0).rounded()) + 3_600_000
                transport.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": [
                        "token": "bridge-\(provider)-jwt-\(seq)",
                        "expireTimeMillis": expMs
                    ]
                ])
            case "appCheck.getLimitedUseToken":
                let seq = mintCounter.increment()
                let expMs = Int64((Date().timeIntervalSince1970 * 1000.0).rounded()) + 300_000
                transport.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": [
                        "token": "bridge-limited-jwt-\(seq)",
                        "expireTimeMillis": expMs
                    ]
                ])
            case "ai.generateContent":
                transport.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": ["text": "ok"]
                ])
            default:
                transport.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": false,
                    "error": [
                        "code": "unavailable",
                        "message": "Simulated bridge outage"
                    ]
                ])
            }
        }

        let bridge = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(
            name: "bridge-wire-app",
            options: FirebaseOptions(
                projectID: "demo-swift-wire",
                googleAppID: "1:555555555555:ios:wireapp"
            )
        )

        AppCheck.setAppCheckProviderFactory(AppAttestProviderFactory())
        let appCheck = AppCheck.appCheck(app: app, bridgeClient: bridge)

        let standard = try await appCheck.token(forcingRefresh: false)
        #expect(standard.token == "bridge-app-attest-jwt-1")

        let limited = try await appCheck.limitedUseToken()
        #expect(limited.token == "bridge-limited-jwt-2")

        let aiRes = try await bridge.opWithAppCheck(
            app: app,
            method: "ai.generateContent",
            params: ["model": .string("gemini-2.5-flash")]
        )
        #expect(aiRes["text"]?.stringValue == "ok")

        let ops = channel.recordedOps
        #expect(ops.count == 3)
        #expect(ops[0]["method"]?.stringValue == "appCheck.getToken")
        #expect(ops[0]["appId"]?.stringValue == "1:555555555555:ios:wireapp")
        #expect(ops[0]["projectId"]?.stringValue == "demo-swift-wire")
        #expect(ops[0]["provider"]?.stringValue == "app-attest")

        #expect(ops[1]["method"]?.stringValue == "appCheck.getLimitedUseToken")
        #expect(ops[1]["provider"]?.stringValue == "app-attest")

        #expect(ops[2]["method"]?.stringValue == "ai.generateContent")
        #expect(ops[2]["appCheckToken"]?.stringValue == "bridge-app-attest-jwt-1")

        // Verify AppCheckErrorCode pattern matching for unconfigured AppCheck and bridge unavailable errors.
        let unconfiguredApp = FirebaseApp(name: "no-provider-app", options: FirebaseOptions())
        let unconfiguredCheck = AppCheck.createForTesting(app: unconfiguredApp, providerFactory: nil)
        var matchedInvalidConfig = false
        do {
            _ = try await unconfiguredCheck.token(forcingRefresh: false)
        } catch AppCheckErrorCode.invalidConfiguration {
            matchedInvalidConfig = true
        }
        #expect(matchedInvalidConfig == true)

        let mappedUnavailable: Error = AppCheckError.from(PyricBridgeError.unavailable("offline"))
        let nsUnavailable = mappedUnavailable as NSError
        #expect(nsUnavailable.domain == AppCheckErrorDomain)
        #expect(nsUnavailable.code == AppCheckErrorCode.serverUnreachable.rawValue)

        await bridge.disconnect()
    }
}
