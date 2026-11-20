import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth
import PyricDatabase
#if canImport(Combine)
import Combine
#endif

@Suite("auth-swift Live-Host Conformance Suite (Rows 1-58)", .serialized)
struct AuthLiveHostConformanceTests {

    @Test("FirebaseOptions, FirebaseApp configuration, and bridge URL precedence")
    func firebaseOptionsAndAppConfiguration() async {
        let senderOptions = FirebaseOptions(googleAppID: "1:42:ios:sender", gcmSenderID: "42")
        #expect(senderOptions.googleAppID == "1:42:ios:sender")
        #expect(senderOptions.gcmSenderID == "42")
        #expect(senderOptions.projectID == nil)

        let fullOptions = FirebaseOptions(
            projectID: "demo-swift-live",
            databaseURL: "https://demo-swift-live-default-rtdb.firebaseio.com",
            apiKey: "swift-api-key",
            googleAppID: "1:99:ios:full"
        )
        #expect(fullOptions.projectID == "demo-swift-live")
        #expect(fullOptions.databaseURL == "https://demo-swift-live-default-rtdb.firebaseio.com")
        #expect(fullOptions.apiKey == "swift-api-key")
        #expect(fullOptions.googleAppID == "1:99:ios:full")

        let envBridge = FirebaseBridgeEndpointResolver.resolveDefault(environment: [
            "PYRIC_BRIDGE_URL": "http://127.0.0.1:6101",
            "PYRIC_LIVE_BRIDGE_URL": "ws://127.0.0.1:6102/__pyric/sandbox",
        ])
        #expect(envBridge.endpoint.absoluteString == "ws://127.0.0.1:6101/__pyric/sandbox")
        #expect(envBridge.hostHeader == "127.0.0.1:6101")

        let envLiveFallback = FirebaseBridgeEndpointResolver.resolveDefault(environment: [
            "PYRIC_LIVE_BRIDGE_URL": "ws://127.0.0.1:6102/__pyric/sandbox",
        ])
        #expect(envLiveFallback.endpoint.absoluteString == "ws://127.0.0.1:6102/__pyric/sandbox")

        let appName = "unit-cfg-\(UUID().uuidString)"
        FirebaseApp.configure(name: appName, options: fullOptions)
        let configured = FirebaseApp.app(name: appName)
        #expect(configured != nil)
        #expect(configured?.options == fullOptions)
        #expect(FirebaseApp.allApps?[appName] === configured)
        if let configured {
            await configured.delete()
        }
        #expect(FirebaseApp.app(name: appName) == nil)
    }

    @Test("auth-swift#1..5: Auth instance lifecycle, FirebaseApp binding, reset, and useEmulator over live host")
    func authInstanceLifecycleAndEmulatorConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        defer {
            Auth.reset()
            Firestore.reset()
            Database.reset()
            FirebaseApp.resetAppsForTesting()
        }

        // auth-swift#1 & auth-swift#4: Default FirebaseApp.configure(options:) + Auth.auth() + Auth.app
        let defaultOptions = FirebaseOptions(
            projectID: "demo-swift-live",
            databaseURL: "https://demo-swift-live-default-rtdb.firebaseio.com",
            apiKey: "swift-default-key",
            googleAppID: "1:101:ios:default"
        )
        FirebaseApp.configure(options: defaultOptions)
        let defaultApp = FirebaseApp.app()
        let defaultAuth = Auth.auth()
        #expect(defaultAuth === Auth.auth())
        #expect(defaultAuth.app === defaultApp)
        #expect(defaultAuth.app.name == "[DEFAULT]")
        #expect(defaultAuth.app.options.projectID == "demo-swift-live")

        // auth-swift#5: Auth.useEmulator(withHost:port:) reconfigures shared app bridge from an unreachable port
        let wrongPortApp = FirebaseApp(
            name: "swift-emu-\(UUID().uuidString)",
            options: defaultOptions,
            environment: ["PYRIC_BRIDGE_URL": "ws://127.0.0.1:1/__pyric/sandbox"]
        )
        let emuAuth = Auth.auth(app: wrongPortApp)
        let emuFirestore = Firestore.firestore(app: wrongPortApp)
        #expect(await emuAuth.bridgeClient.endpoint.port == 1)
        #expect(await emuFirestore.bridgeClient.endpoint.port == 1)

