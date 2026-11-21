import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

extension AuthLiveHostConformanceTests {

    @Test("firebase-ios-sdk 13.2.0 oracle parity: User.providerID Firebase, tenantID, languageCode, UserProfileChangeRequest, link/reauth/unlink/delete, and FIRAuthErrorDomain NSError codes")
    func iosOracleSdk13ParityOverLiveHost() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            defer {
                Auth.reset()
            }

            let app = makeLiveApp(prefix: "auth-oracle-parity", host: host, port: port)
            let auth = Auth.auth(app: app)
            let tenantApp = makeLiveApp(prefix: "auth-oracle-tenant", host: host, port: port)
            let tenantAuth = Auth.auth(app: tenantApp)
            let tag = UUID().uuidString.lowercased()

            do {
                // 1. Auth.tenantID and languageCode / useAppLanguage
                #expect(tenantAuth.tenantID == nil)
                tenantAuth.tenantID = "tenant-wave4"
                #expect(tenantAuth.tenantID == "tenant-wave4")
                #expect(auth.tenantID == nil)

                auth.languageCode = "de"
                #expect(auth.languageCode == "de")
                auth.useAppLanguage()
                #expect(!(auth.languageCode ?? "").isEmpty)

                // 2. Anonymous session: top-level providerID == "Firebase", empty providerData, non-nil metadata dates, nil tenantID
                let anonResult = try await auth.signInAnonymously()
                let anonUser = anonResult.user
                #expect(anonUser.providerID == "Firebase")
                #expect(anonUser.providerData.isEmpty)
                #expect(anonUser.tenantID == nil)
                #expect(anonUser.metadata.creationDate != nil)
                #expect(anonUser.metadata.lastSignInDate != nil)

                // 3. Link anonymous account with EmailAuthProvider credential, preserving UID
                let upgradeEmail = "ios-parity-\(tag)@example.test"
                let initialPassword = "OracleLink1!\(tag.suffix(8))"
                let updatedPassword = "OracleLink2!\(tag.suffix(8))"

                let linkCred = EmailAuthProvider.credential(withEmail: upgradeEmail, password: initialPassword)
                #expect(EmailAuthProvider.id == "password")
                let linkedResult = try await anonUser.link(with: linkCred)
                let linkedUser = linkedResult.user
                #expect(linkedUser === anonUser)
                #expect(linkedUser.uid == anonUser.uid)
                #expect(anonUser.isAnonymous == false)
                #expect(anonUser.email == upgradeEmail)
                #expect(anonUser.providerData.map(\.providerID) == ["password"])
                #expect(linkedUser.isAnonymous == false)
                #expect(linkedUser.email == upgradeEmail)
                #expect(linkedUser.providerData.map(\.providerID) == ["password"])

                // 4. Provider-already-linked error maps to AuthErrorCode.providerAlreadyLinked and FIRAuthErrorDomain 17015
                let alreadyLinkedErr = try #require(await expectAuthError {
                    _ = try await linkedUser.link(
                        with: EmailAuthProvider.credential(
                            withEmail: "second-\(tag)@example.test",
                            password: initialPassword
                        )
                    )
                })
                #expect(alreadyLinkedErr.code == .providerAlreadyLinked)
                let alreadyLinkedNs = alreadyLinkedErr as NSError
                #expect(alreadyLinkedNs.domain == AuthErrorDomain)
                #expect(alreadyLinkedNs.code == 17015)
                #expect(alreadyLinkedNs.userInfo[AuthErrorUserInfoNameKey] as? String == "ERROR_PROVIDER_ALREADY_LINKED")

                // 5. UserProfileChangeRequest commitChanges() updates displayName and photoURL
                let profileReq = linkedUser.createProfileChangeRequest()
                profileReq.displayName = "Ada Lovelace"
                profileReq.photoURL = URL(string: "https://example.com/avatars/ada.png")
                try await profileReq.commitChanges()
                #expect(linkedUser.displayName == "Ada Lovelace")
                #expect(linkedUser.photoURL?.absoluteString == "https://example.com/avatars/ada.png")

                // 6. reauthenticate(with:), updatePassword(to:), signIn(with:), and unlink(fromProvider:)
                let reauthRes = try await linkedUser.reauthenticate(with: linkCred)
                #expect(reauthRes.user === linkedUser)
                #expect(reauthRes.user.uid == anonUser.uid)

                try await linkedUser.updatePassword(to: updatedPassword)
                try auth.signOut()

                let updatedCred = EmailAuthProvider.credential(withEmail: upgradeEmail, password: updatedPassword)
                let signedBackIn = try await auth.signIn(with: updatedCred)
                #expect(signedBackIn.user.uid == anonUser.uid)

                let unlinkedUser = try await signedBackIn.user.unlink(fromProvider: EmailAuthProvider.id)
                #expect(unlinkedUser.providerData.isEmpty)

                // 7. Typed AuthProviderID OAuthProvider.credential overloads
                let ghCred = OAuthProvider.credential(
                    providerID: .gitHub,
                    idToken: "gh-id-tok",
                    accessToken: "gh-acc-tok"
                )
                #expect(ghCred.provider == "github.com")
                let appleCred = OAuthProvider.credential(
                    providerID: .apple,
                    idToken: "apple-id-tok",
                    rawNonce: "nonce-1",
                    accessToken: "apple-acc-tok"
                )
                #expect(appleCred.provider == "apple.com")
                let customOidcCred = OAuthProvider.credential(
                    providerID: .custom("oidc.demo-idp"),
                    idToken: "oidc-id-tok",
                    accessToken: "oidc-acc-tok"
                )
                #expect(customOidcCred.provider == "oidc.demo-idp")

                // 8. User.delete() clears currentUser and invalidates subsequent password sign-in (FIRAuthErrorDomain 17004)
                let freshDeleteEmail = "ios-delete-\(tag)@example.test"
                let toDelete = try await auth.createUser(withEmail: freshDeleteEmail, password: initialPassword)
                try await toDelete.user.delete()
                #expect(auth.currentUser == nil)

                let postDeleteErr = try #require(await expectAuthError {
                    _ = try await auth.signIn(withEmail: freshDeleteEmail, password: initialPassword)
                })
                let postDeleteNs = postDeleteErr as NSError
                #expect(postDeleteNs.domain == AuthErrorDomain)
                #expect(postDeleteNs.code == 17004)
                #expect(postDeleteNs.userInfo[AuthErrorUserInfoNameKey] as? String == "ERROR_INVALID_CREDENTIAL")

                // 9. Invalid custom token maps to FIRAuthErrorDomain 17000 ERROR_INVALID_CUSTOM_TOKEN
                let invalidCustomErr = try #require(await expectAuthError {
                    _ = try await auth.signIn(withCustomToken: "not-a-valid-jwt")
                })
                let invalidCustomNs = invalidCustomErr as NSError
                #expect(invalidCustomNs.domain == AuthErrorDomain)
                #expect(invalidCustomNs.code == 17000)
                #expect(invalidCustomNs.userInfo[AuthErrorUserInfoNameKey] as? String == "ERROR_INVALID_CUSTOM_TOKEN")

                await tenantApp.disconnectSharedBridge()
                await app.disconnectSharedBridge()
            } catch {
                await tenantApp.disconnectSharedBridge()
                await app.disconnectSharedBridge()
                throw error
            }
        }
    }
}
