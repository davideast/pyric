import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

extension AuthLiveHostConformanceTests {

    @Test("auth-swift#36..41: User ID token retrieval, token result, profile updates, and live reload")
    func userTokensProfileAndReloadConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "auth-user-ops", host: host, port: port)
        let auth = Auth.auth(app: app)
        let peerApp = makeLiveApp(prefix: "auth-user-peer", host: host, port: port)
        let peerAuth = Auth.auth(app: peerApp)

        let tag = UUID().uuidString.lowercased()
        let email = "ada-\(tag)@example.test"
        let password = "AnalyticalEngine!42"

        let created = try await auth.createUser(withEmail: email, password: password)
        let user = created.user
        let uid = user.uid

        // auth-swift#36: User.getIDToken(forcingRefresh:) async
        let tokenInitial = try await user.getIDToken(forcingRefresh: false)
        let tokenCached = try await user.getIDToken(forcingRefresh: false)
        #expect(tokenInitial == tokenCached)
        let initialPayload = try decodeJwtPayload(tokenInitial)
        #expect(initialPayload["user_id"] as? String == uid)
        #expect(initialPayload["sub"] as? String == uid)

        // Out-of-band admin custom claims update becomes visible in raw JWT after forcingRefresh: true
        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(uid),
                "request": .dictionary([
                    "customClaims": .dictionary([
                        "tier": .string("gold"),
                        "quota": .int(250),
                    ]),
                ]),
            ]
        )

        let tokenRefreshed = try await user.getIDToken(forcingRefresh: true)
        #expect(tokenRefreshed != tokenInitial)
        let refreshedPayload = try decodeJwtPayload(tokenRefreshed)
        #expect(refreshedPayload["tier"] as? String == "gold")
        #expect((refreshedPayload["quota"] as? NSNumber)?.intValue == 250)

        // auth-swift#37: User.getIDToken(forcingRefresh:completion:) callback
        let cbCached = try await awaitTokenCompletion { done in
            user.getIDToken(forcingRefresh: false, completion: done)
        }
        #expect(cbCached == tokenRefreshed)

        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(uid),
                "request": .dictionary([
                    "customClaims": .dictionary([
                        "tier": .string("platinum"),
                        "quota": .int(500),
                    ]),
                ]),
            ]
        )
        let cbRefreshed = try await awaitTokenCompletion { done in
            user.getIDToken(forcingRefresh: true, completion: done)
        }
        let cbPayload = try decodeJwtPayload(cbRefreshed)
        #expect(cbPayload["tier"] as? String == "platinum")

        // auth-swift#38 & auth-swift#39: User.getIDTokenResult(forcingRefresh:) async and completion
        let resultAsync = try await user.getIDTokenResult(forcingRefresh: false)
        #expect(resultAsync.token == cbRefreshed)
        #expect(resultAsync.signInProvider == "password")
        #expect(resultAsync.claims["tier"]?.stringValue == "platinum")
        #expect(resultAsync.claims["quota"]?.doubleValue == 500.0)

        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(uid),
                "request": .dictionary([
                    "customClaims": .dictionary([
                        "tier": .string("diamond"),
                    ]),
                ]),
            ]
        )
        let resultCb = try await awaitTokenResultCompletion { done in
            user.getIDTokenResult(forcingRefresh: true, completion: done)
        }
        #expect(resultCb.claims["tier"]?.stringValue == "diamond")
        #expect(user.claims["tier"]?.stringValue == "diamond")

        // auth-swift#40: User.updateProfile(displayName:photoURL:) async + clearing fields + backend persistence
        let avatarURL = try #require(URL(string: "https://example.test/avatars/ada.png"))
        try await user.updateProfile(displayName: "Ada Byron", photoURL: avatarURL)
        #expect(user.displayName == "Ada Byron")
        #expect(user.photoURL == avatarURL)
        #expect(auth.currentUser?.displayName == "Ada Byron")

        let peerRestored = try await peerAuth.restoreSession(uid: uid)
        #expect(peerRestored?.displayName == "Ada Byron")
        #expect(peerRestored?.photoURL == avatarURL)

        // Clearing photoURL via nil persists null to the live host
        try await awaitVoidCompletion { done in
            user.updateProfile(displayName: "Ada Lovelace", photoURL: nil, completion: done)
        }
        #expect(user.displayName == "Ada Lovelace")
        #expect(user.photoURL == nil)

        try await peerRestored?.reload()
        #expect(peerRestored?.displayName == "Ada Lovelace")
        #expect(peerRestored?.photoURL == nil)

        // auth-swift#41: User.reload() refreshes server-side profile & verification state and signs out invalidated accounts
        #expect(user.isEmailVerified == false)
        let updatedAvatar = "https://example.test/avatars/countess.png"
        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(uid),
                "request": .dictionary([
                    "displayName": .string("Countess of Lovelace"),
                    "photoUrl": .string(updatedAvatar),
                    "emailVerified": .bool(true),
                ]),
            ]
        )
        #expect(user.displayName == "Ada Lovelace")
        #expect(user.isEmailVerified == false)

        try await user.reload()
        #expect(user.displayName == "Countess of Lovelace")
        #expect(user.photoURL == URL(string: updatedAvatar))
        #expect(user.isEmailVerified == true)

        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(uid),
                "request": .dictionary([
                    "displayName": .string("Augusta Ada King"),
                ]),
            ]
        )
        try await awaitVoidCompletion { done in
            user.reload(completion: done)
        }
        #expect(user.displayName == "Augusta Ada King")

        // Disabling the account causes reload() to throw .userDisabled and sign out currentUser
        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(uid),
                "request": .dictionary(["disabled": .bool(true)]),
            ]
        )
        let disabledErr = await expectAuthError {
            try await user.reload()
        }
        #expect(disabledErr?.code == .userDisabled)
        #expect(auth.currentUser == nil)

        // Deleting an active account out-of-band invalidates reload() and clears currentUser
        let ephemeral = try await auth.createUser(
            withEmail: "ephemeral-\(tag)@example.test",
            password: password
        )
        let ephemeralUid = ephemeral.user.uid
        #expect(auth.currentUser?.uid == ephemeralUid)
        _ = try await auth.bridgeClient.op(
            method: "auth.adminDeleteUser",
            params: ["uid": .string(ephemeralUid)]
        )
        let deletedErr = await expectAuthError {
            try await ephemeral.user.reload()
        }
        let isInvalidated = deletedErr?.code == .userTokenExpired || deletedErr?.code == .userNotFound
        #expect(isInvalidated == true)
        #expect(auth.currentUser == nil)

        await app.disconnectSharedBridge()
        await peerApp.disconnectSharedBridge()
    }

    @Test("auth-swift#42..47: AuthDataResult, AdditionalUserInfo, AuthTokenResult metadata, and UserInfoImpl")
    func supportingTypesAndMetadataConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "auth-metadata", host: host, port: port)
        let auth = Auth.auth(app: app)

        let tag = UUID().uuidString.lowercased()
        let email = "Katherine-\(tag)@example.test".lowercased()
        let password = "OrbitalMechanics!9"

        // auth-swift#42 & auth-swift#43: AuthDataResult.user and AuthDataResult.additionalUserInfo
        let signUpResult = try await auth.createUser(withEmail: email, password: password)
        #expect(signUpResult.user.email == email)
        #expect(signUpResult.additionalUserInfo?.isNewUser == true)

        try auth.signOut()
        let signInResult = try await auth.signIn(withEmail: email, password: password)
        #expect(signInResult.user.uid == signUpResult.user.uid)
        #expect(signInResult.additionalUserInfo?.isNewUser == false)

        let profilePhoto = try #require(URL(string: "https://example.test/avatars/katherine.png"))
        try await signInResult.user.updateProfile(displayName: "Katherine Johnson", photoURL: profilePhoto)

        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(signInResult.user.uid),
                "request": .dictionary([
                    "customClaims": .dictionary([
                        "division": .string("trajectory"),
                        "mission": .int(11),
                    ]),
                ]),
            ]
        )

        // auth-swift#44, auth-swift#45, auth-swift#46: AuthTokenResult.token, claims, and expirationDate
        let tokenResult = try await signInResult.user.getIDTokenResult(forcingRefresh: true)
        let rawToken = try await signInResult.user.getIDToken(forcingRefresh: false)
        #expect(!tokenResult.token.isEmpty)
        #expect(tokenResult.token == rawToken)
        #expect(tokenResult.token.split(separator: ".").count == 3)

        #expect(tokenResult.claims["sub"]?.stringValue == signInResult.user.uid)
        #expect(tokenResult.claims["user_id"]?.stringValue == signInResult.user.uid)
        #expect(tokenResult.claims["email"]?.stringValue == email)
        #expect(tokenResult.claims["division"]?.stringValue == "trajectory")
        #expect(tokenResult.claims["mission"]?.doubleValue == 11.0)
        #expect(tokenResult.claims["firebase"]?.dictionaryValue?["sign_in_provider"]?.stringValue == "password")

        let ttlSeconds = tokenResult.expirationDate.timeIntervalSince(tokenResult.issuedAtDate)
        #expect(ttlSeconds >= 3500 && ttlSeconds <= 3700)
        #expect(tokenResult.authDate <= tokenResult.issuedAtDate.addingTimeInterval(1))
        #expect(tokenResult.expirationDate > Date())

        // auth-swift#47: UserInfoImpl attributes populated from live providerData
        let passwordProvider = try #require(signInResult.user.providerData.first { $0.providerID == "password" })
        #expect(passwordProvider.email == email)
        #expect(passwordProvider.displayName == "Katherine Johnson")
        #expect(passwordProvider.photoURL == profilePhoto)

        try auth.signOut()
        let oauthUid = "oauth-meta-\(tag)"
        let oauthPhoto = try #require(URL(string: "https://example.test/avatars/github.png"))
        try await auth.stageSignInResult(
            providerID: "github.com",
            uid: oauthUid,
            email: "gh-\(tag)@example.test",
            displayName: "Margaret Hamilton",
            photoURL: oauthPhoto,
            isEmailVerified: true
        )
        let ghCred = OAuthProvider.credential(
            withProviderID: "github.com",
            idToken: "gh-id-\(tag)",
            accessToken: "gh-acc-\(tag)"
        )
        let ghResult = try await auth.signIn(with: ghCred)
        #expect(ghResult.additionalUserInfo?.providerID == "github.com")
        #expect(ghResult.additionalUserInfo?.isNewUser == true)
        let ghProviderInfo = try #require(ghResult.user.providerData.first { $0.providerID == "github.com" })
        #expect(ghProviderInfo.providerID == "github.com")
        #expect(ghProviderInfo.email == "gh-\(tag)@example.test")
        #expect(ghProviderInfo.displayName == "Margaret Hamilton")
        #expect(ghProviderInfo.photoURL == oauthPhoto)

        await app.disconnectSharedBridge()
    }

    @Test("auth-swift#48..52: switchLens, currentAuthLens, authLensStream, Bootstrap, and live SnapshotSubscriptionCoordinator re-subscription")
    func multiTenancyImpersonationAndSnapshotResubscriptionConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        // auth-swift#51: FirebaseAuthBootstrap.initialize() wires Auth into Firestore's credential provider registry
        FirebaseAuthBootstrap.initialize()
        let app = makeLiveApp(prefix: "auth-coupling", host: host, port: port)
        let firestore = Firestore.firestore(app: app)
        let resolvedProvider = try #require(firestore.credentialProvider)
        let auth = Auth.auth(app: app)
        #expect(resolvedProvider as AnyObject === auth)

        // auth-swift#48, #49, #50: switchLens, currentAuthLens, and authLensStream transitions
        let recordedLenses = LockedRecorder<AuthLens>()
        var lensIterator = auth.authLensStream.makeAsyncIterator()
        let initialLens = await lensIterator.next()
        #expect(initialLens == .anon)
        #expect(auth.currentAuthLens() == .anon)

        let streamCollector = Task {
            for await lens in auth.authLensStream {
                recordedLenses.append(lens)
            }
        }
        try await waitUntil { !recordedLenses.values.isEmpty }

        let tag = UUID().uuidString.lowercased()
        let editorRole = "editor-\(tag)"
        let viewerRole = "viewer-\(tag)"

        // Seed role-gated Firestore document under Admin Bypass lens (.admin), then clear lens back to .anon
        auth.switchLens(.admin)
        #expect(auth.impersonatedLens == .admin)
        #expect(auth.currentAuthLens() == .admin)
        #expect(await lensIterator.next() == .admin)

        let protectedDoc = firestore.document("role_items/\(editorRole)/items/doc-1")
        try await protectedDoc.setData(["stage": "v1"])

        let syntheticLens = AuthLens.asUser(
            uid: "impersonated-\(tag)",
            tenant: "tenant-imp",
            token: ["role": .string(editorRole)]
        )
        auth.switchLens(syntheticLens)
        #expect(auth.currentAuthLens() == syntheticLens)
        #expect(await lensIterator.next() == syntheticLens)
        let impSnap = try await protectedDoc.getDocument()
        #expect(impSnap.data()?["stage"] as? String == "v1")

        auth.switchLens(nil)
        #expect(auth.impersonatedLens == nil)
        #expect(auth.currentAuthLens() == .anon)
        #expect(await lensIterator.next() == .anon)

        // auth-swift#52: Live SnapshotSubscriptionCoordinator re-subscription across auth & token transitions
        auth.startRemoteSync()
        enum ListenerEvent: Sendable, Equatable {
            case stage(String)
            case denied
        }
        let listenerEvents = LockedRecorder<ListenerEvent>()
        let registration = protectedDoc.addSnapshotListener { snapshot, error in
            if error != nil {
                listenerEvents.append(.denied)
            } else if let stage = snapshot?.data()?["stage"] as? String {
                listenerEvents.append(.stage(stage))
            }
        }

        // 1. Unauthenticated (.anon) subscription is denied by live FIRESTORE_RULES
        try await waitUntil { listenerEvents.values.count >= 1 }
        #expect(listenerEvents.values.last == .denied)

        // 2. Sign in as a user with viewerRole (insufficient claim) -> re-subscribes and is still denied
        let userUid = "coupled-\(tag)"
        let userEmail = "coupled-\(tag)@example.test"
        let userPassword = "CoupledUser!12"
        _ = try await auth.bridgeClient.op(
            method: "auth.adminCreateUser",
            params: [
                "request": .dictionary([
                    "uid": .string(userUid),
                    "email": .string(userEmail),
                    "password": .string(userPassword),
                    "customClaims": .dictionary(["role": .string(viewerRole)]),
                ]),
            ]
        )
        let signedIn = try await auth.signIn(withEmail: userEmail, password: userPassword)
        if case let .asUser(activeUid, _, activeToken) = auth.currentAuthLens() {
            #expect(activeUid == userUid)
            #expect(activeToken?["role"]?.stringValue == viewerRole)
        } else {
            Issue.record("Expected .asUser lens after signIn")
        }
        try await waitUntil { listenerEvents.values.count >= 2 }
        #expect(listenerEvents.values.last == .denied)

        // 3. Promote user to editorRole and force ID token refresh (same UID, updated claims) -> coordinator re-subscribes and receives "v1"
        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(userUid),
                "request": .dictionary([
                    "customClaims": .dictionary(["role": .string(editorRole)]),
                ]),
            ]
        )
        _ = try await signedIn.user.getIDTokenResult(forcingRefresh: true)
        try await waitUntil { listenerEvents.values.contains(.stage("v1")) }
        #expect(listenerEvents.values.last == .stage("v1"))

        // 4. Reload under active startRemoteSync() preserves custom claims, and subsequent write delivers "v2"
        try await signedIn.user.reload()
        #expect(signedIn.user.claims["role"]?.stringValue == editorRole)
        try await protectedDoc.setData(["stage": "v2"])
        try await waitUntil { listenerEvents.values.contains(.stage("v2")) }
        #expect(listenerEvents.values.last == .stage("v2"))

        // 5. Sign out -> coordinator re-subscribes as .anon and immediately revokes stream with .denied
        let countBeforeSignOut = listenerEvents.values.count
        try auth.signOut()
        try await waitUntil { listenerEvents.values.count > countBeforeSignOut }
        #expect(listenerEvents.values.last == .denied)

        // 6. Switch to .admin bypass -> coordinator re-subscribes as .admin and delivers "v2"
        auth.switchLens(.admin)
        try await waitUntil { listenerEvents.values.last == .stage("v2") }
        #expect(listenerEvents.values.last == .stage("v2"))

        registration.remove()
        streamCollector.cancel()
        await app.disconnectSharedBridge()
    }

    @Test("auth-swift#53..54: AuthErrorCode and AuthError structured wire mapping over live host")
    func authErrorCodeAndLocalizedErrorConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "auth-errors", host: host, port: port)
        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()

        // 1. invalidEmail
        let invalidEmailErr = try #require(await expectAuthError {
            _ = try await auth.createUser(withEmail: "not-a-valid-email", password: "ValidPassword!1")
        })
        #expect(invalidEmailErr.code == .invalidEmail)
        #expect(invalidEmailErr.errorDescription == invalidEmailErr.message)
        #expect(!invalidEmailErr.message.isEmpty)
        #expect(invalidEmailErr.description.contains(AuthErrorCode.invalidEmail.rawValue))

        // 2. weakPassword
        let weakPasswordErr = try #require(await expectAuthError {
            _ = try await auth.createUser(withEmail: "weak-\(tag)@example.test", password: "123")
        })
        #expect(weakPasswordErr.code == .weakPassword)

        // 3. emailAlreadyInUse
        let dupEmail = "dup-\(tag)@example.test"
        let created = try await auth.createUser(withEmail: dupEmail, password: "StrongPassword!1")
        let dupErr = try #require(await expectAuthError {
            _ = try await auth.createUser(withEmail: dupEmail, password: "StrongPassword!1")
        })
        #expect(dupErr.code == .emailAlreadyInUse)

        // 4. invalidCredential (wrong password)
        try auth.signOut()
        let badCredErr = try #require(await expectAuthError {
            _ = try await auth.signIn(withEmail: dupEmail, password: "WrongPassword!9")
        })
        #expect(badCredErr.code == .invalidCredential)

        // 5. userDisabled
        _ = try await auth.bridgeClient.op(
            method: "auth.adminUpdateUser",
            params: [
                "uid": .string(created.user.uid),
                "request": .dictionary(["disabled": .bool(true)]),
            ]
        )
        let disabledSignInErr = try #require(await expectAuthError {
            _ = try await auth.signIn(withEmail: dupEmail, password: "StrongPassword!1")
        })
        #expect(disabledSignInErr.code == .userDisabled)

        // 6. noMockConfigured on unstaged OAuth signIn(with:)
        let unstagedCred = GoogleAuthProvider.credential(withIDToken: "unstaged-id", accessToken: "unstaged-acc")
        let noMockErr = try #require(await expectAuthError {
            _ = try await auth.signIn(with: unstagedCred)
        })
        #expect(noMockErr.code == .noMockConfigured)

        // 7. noCurrentUser on detached User token call
        let detachedUser = User(uid: "detached-\(tag)")
        let noUserErr = try #require(await expectAuthError {
            _ = try await detachedUser.getIDToken()
        })
        #expect(noUserErr.code == .noCurrentUser)
        #expect(AuthErrorCode.from(error: noUserErr) == .noCurrentUser)

        await app.disconnectSharedBridge()
    }

    @Test("auth-swift#55..58: GoogleAuthProvider, OAuthProvider, and Auth.signIn(with:) async and completion over live host")
    func oauthProvidersAndSignInWithCredentialConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "auth-oauth", host: host, port: port)
        let auth = Auth.auth(app: app)
        let firestore = Firestore.firestore(app: app)
        let tag = UUID().uuidString.lowercased()

        // auth-swift#55: GoogleAuthProvider.credential(withIDToken:accessToken:)
        let googleCred = GoogleAuthProvider.credential(
            withIDToken: "google-id-tok-\(tag)",
            accessToken: "google-access-tok-\(tag)"
        )
        #expect(googleCred.provider == "google.com")
        let googleOAuth = try #require(googleCred as? OAuthCredential)
        #expect(googleOAuth.idToken == "google-id-tok-\(tag)")
        #expect(googleOAuth.accessToken == "google-access-tok-\(tag)")

        // auth-swift#57: Auth.signIn(with:) async against live Pyric host with staged Google identity
        let googleUid = "google-uid-\(tag)"
        let googleEmail = "google-\(tag)@example.test"
        let googlePhoto = try #require(URL(string: "https://example.test/avatars/google-user.png"))
        try await auth.stageSignInResult(
            providerID: GoogleAuthProvider.providerID,
            uid: googleUid,
            email: googleEmail,
            displayName: "Alan Turing",
            photoURL: googlePhoto,
            isEmailVerified: true,
            customClaims: ["role": .string("cryptanalysis")]
        )

        let googleFirst = try await auth.signIn(with: googleCred)
        #expect(googleFirst.user.uid == googleUid)
        #expect(googleFirst.user.email == googleEmail)
        #expect(googleFirst.user.displayName == "Alan Turing")
        #expect(googleFirst.user.photoURL == googlePhoto)
        #expect(googleFirst.user.isEmailVerified == true)
        #expect(googleFirst.additionalUserInfo?.providerID == "google.com")
        #expect(googleFirst.additionalUserInfo?.isNewUser == true)
        #expect(auth.currentUser?.uid == googleUid)
        #expect(googleFirst.user.claims["role"]?.stringValue == "cryptanalysis")
        #expect(googleFirst.user.claims["firebase"]?.dictionaryValue?["sign_in_provider"]?.stringValue == "google.com")

        // Authenticated Google user passes live Firestore owner + custom-claim rules immediately
        try await firestore.document("users/\(googleUid)").setData(["provider": "google.com"])
        try await firestore.document("role_items/cryptanalysis/items/enigma").setData(["solved": true])
        let solvedSnap = try await firestore.document("role_items/cryptanalysis/items/enigma").getDocument()
        #expect(solvedSnap.data()?["solved"] as? Bool == true)

        // Re-signing in the same Google account marks isNewUser == false
        try auth.signOut()
        try await auth.stageSignInResult(
            providerID: GoogleAuthProvider.providerID,
            uid: googleUid,
            email: googleEmail,
            displayName: "Alan Turing",
            photoURL: googlePhoto,
            isEmailVerified: true
        )
        let googleRepeat = try await auth.signIn(with: googleCred)
        #expect(googleRepeat.user.uid == googleUid)
        #expect(googleRepeat.additionalUserInfo?.isNewUser == false)

        // auth-swift#56 & auth-swift#58: OAuthProvider.credential(...) + Auth.signIn(with:completion:) callback
        try auth.signOut()
        let appleCred = OAuthProvider.credential(
            withProviderID: "apple.com",
            idToken: "apple-id-tok-\(tag)",
            rawNonce: "raw-nonce-\(tag)",
            accessToken: "apple-acc-tok-\(tag)"
        )
        #expect(appleCred.provider == "apple.com")
        #expect(appleCred.idToken == "apple-id-tok-\(tag)")
        #expect(appleCred.rawNonce == "raw-nonce-\(tag)")
        #expect(appleCred.accessToken == "apple-acc-tok-\(tag)")

        let appleUid = "apple-uid-\(tag)"
        let appleEmail = "apple-\(tag)@privaterelay.example.test"
        try await auth.stageSignInResult(
            providerID: "apple.com",
            uid: appleUid,
            email: appleEmail,
            displayName: "Joan Clarke",
            isEmailVerified: true
        )

        let appleResult = try await awaitCompletion { done in
            auth.signIn(with: appleCred, completion: done)
        }
        #expect(appleResult.user.uid == appleUid)
        #expect(appleResult.user.email == appleEmail)
        #expect(appleResult.user.displayName == "Joan Clarke")
        #expect(appleResult.additionalUserInfo?.providerID == "apple.com")
        #expect(appleResult.additionalUserInfo?.isNewUser == true)
        #expect(auth.currentUser?.uid == appleUid)

        // Staged sign-in is consumed one-shot: a second un-staged call fails with .noMockConfigured
        let consumedErr = await expectAuthError {
            _ = try await auth.signIn(with: appleCred)
        }
        #expect(consumedErr?.code == .noMockConfigured)

        await app.disconnectSharedBridge()
    }

    // -- Section 5-9 Helpers --

    private func decodeJwtPayload(_ jwt: String) throws -> [String: Any] {
        let segments = jwt.split(separator: ".")
        #expect(segments.count == 3)
        guard segments.count == 3 else {
            throw AuthError(code: .internalError, message: "Invalid JWT segment count")
        }
        var base64 = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        let data = try #require(Data(base64Encoded: base64))
        let json = try JSONSerialization.jsonObject(with: data)
        return try #require(json as? [String: Any])
    }

    private func waitUntil(
        maxAttempts: Int = 500,
        intervalNanoseconds: UInt64 = 10_000_000,
        _ condition: () -> Bool
    ) async throws {
        for _ in 0..<maxAttempts {
            if condition() {
                return
            }
            try await Task.sleep(nanoseconds: intervalNanoseconds)
        }
        Issue.record("Timed out waiting for live-host condition")
        throw PyricBridgeError.deadlineExceeded("Timed out waiting for live-host condition")
    }
}