        emuAuth.useEmulator(withHost: host, port: port)
        #expect(await emuAuth.bridgeClient.endpoint.host == host)
        #expect(await emuAuth.bridgeClient.endpoint.port == port)
        #expect(await emuFirestore.bridgeClient.endpoint.port == port)

        let emuAnon = try await emuAuth.signInAnonymously()
        #expect(emuAnon.user.isAnonymous == true)
        #expect(emuAuth.currentUser?.uid == emuAnon.user.uid)

        // auth-swift#2: Auth.auth(app:) isolates per-app sessions across independent WebSocket connections
        defaultAuth.useEmulator(withHost: host, port: port)
        let secondaryName = "swift-secondary-\(UUID().uuidString)"
        FirebaseApp.configure(
            name: secondaryName,
            options: FirebaseOptions(projectID: "demo-swift-live", googleAppID: "1:102:ios:secondary")
        )
        let secondaryApp = try #require(FirebaseApp.app(name: secondaryName))
        let secondaryAuth = Auth.auth(app: secondaryApp)
        secondaryAuth.useEmulator(withHost: host, port: port)

        #expect(secondaryAuth !== defaultAuth)
        #expect(secondaryAuth.app === secondaryApp)
        #expect(defaultAuth.currentUser == nil)
        #expect(secondaryAuth.currentUser == nil)

        let defaultAnon = try await defaultAuth.signInAnonymously()
        #expect(defaultAuth.currentUser?.uid == defaultAnon.user.uid)
        #expect(secondaryAuth.currentUser == nil)

