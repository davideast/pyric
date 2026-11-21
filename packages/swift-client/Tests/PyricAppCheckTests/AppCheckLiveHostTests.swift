import Foundation
import Testing
import PyricAppCheck
import PyricFirestore
import FirebaseAuth
import PyricDatabase

private final class LiveNotificationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String] = []

    func record(_ token: String) {
        lock.lock()
        tokens.append(token)
        lock.unlock()
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return tokens
    }
}

@Suite("PyricAppCheck Live-Host Suite", .serialized)
struct AppCheckLiveHostTests {
    private static let projectId = "demo-swift-appcheck"
    private static let primaryIosAppId = "1:424242424242:ios:swiftliveapp"
    private static let sharedServicesIosAppId = "1:424242424242:ios:sharedservices"

    private func decodeBase64UrlSegment(_ segment: String) throws -> [String: Any] {
        var padded = segment
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = padded.count % 4
        if remainder != 0 {
            padded += String(repeating: "=", count: 4 - remainder)
        }
        let data = try #require(Data(base64Encoded: padded))
        let json = try JSONSerialization.jsonObject(with: data)
        return try #require(json as? [String: Any])
    }

    private func decodeJwtHeader(_ jwt: String) throws -> [String: Any] {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        #expect(parts.count == 3)
        return try decodeBase64UrlSegment(parts[0])
    }

    private func decodeJwtPayload(_ jwt: String) throws -> [String: Any] {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        #expect(parts.count == 3)
        return try decodeBase64UrlSegment(parts[1])
    }

    @Test("Mints RS256 App Check JWTs with Debug, AppAttest, and DeviceCheck providers over live WebSocket")
    func mintsRealSandboxAppCheckJwtsOverLiveWebSocket() async throws {
        guard let rawBridgeUrl = ProcessInfo.processInfo.environment["PYRIC_LIVE_APPCHECK_BRIDGE_URL"],
              !rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let parsedUrl = try #require(URL(string: rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines)))
        let host = try #require(parsedUrl.host)
        let port = try #require(parsedUrl.port)

        AppCheck.reset()
        Auth.reset()
        Database.reset()
        Firestore.reset()
        FirebaseApp.resetAppsForTesting()
        defer {
            AppCheck.reset()
            Auth.reset()
            Database.reset()
            Firestore.reset()
            FirebaseApp.resetAppsForTesting()
        }

        AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
        let options = FirebaseOptions(
            projectID: Self.projectId,
            databaseURL: "https://\(Self.projectId)-default-rtdb.firebaseio.com",
            apiKey: "sandbox-api-key",
            googleAppID: Self.primaryIosAppId
        )
        FirebaseApp.configure(name: "live-swift-appcheck-primary", options: options)
        let app = try #require(FirebaseApp.app(name: "live-swift-appcheck-primary"))
        let bridge = app.useEmulator(withHost: host, port: port)

        let appCheck = try #require(AppCheck.appCheck(app: app))
        let recorder = LiveNotificationRecorder()
        let observer = NotificationCenter.default.addObserver(
            forName: .AppCheckTokenDidChange,
            object: appCheck,
            queue: nil
        ) { notification in
            if let jwt = notification.userInfo?[AppCheckTokenNotificationKey] as? String {
                recorder.record(jwt)
            }
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        appCheck.isTokenAutoRefreshEnabled = false
        #expect(appCheck.isTokenAutoRefreshEnabled == false)
        appCheck.isTokenAutoRefreshEnabled = true
        #expect(appCheck.isTokenAutoRefreshEnabled == true)

        let beforeMintMs = Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
        let firstToken = try await appCheck.token(forcingRefresh: false)
        #expect(!firstToken.token.isEmpty)
        #expect(firstToken.expireTimeMillis >= beforeMintMs + 3_300_000)
        #expect(firstToken.expireTimeMillis <= beforeMintMs + 3_900_000)

        let header1 = try decodeJwtHeader(firstToken.token)
        #expect(header1["alg"] as? String == "RS256")
        #expect(header1["typ"] as? String == "JWT")

        let claims1 = try decodeJwtPayload(firstToken.token)
        #expect(claims1["sub"] as? String == Self.primaryIosAppId)
        let aud1 = try #require(claims1["aud"] as? [String])
        #expect(aud1.contains("projects/424242424242"))
        #expect(aud1.contains("projects/\(Self.projectId)"))
        #expect(claims1["iss"] as? String == "https://firebaseappcheck.googleapis.com/424242424242")

        // Non-forced read returns the cached token without posting a second notification.
        let cachedToken = try await appCheck.token(forcingRefresh: false)
        #expect(cachedToken.token == firstToken.token)
        #expect(recorder.snapshot() == [firstToken.token])

        // Forced refresh mints a fresh RS256 JWT with distinct jti and posts AppCheckTokenDidChange.
        let refreshedToken = try await appCheck.token(forcingRefresh: true)
        #expect(refreshedToken.token != firstToken.token)
        let claims2 = try decodeJwtPayload(refreshedToken.token)
        #expect(claims2["jti"] as? String != claims1["jti"] as? String)
        #expect(recorder.snapshot() == [firstToken.token, refreshedToken.token])

        // Limited-use token has ~5-minute TTL and preserves the cached standard token.
        let beforeLimitedMs = Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
        let limitedToken = try await appCheck.limitedUseToken()
        #expect(limitedToken.token != refreshedToken.token)
        #expect(limitedToken.expireTimeMillis >= beforeLimitedMs + 240_000)
        #expect(limitedToken.expireTimeMillis <= beforeLimitedMs + 360_000)
        let stillCached = try await appCheck.token(forcingRefresh: false)
        #expect(stillCached.token == refreshedToken.token)
        #expect(recorder.snapshot() == [firstToken.token, refreshedToken.token])

        // Direct AppAttestProvider and DeviceCheckProvider mint RS256 tokens for the same app.
        let appAttest = try #require(AppAttestProvider(app: app))
        let attestToken = try await appAttest.getToken()
        #expect(try decodeJwtPayload(attestToken.token)["sub"] as? String == Self.primaryIosAppId)

        let deviceCheck = try #require(DeviceCheckProvider(app: app))
        let deviceToken = try await deviceCheck.getToken()
        #expect(try decodeJwtPayload(deviceToken.token)["sub"] as? String == Self.primaryIosAppId)

        // opWithAppCheck attaches the cached App Check JWT on AI requests to the hosted worker.
        let aiReply = try await bridge.opWithAppCheck(
            app: app,
            method: "ai.generateContent",
            params: [
                "model": .string("gemini-2.5-flash"),
                "request": .dictionary([
                    "contents": .array([
                        .dictionary([
                            "role": .string("user"),
                            "parts": .array([.dictionary(["text": .string("hello from swift")])])
                        ])
                    ])
                ])
            ]
        )
        #expect(aiReply != .null)

        await app.delete()
    }

    @Test("Shared FirebaseApp services and AppAttestProviderFactory interoperate over live WebSocket")
    func sharedFirebaseAppServicesInteroperateWithAppCheck() async throws {
        guard let rawBridgeUrl = ProcessInfo.processInfo.environment["PYRIC_LIVE_APPCHECK_BRIDGE_URL"],
              !rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let parsedUrl = try #require(URL(string: rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines)))
        let host = try #require(parsedUrl.host)
        let port = try #require(parsedUrl.port)

        AppCheck.reset()
        Auth.reset()
        Database.reset()
        Firestore.reset()
        FirebaseApp.resetAppsForTesting()
        defer {
            AppCheck.reset()
            Auth.reset()
            Database.reset()
            Firestore.reset()
            FirebaseApp.resetAppsForTesting()
        }

        AppCheck.setAppCheckProviderFactory(AppAttestProviderFactory())
        let options = FirebaseOptions(
            projectID: Self.projectId,
            databaseURL: "https://\(Self.projectId)-default-rtdb.firebaseio.com",
            apiKey: "sandbox-api-key",
            googleAppID: Self.sharedServicesIosAppId
        )
        FirebaseApp.configure(name: "live-swift-appcheck-shared", options: options)
        let app = try #require(FirebaseApp.app(name: "live-swift-appcheck-shared"))
        let bridge = app.useEmulator(withHost: host, port: port)

        let appCheck = try #require(AppCheck.appCheck(app: app))
        let minted = try await appCheck.token(forcingRefresh: false)
        #expect(try decodeJwtPayload(minted.token)["sub"] as? String == Self.sharedServicesIosAppId)

        let auth = Auth.auth(app: app)
        let firestore = Firestore.firestore(app: app)
        let database = Database.database(app: app)

        let authResult = try await auth.createUser(
            withEmail: "swift-member@example.com",
            password: "LiveSwiftAppCheck!123"
        )
        let uid = authResult.user.uid
        #expect(!uid.isEmpty)

        try await firestore.document("items/swift-item-1").setData([
            "ownerUid": uid,
            "title": "swift-verified-item"
        ])
        let snap = try await firestore.document("items/swift-item-1").getDocument()
        #expect(snap.exists == true)
        #expect(snap.data()?["title"] as? String == "swift-verified-item")

        try await database.reference(withPath: "users/\(uid)/profile").setValue([
            "displayName": "Swift AppCheck Member"
        ])
        let rtdbSnap = try await database.reference(withPath: "users/\(uid)/profile/displayName").getData()
        #expect(rtdbSnap.value as? String == "Swift AppCheck Member")

        // Attach the shared app's App Check JWT explicitly onto a gated AI call on the same connection.
        _ = try await bridge.opWithAppCheck(
            app: app,
            method: "ai.generateContent",
            params: [
                "model": .string("gemini-2.5-flash"),
                "request": .dictionary([
                    "contents": .array([
                        .dictionary([
                            "role": .string("user"),
                            "parts": .array([.dictionary(["text": .string("shared check")])])
                        ])
                    ])
                ])
            ]
        )

        await app.delete()
    }
}