        // auth-swift#3: Auth.reset() clears cached Auth instances
        await wrongPortApp.disconnectSharedBridge()
        await defaultApp.disconnectSharedBridge()
        await secondaryApp.disconnectSharedBridge()
        Auth.reset()
        let postResetAuth = Auth.auth(app: secondaryApp)
        #expect(postResetAuth !== secondaryAuth)
        await secondaryApp.disconnectSharedBridge()
    }

    @Test("auth-swift#6..13: createUser, signIn, signInAnonymously, signOut, restoreSession, customToken, and getIDTokenForcingRefresh")
    func authOperationsAndCustomTokenConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "auth-ops", host: host, port: port)
        let auth = Auth.auth(app: app)
        let firestore = Firestore.firestore(app: app)
        let shard01 = Database.database(app: app, url: "https://shard-01.firebaseio.com")

        let tag = UUID().uuidString.lowercased()
        let email1 = "pilot-\(tag)@example.test"
        let pass1 = "CorrectHorse!1"

        // auth-swift#8: createUser(withEmail:password:) async
        let created1 = try await auth.createUser(withEmail: email1, password: pass1)
        let uid1 = created1.user.uid
        #expect(!uid1.isEmpty)
        #expect(created1.user.email == email1)
        #expect(created1.additionalUserInfo?.isNewUser == true)
        #expect(auth.currentUser?.uid == uid1)

        // Duplicate email rejected with .emailAlreadyInUse
        let dupError = await expectAuthError {
            _ = try await auth.createUser(withEmail: email1, password: pass1)
        }
        #expect(dupError?.code == .emailAlreadyInUse)

        // auth-swift#9: createUser(withEmail:password:completion:) callback
        let email2 = "copilot-\(tag)@example.test"
        let created2 = try await awaitCompletion { done in
            auth.createUser(withEmail: email2, password: pass1, completion: done)
        }
        #expect(!created2.user.uid.isEmpty)
        #expect(created2.user.uid != uid1)
        #expect(created2.additionalUserInfo?.isNewUser == true)
        #expect(auth.currentUser?.uid == created2.user.uid)

        // auth-swift#12: signOut() clears currentUser, resets lens, and revokes auth-gated Firestore access
        try auth.signOut()
        #expect(auth.currentUser == nil)
        #expect(auth.currentAuthLens() == .anon)
        await expectBridgeDenied {
            try await firestore.document("users/\(uid1)").setData(["status": "denied"])
        }

        // auth-swift#6: signIn(withEmail:password:) async
        let signedIn1 = try await auth.signIn(withEmail: email1, password: pass1)
        #expect(signedIn1.user.uid == uid1)
        #expect(signedIn1.additionalUserInfo?.isNewUser == false)
        #expect(auth.currentUser?.uid == uid1)
        try await firestore.document("users/\(uid1)").setData(["role": "captain"])
        let userDoc = try await firestore.document("users/\(uid1)").getDocument()
        #expect(userDoc.exists == true)
        #expect(userDoc.data()?["role"] as? String == "captain")

        let wrongPwError = await expectAuthError {
            _ = try await auth.signIn(withEmail: email1, password: "wrong-password")
        }
        #expect(wrongPwError?.code == .invalidCredential)

        // auth-swift#7: signIn(withEmail:password:completion:) callback
        try auth.signOut()
        let signedInCb = try await awaitCompletion { done in
            auth.signIn(withEmail: email1, password: pass1, completion: done)
        }
        #expect(signedInCb.user.uid == uid1)
        #expect(auth.currentUser?.uid == uid1)

        // auth-swift#10 & auth-swift#11: signInAnonymously() async and completion
        try auth.signOut()
        let anonAsync = try await auth.signInAnonymously()
        #expect(anonAsync.user.isAnonymous == true)
        #expect(anonAsync.user.email == nil)
        #expect(auth.currentUser?.uid == anonAsync.user.uid)

        try auth.signOut()
        let anonCb = try await awaitCompletion { done in
            auth.signInAnonymously(completion: done)
        }
        #expect(anonCb.user.isAnonymous == true)
        #expect(anonCb.user.uid != anonAsync.user.uid)

        // auth-swift#13: restoreSession(uid:) re-hydrates existing account and returns nil for unknown uid
        try auth.signOut()
        #expect(auth.currentUser == nil)
        let restored = try await auth.restoreSession(uid: uid1)
        #expect(restored?.uid == uid1)
        #expect(restored?.email == email1)
        #expect(auth.currentUser?.uid == uid1)

        let missingRestored = try await auth.restoreSession(uid: "missing-\(tag)")
        #expect(missingRestored == nil)
        #expect(auth.currentUser == nil)

        // Milestone 1 parity: signIn(withCustomToken:) async + completion & getIDTokenForcingRefresh overloads
        if let validCustomToken = ProcessInfo.processInfo.environment["PYRIC_LIVE_CUSTOM_TOKEN_VALID"],
           !validCustomToken.isEmpty {
            let customAsync = try await auth.signIn(withCustomToken: validCustomToken)
            #expect(customAsync.user.uid == "swift-custom-uid-01")
            #expect(auth.currentUser?.uid == "swift-custom-uid-01")

            // Full-lifecycle propagation (AGENTS.md Boundary #1): custom claims & rules work immediately after signIn
            #expect(customAsync.user.claims["role"]?.stringValue == "ops")
            #expect(customAsync.user.claims["tier"]?.stringValue == "enterprise")
            try await firestore.document("role_items/ops/items/item-1").setData(["active": true])
            let opsDoc = try await firestore.document("role_items/ops/items/item-1").getDocument()
            #expect(opsDoc.exists == true)
            await expectBridgeDenied {
                try await firestore.document("role_items/finance/items/item-1").setData(["active": true])
            }

            try await shard01.reference(withPath: "ops/deploy-\(tag)").setValue(["state": "ready"] as [String: Any])
            let opsSnap = try await shard01.reference(withPath: "ops/deploy-\(tag)").getData()
            #expect((opsSnap.value as? [String: Any])?["state"] as? String == "ready")

            let tokenCached = try await customAsync.user.getIDTokenForcingRefresh(false)
            #expect(tokenCached.split(separator: ".").count == 3)

            let tokenRefreshed = try await awaitTokenCompletion { done in
                customAsync.user.getIDTokenForcingRefresh(true, completion: done)
            }
            #expect(tokenRefreshed.split(separator: ".").count == 3)

            let tokenResult = try await customAsync.user.getIDTokenResult()
            #expect(tokenResult.claims["role"]?.stringValue == "ops")
            #expect(tokenResult.claims["tier"]?.stringValue == "enterprise")

            try auth.signOut()
            let customCb = try await awaitCompletion { done in
                auth.signIn(withCustomToken: validCustomToken, completion: done)
            }
            #expect(customCb.user.uid == "swift-custom-uid-01")
            #expect(customCb.user.claims["role"]?.stringValue == "ops")
        }

        if let mismatchToken = ProcessInfo.processInfo.environment["PYRIC_LIVE_CUSTOM_TOKEN_MISMATCH"],
           !mismatchToken.isEmpty {
            let mismatchErr = await expectAuthError {
                _ = try await auth.signIn(withCustomToken: mismatchToken)
            }
            #expect(mismatchErr?.code == .customTokenMismatch)
        }

        let invalidCustomErr = await expectAuthError {
            _ = try await auth.signIn(withCustomToken: "not-a-jwt-custom-token")
        }
        #expect(invalidCustomErr?.code == .invalidCustomToken)

        await app.disconnectSharedBridge()
    }

    @Test("auth-swift#14..24: currentUser, state/token listeners, AsyncStreams, AsyncSequences, and Combine publishers")
    func authStateListenersStreamsSequencesAndPublishersConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "auth-streams", host: host, port: port)
        let auth = Auth.auth(app: app)

        // auth-swift#14: initial currentUser is nil
        #expect(auth.currentUser == nil)

        // auth-swift#15..18: state & ID token listeners + removal handles
        let stateEvents = LockedRecorder<String?>()
        let removedStateEvents = LockedRecorder<String?>()
        let tokenEvents = LockedRecorder<String?>()
        let removedTokenEvents = LockedRecorder<String?>()

        let stateHandle = auth.addStateDidChangeListener { _, user in
            stateEvents.append(user?.uid)
        }
        let removedStateHandle = auth.addStateDidChangeListener { _, user in
            removedStateEvents.append(user?.uid)
        }
        let tokenHandle = auth.addIDTokenDidChangeListener { _, user in
            tokenEvents.append(user?.uid)
        }
        let removedTokenHandle = auth.addIDTokenDidChangeListener { _, user in
            removedTokenEvents.append(user?.uid)
        }

        #expect(stateEvents.values == [nil])
        #expect(removedStateEvents.values == [nil])
        #expect(tokenEvents.values == [nil])
        #expect(removedTokenEvents.values == [nil])

        auth.removeStateDidChangeListener(removedStateHandle)
        auth.removeIDTokenDidChangeListener(removedTokenHandle)

        // auth-swift#19..22: AsyncStream and AsyncSequence iterators
        var stateStreamIter = auth.authStateDidChangeStream.makeAsyncIterator()
        var tokenStreamIter = auth.idTokenDidChangeStream.makeAsyncIterator()
        var stateSeqIter = auth.authStateChanges.makeAsyncIterator()
        var tokenSeqIter = auth.idTokenChanges.makeAsyncIterator()

        let initStateStream = await stateStreamIter.next()
        let initTokenStream = await tokenStreamIter.next()
        let initStateSeq = await stateSeqIter.next()
        let initTokenSeq = await tokenSeqIter.next()
        expectSignedOutSnapshot(initStateStream)
        expectSignedOutSnapshot(initTokenStream)
        expectSignedOutSnapshot(initStateSeq)
        expectSignedOutSnapshot(initTokenSeq)

        #if canImport(Combine)
        // auth-swift#23..24: Combine publishers on Apple platforms
        let combineStateEvents = LockedRecorder<String?>()
        let combineTokenEvents = LockedRecorder<String?>()
        let stateCancellable = auth.authStatePublisher.sink { user in
            combineStateEvents.append(user?.uid)
        }
        let tokenCancellable = auth.idTokenPublisher.sink { user in
            combineTokenEvents.append(user?.uid)
        }
        #expect(combineStateEvents.values == [nil])
        #expect(combineTokenEvents.values == [nil])
        #endif

        // Transition 1: live createUser signs in user
        let email = "observer-\(UUID().uuidString.lowercased())@example.test"
        let created = try await auth.createUser(withEmail: email, password: "ObserverPass!1")
        let uid = created.user.uid
        #expect(auth.currentUser?.uid == uid)

        #expect(stateEvents.values == [nil, uid])
        #expect(tokenEvents.values == [nil, uid])
        #expect(removedStateEvents.values == [nil])
        #expect(removedTokenEvents.values == [nil])

        #expect((await stateStreamIter.next())??.uid == uid)
        #expect((await tokenStreamIter.next())??.uid == uid)
        #expect((await stateSeqIter.next())??.uid == uid)
        #expect((await tokenSeqIter.next())??.uid == uid)

        #if canImport(Combine)
        #expect(combineStateEvents.values == [nil, uid])
        #expect(combineTokenEvents.values == [nil, uid])
        #endif

        // Transition 2: forced ID token refresh notifies token observers ONLY (uid unchanged)
        _ = try await created.user.getIDToken(forcingRefresh: true)
        #expect(stateEvents.values == [nil, uid])
        #expect(tokenEvents.values == [nil, uid, uid])
        #expect(removedTokenEvents.values == [nil])
        #expect((await tokenStreamIter.next())??.uid == uid)
        #expect((await tokenSeqIter.next())??.uid == uid)

        #if canImport(Combine)
        #expect(combineStateEvents.values == [nil, uid])
        #expect(combineTokenEvents.values == [nil, uid, uid])
        #endif

        // Transition 3: signOut emits nil across both state and token observers
        try auth.signOut()
        #expect(auth.currentUser == nil)
        #expect(stateEvents.values == [nil, uid, nil])
        #expect(tokenEvents.values == [nil, uid, uid, nil])
        #expect(removedStateEvents.values == [nil])
        #expect(removedTokenEvents.values == [nil])

        expectSignedOutSnapshot(await stateStreamIter.next())
        expectSignedOutSnapshot(await tokenStreamIter.next())
        expectSignedOutSnapshot(await stateSeqIter.next())
        expectSignedOutSnapshot(await tokenSeqIter.next())

        #if canImport(Combine)
        #expect(combineStateEvents.values == [nil, uid, nil])
        #expect(combineTokenEvents.values == [nil, uid, uid, nil])
        stateCancellable.cancel()
        tokenCancellable.cancel()
        #endif

        auth.removeStateDidChangeListener(stateHandle)
        auth.removeIDTokenDidChangeListener(tokenHandle)
        await app.disconnectSharedBridge()
    }

    @Test("auth-swift#25..35: User identity properties, providerData, multi-tenant isolation, and custom claims")
    func userIdentityPropertiesAndTenantIsolationConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "auth-identity", host: host, port: port)
        let auth = Auth.auth(app: app)

        let tag = UUID().uuidString.lowercased()
        let seededUid = "grace-\(tag)"
        let seededEmail = "grace-\(tag)@example.test"
        let seededPassword = "CompilerQueen!42"
        let seededPhoto = "https://example.test/avatars/grace.png"
        let suffixDigits = String((abs(tag.hashValue) % 9_000_000) + 1_000_000)
        let seededPhone = "+1555\(suffixDigits)"

        // Seed full account via host adminCreateUser so emailVerified, phoneNumber, displayName, photoUrl, and customClaims are live
        _ = try await auth.bridgeClient.op(
            method: "auth.adminCreateUser",
            params: [
                "request": .dictionary([
                    "uid": .string(seededUid),
                    "email": .string(seededEmail),
                    "password": .string(seededPassword),
                    "emailVerified": .bool(true),
                    "displayName": .string("Grace Hopper"),
                    "photoUrl": .string(seededPhoto),
                    "phoneNumber": .string(seededPhone),
                    "customClaims": .dictionary([
                        "department": .string("compilers"),
                        "clearance": .int(5),
                    ]),
                ]),
            ]
        )

        let signedIn = try await auth.signIn(withEmail: seededEmail, password: seededPassword)
        let richUser = signedIn.user

        // auth-swift#25..33 & #35 (claims enriched immediately on live sign-in without manual getIDTokenResult)
        #expect(richUser.uid == seededUid)
        #expect(richUser.email == seededEmail)
        #expect(richUser.displayName == "Grace Hopper")
        #expect(richUser.photoURL == URL(string: seededPhoto))
        #expect(richUser.phoneNumber == seededPhone)
        #expect(richUser.isAnonymous == false)
        #expect(richUser.isEmailVerified == true)
        #expect(richUser.providerID == "firebase")
        #expect(richUser.providerData.contains { info in
            info.providerID == "password" && info.email == seededEmail
        })
        #expect(richUser.claims["department"]?.stringValue == "compilers")
        #expect(richUser.claims["clearance"]?.doubleValue == 5.0)
        let tokenResult = try await richUser.getIDTokenResult()
        #expect(tokenResult.claims["department"]?.stringValue == "compilers")

        // Contrast unverified email account & anonymous account for isEmailVerified and isAnonymous
        try auth.signOut()
        let unverified = try await auth.createUser(
            withEmail: "unverified-\(tag)@example.test",
            password: seededPassword
        )
        #expect(unverified.user.isEmailVerified == false)
        #expect(unverified.user.isAnonymous == false)

        try auth.signOut()
        let anon = try await auth.signInAnonymously()
        #expect(anon.user.isAnonymous == true)
        #expect(anon.user.email == nil)

        // auth-swift#34: User.tenant & multi-tenant sign-in isolation on live host
        try auth.signOut()
        auth.tenantId = "tenant-alpha"
        let tenantEmail = "tenant-user-\(tag)@example.test"
        let tenantCreated = try await auth.createUser(withEmail: tenantEmail, password: seededPassword)
        #expect(tenantCreated.user.tenant == "tenant-alpha")
        #expect(tenantCreated.user.tenantId == "tenant-alpha")
        if case let .asUser(lensUid, lensTenant, _) = auth.currentAuthLens() {
            #expect(lensUid == tenantCreated.user.uid)
            #expect(lensTenant == "tenant-alpha")
        } else {
            Issue.record("Expected .asUser lens with tenant-alpha")
        }

        try auth.signOut()
        auth.tenantId = "tenant-beta"
        let crossTenantErr = await expectAuthError {
            _ = try await auth.signIn(withEmail: tenantEmail, password: seededPassword)
        }
        #expect(crossTenantErr?.code == .invalidCredential)

        auth.tenantId = "tenant-alpha"
        let tenantSignedIn = try await auth.signIn(withEmail: tenantEmail, password: seededPassword)
        #expect(tenantSignedIn.user.uid == tenantCreated.user.uid)
        #expect(tenantSignedIn.user.tenant == "tenant-alpha")

        await app.disconnectSharedBridge()
    }

    // -- Helpers --

    func liveHostEndpoint() throws -> (host: String, port: Int)? {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return nil
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)
        return (host, port)
    }

    func makeLiveApp(prefix: String, host: String, port: Int) -> FirebaseApp {
        let app = FirebaseApp(
            name: "swift-\(prefix)-\(UUID().uuidString)",
            options: FirebaseOptions(
                projectID: "demo-swift-live",
                databaseURL: "https://demo-swift-live-default-rtdb.firebaseio.com",
                apiKey: "swift-live-key",
                googleAppID: "1:500:ios:live"
            )
        )
        app.useEmulator(withHost: host, port: port)
        return app
    }

    func awaitCompletion(
        _ register: (@escaping @Sendable (AuthDataResult?, Error?) -> Void) -> Void
    ) async throws -> AuthDataResult {
        try await withCheckedThrowingContinuation { continuation in
            register { result, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let result {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(throwing: AuthError(code: .internalError, message: "Missing AuthDataResult"))
                }
            }
        }
    }

    func awaitTokenCompletion(
        _ register: (@escaping @Sendable (String?, Error?) -> Void) -> Void
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            register { token, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let token {
                    continuation.resume(returning: token)
                } else {
                    continuation.resume(throwing: AuthError(code: .internalError, message: "Missing token string"))
                }
            }
        }
    }

    func awaitTokenResultCompletion(
        _ register: (@escaping @Sendable (AuthTokenResult?, Error?) -> Void) -> Void
    ) async throws -> AuthTokenResult {
        try await withCheckedThrowingContinuation { continuation in
            register { result, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let result {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(throwing: AuthError(code: .internalError, message: "Missing AuthTokenResult"))
                }
            }
        }
    }

    func awaitVoidCompletion(
        _ register: (@escaping @Sendable (Error?) -> Void) -> Void
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            register { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    func expectAuthError(_ operation: () async throws -> Void) async -> AuthError? {
        do {
            try await operation()
            Issue.record("Expected AuthError, but operation succeeded")
            return nil
        } catch let authErr as AuthError {
            return authErr
        } catch {
            Issue.record("Expected AuthError, got: \(error)")
            return nil
        }
    }

    func expectSignedOutSnapshot(_ snapshot: User??) {
        #expect(snapshot != nil && snapshot! == nil)
    }

    func expectBridgeDenied(_ operation: () async throws -> Void) async {
        do {
            try await operation()
            Issue.record("Expected permission-denied error, but operation succeeded")
        } catch let bridgeError as PyricBridgeError {
            let isDenied = bridgeError.code == .permissionDenied
                || bridgeError.rawCode == "PERMISSION_DENIED"
                || bridgeError.rawCode == "permission-denied"
            #expect(isDenied, "Unexpected bridge error code: \(bridgeError.rawCode)")
        } catch {
            Issue.record("Expected PyricBridgeError permission-denied, got: \(error)")
        }
    }
}

final class LockedRecorder<Element: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Element] = []

    var values: [Element] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    func append(_ element: Element) {
        lock.lock()
        items.append(element)
        lock.unlock()
    }
}
