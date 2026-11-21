import FirebaseAuth
import FirebaseCore
import Foundation

private final class AuthListenerRecorder {
  private let lock = NSLock()
  private var stateEvents: [String] = []
  private var idTokenEvents: [String] = []

  func recordState(_ uid: String?) {
    lock.lock()
    defer { lock.unlock() }
    stateEvents.append(uid == nil ? "nil" : "user")
  }

  func recordIdToken(_ uid: String?) {
    lock.lock()
    defer { lock.unlock() }
    idTokenEvents.append(uid == nil ? "nil" : "user")
  }

  func snapshot() -> (states: [String], tokens: [String]) {
    lock.lock()
    defer { lock.unlock() }
    return (stateEvents, idTokenEvents)
  }
}

extension AuthOracleProbeRunner {
  private static func awaitAuthCondition(
    _ label: String,
    timeoutMs: Int = 10_000,
    predicate: () -> Bool
  ) async throws {
    let attempts = max(1, timeoutMs / 25)
    for _ in 0..<attempts {
      if predicate() {
        return
      }
      try await Task.sleep(nanoseconds: 25_000_000)
    }
    if !predicate() {
      throw AuthOracleError.listenerTimeout(label)
    }
  }

  private static func describeProviderEntries(
    _ user: User,
    expectedEmail: String?
  ) -> [[String: Any]] {
    var entries: [[String: Any]] = []
    for info in user.providerData {
      let matchesExpected =
        expectedEmail != nil && info.email?.lowercased() == expectedEmail?.lowercased()
      entries.append([
        "providerID": info.providerID,
        "uidNonEmpty": !info.uid.isEmpty,
        "emailMatchesExpected": matchesExpected,
        "emailIsNil": info.email == nil,
        "displayNameIsNil": info.displayName == nil,
        "photoURLIsNil": info.photoURL == nil,
        "phoneNumberIsNil": info.phoneNumber == nil,
      ])
    }
    return entries
  }

  private static func captureAuthFailure(
    step: String,
    cleanupUids: inout [String],
    operation: () async throws -> AuthDataResult
  ) async throws -> [String: Any] {
    do {
      let unexpected = try await operation()
      emitCleanupUid(unexpected.user.uid, into: &cleanupUids)
      throw AuthOracleError.expectedAuthRejection(step)
    } catch let oracleErr as AuthOracleError {
      throw oracleErr
    } catch {
      let captured = extractAuthError(error)
      return [
        "threw": true,
        "domain": captured.domain,
        "code": captured.code,
        "errorName": captured.errorName,
      ]
    }
  }

  static func runInstanceLinkingReauthAndOAuthCredentials(
    auth: Auth,
    app: FirebaseApp,
    options: FirebaseOptions,
    runId: String
  ) async throws -> [String: Any] {
    var cleanupUids: [String] = []
    let safeToken = runId.lowercased()
    let upgradeEmail = "ios-link-\(safeToken)@example.com"
    let collisionEmail = "ios-collision-\(safeToken)@example.com"
    let initialPassword = "OracleLink1!\(safeToken.suffix(8))9A"
    let updatedPassword = "OracleLink2!\(safeToken.suffix(8))9B"

    let createdDefaultApp = FirebaseApp.app() == nil
    if createdDefaultApp {
      FirebaseApp.configure(options: options)
    }
    let defaultApp = FirebaseApp.app()

    let tenantAppName = "pyric-ios-auth-tenant-\(runId)"
    FirebaseApp.configure(name: tenantAppName, options: options)
    guard let tenantApp = FirebaseApp.app(name: tenantAppName) else {
      if createdDefaultApp, let createdDefault = defaultApp {
        await deleteAppAsync(createdDefault)
      }
      throw AuthOracleError.appLookupFailed(tenantAppName)
    }

    if auth.currentUser != nil {
      try? auth.signOut()
    }

    let recorder = AuthListenerRecorder()
    var stateHandle: NSObjectProtocol?
    var idTokenHandle: NSObjectProtocol?

    do {
      let defaultAuthSingletonIdentical = Auth.auth() === Auth.auth()
      let defaultAuthAppIsDefault = Auth.auth().app?.name == "__FIRAPP_DEFAULT"
      let namedAuthSingletonIdentical = Auth.auth(app: app) === auth
      let namedAuthAppMatchesConfigured = auth.app === app && auth.app?.name == app.name

      let tenantAuth = Auth.auth(app: tenantApp)
      let initialTenantIdNil = tenantAuth.tenantID == nil
      tenantAuth.tenantID = "tenant-wave4"
      let configuredTenantId = tenantAuth.tenantID ?? ""
      let mainAppTenantIdNil = auth.tenantID == nil

      auth.languageCode = "de"
      let explicitLanguageCode = auth.languageCode ?? ""
      auth.useAppLanguage()
      let afterUseAppLanguageValid =
        auth.languageCode == nil || !(auth.languageCode ?? "").isEmpty

      var asyncSequenceInitialStateNil = true
      var asyncSequenceInitialIdTokenNil = true
      if #available(iOS 18.0, macOS 15.0, *) {
        for await firstUser in auth.authStateChanges {
          asyncSequenceInitialStateNil = firstUser == nil
          break
        }
        for await firstTokenUser in auth.idTokenChanges {
          asyncSequenceInitialIdTokenNil = firstTokenUser == nil
          break
        }
      }

      let attachedStateHandle = auth.addStateDidChangeListener { _, user in
        recorder.recordState(user?.uid)
      }
      stateHandle = attachedStateHandle
      let attachedTokenHandle = auth.addIDTokenDidChangeListener { _, user in
        recorder.recordIdToken(user?.uid)
      }
      idTokenHandle = attachedTokenHandle

      try await awaitAuthCondition("initial-nil-listener-fire") {
        let snap = recorder.snapshot()
        return snap.states.first == "nil" && snap.tokens.first == "nil"
      }

      let anonResult = try await auth.signInAnonymously()
      let anonUser = anonResult.user
      emitCleanupUid(anonUser.uid, into: &cleanupUids)

      let anonIsNewUser = anonResult.additionalUserInfo?.isNewUser ?? false
      let anonTopLevelProviderID = anonUser.providerID
      let anonPhoneNumberNil = anonUser.phoneNumber == nil
      let anonUserTenantIdNil = anonUser.tenantID == nil
      let anonMetadataHasCreationDate = anonUser.metadata.creationDate != nil
      let anonMetadataHasLastSignInDate = anonUser.metadata.lastSignInDate != nil
      let anonProviderEntries = describeProviderEntries(anonUser, expectedEmail: nil)

      let cachedJwt = try await anonUser.getIDToken(forcingRefresh: false)
      let refreshedJwt = try await anonUser.getIDToken(forcingRefresh: true)
      let getIDTokenSegmentCountsValid =
        cachedJwt.components(separatedBy: ".").count == 3
        && refreshedJwt.components(separatedBy: ".").count == 3

      try await awaitAuthCondition("post-signin-and-refresh-listeners") {
        let snap = recorder.snapshot()
        return snap.states.contains("user") && snap.tokens.filter { $0 == "user" }.count >= 2
      }

      let linkCred = EmailAuthProvider.credential(
        withEmail: upgradeEmail,
        password: initialPassword
      )
      let linkedResult = try await anonUser.link(with: linkCred)
      let linkedUser = linkedResult.user
      emitCleanupUid(linkedUser.uid, into: &cleanupUids)

      let linkPreservedUid = linkedUser.uid == anonUser.uid
      let linkedIsAnonymous = linkedUser.isAnonymous
      let linkedEmailMatches = linkedUser.email?.lowercased() == upgradeEmail
      let linkedPhoneNumberNil = linkedUser.phoneNumber == nil
      let linkedProviderEntries = describeProviderEntries(linkedUser, expectedEmail: upgradeEmail)

      try auth.signOut()
      let collisionSeed = try await auth.createUser(
        withEmail: collisionEmail,
        password: initialPassword
      )
      emitCleanupUid(collisionSeed.user.uid, into: &cleanupUids)
      try auth.signOut()

      let collisionAnonResult = try await auth.signInAnonymously()
      let collisionAnonUser = collisionAnonResult.user
      emitCleanupUid(collisionAnonUser.uid, into: &cleanupUids)

      var collisionOutcome = try await captureAuthFailure(
        step: "link-collision",
        cleanupUids: &cleanupUids
      ) {
        try await collisionAnonUser.link(
          with: EmailAuthProvider.credential(
            withEmail: collisionEmail,
            password: initialPassword
          )
        )
      }
      let collisionCode = (collisionOutcome["code"] as? Int) ?? -1
      collisionOutcome["matchesCollisionEnum"] =
        collisionCode == AuthErrorCode.credentialAlreadyInUse.rawValue
        || collisionCode == AuthErrorCode.emailAlreadyInUse.rawValue

      try auth.signOut()
      let reloginResult = try await auth.signIn(
        withEmail: upgradeEmail,
        password: initialPassword
      )
      let activeUser = reloginResult.user
      emitCleanupUid(activeUser.uid, into: &cleanupUids)
      let existingSignInIsNewUser = reloginResult.additionalUserInfo?.isNewUser ?? true

      var alreadyLinkedOutcome = try await captureAuthFailure(
        step: "provider-already-linked",
        cleanupUids: &cleanupUids
      ) {
        try await activeUser.link(
          with: EmailAuthProvider.credential(
            withEmail: collisionEmail,
            password: initialPassword
          )
        )
      }
      let alreadyLinkedCode = (alreadyLinkedOutcome["code"] as? Int) ?? -1
      alreadyLinkedOutcome["matchesProviderAlreadyLinkedEnum"] =
        alreadyLinkedCode == AuthErrorCode.providerAlreadyLinked.rawValue

      let reauthResult = try await activeUser.reauthenticate(
        with: EmailAuthProvider.credential(
          withEmail: upgradeEmail,
          password: initialPassword
        )
      )
      let reauthenticatePreservedUid = reauthResult.user.uid == anonUser.uid

      try await activeUser.updatePassword(to: updatedPassword)
      try auth.signOut()

      let updatedCred = EmailAuthProvider.credential(
        withEmail: upgradeEmail,
        password: updatedPassword
      )
      let updatedSignIn = try await auth.signIn(with: updatedCred)
      let updatedUser = updatedSignIn.user
      emitCleanupUid(updatedUser.uid, into: &cleanupUids)
      let updatedPasswordCredentialSameUid = updatedUser.uid == anonUser.uid

      let unlinkedUser = try await updatedUser.unlink(fromProvider: EmailAuthProvider.id)
      let unlinkedProviderIDs = unlinkedUser.providerData.map { $0.providerID }

      if let sh = stateHandle {
        auth.removeStateDidChangeListener(sh)
        stateHandle = nil
      }
      if let th = idTokenHandle {
        auth.removeIDTokenDidChangeListener(th)
        idTokenHandle = nil
      }
      try await Task.sleep(nanoseconds: 50_000_000)
      let countsBeforePostRemoveSignOut = recorder.snapshot()

      try auth.signOut()
      try await Task.sleep(nanoseconds: 50_000_000)
      let countsAfterPostRemoveSignOut = recorder.snapshot()
      let silentAfterRemoveListeners =
        countsAfterPostRemoveSignOut.states.count == countsBeforePostRemoveSignOut.states.count
        && countsAfterPostRemoveSignOut.tokens.count == countsBeforePostRemoveSignOut.tokens.count

      let googleCred = GoogleAuthProvider.credential(
        withIDToken: "synthetic-google-id-token",
        accessToken: "synthetic-google-access-token"
      )
      let githubCred = OAuthProvider.credential(
        providerID: .gitHub,
        idToken: "synthetic-github-id-token",
        accessToken: "synthetic-github-access-token"
      )
      let appleCred = OAuthProvider.credential(
        providerID: .apple,
        idToken: "synthetic-apple-id-token",
        rawNonce: "raw-nonce-wave4",
        accessToken: "synthetic-apple-access-token"
      )
      let customOidcCred = OAuthProvider.credential(
        providerID: .custom("oidc.demo-idp"),
        idToken: "synthetic-oidc-id-token",
        accessToken: "synthetic-oidc-access-token"
      )

      let googleRejectOutcome = try await captureAuthFailure(
        step: "google-synthetic-signin",
        cleanupUids: &cleanupUids
      ) {
        try await auth.signIn(with: googleCred)
      }
      let appleRejectOutcome = try await captureAuthFailure(
        step: "apple-synthetic-signin",
        cleanupUids: &cleanupUids
      ) {
        try await auth.signIn(with: appleCred)
      }

      await deleteAppAsync(tenantApp)
      if createdDefaultApp, let createdDefault = defaultApp {
        await deleteAppAsync(createdDefault)
      }

      return [
        "defaultAuthSingletonIdentical": defaultAuthSingletonIdentical,
        "defaultAuthAppIsDefault": defaultAuthAppIsDefault,
        "namedAuthSingletonIdentical": namedAuthSingletonIdentical,
        "namedAuthAppMatchesConfigured": namedAuthAppMatchesConfigured,
        "initialTenantIdNil": initialTenantIdNil,
        "configuredTenantId": configuredTenantId,
        "mainAppTenantIdNil": mainAppTenantIdNil,
        "explicitLanguageCode": explicitLanguageCode,
        "afterUseAppLanguageValid": afterUseAppLanguageValid,
        "asyncSequenceInitialStateNil": asyncSequenceInitialStateNil,
        "asyncSequenceInitialIdTokenNil": asyncSequenceInitialIdTokenNil,
        "stateListenerInitialNil": countsBeforePostRemoveSignOut.states.first == "nil",
        "stateListenerObservedTransitions": countsBeforePostRemoveSignOut.states.count >= 3,
        "idTokenListenerMoreGranularOrEqual":
          countsBeforePostRemoveSignOut.tokens.count >= countsBeforePostRemoveSignOut.states.count,
        "silentAfterRemoveListeners": silentAfterRemoveListeners,
        "anonymousIsNewUser": anonIsNewUser,
        "existingSignInIsNewUser": existingSignInIsNewUser,
        "anonymousTopLevelProviderID": anonTopLevelProviderID,
        "anonymousPhoneNumberNil": anonPhoneNumberNil,
        "anonymousUserTenantIdNil": anonUserTenantIdNil,
        "anonymousMetadataHasDates":
          anonMetadataHasCreationDate && anonMetadataHasLastSignInDate,
        "anonymousProviderEntries": anonProviderEntries,
        "getIDTokenSegmentCountsValid": getIDTokenSegmentCountsValid,
        "linkPreservedUid": linkPreservedUid,
        "linkedIsAnonymous": linkedIsAnonymous,
        "linkedEmailMatches": linkedEmailMatches,
        "linkedPhoneNumberNil": linkedPhoneNumberNil,
        "linkedProviderEntries": linkedProviderEntries,
        "linkCollision": collisionOutcome,
        "alreadyLinkedProvider": alreadyLinkedOutcome,
        "reauthenticatePreservedUid": reauthenticatePreservedUid,
        "updatedPasswordCredentialSameUid": updatedPasswordCredentialSameUid,
        "unlinkedProviderIDs": unlinkedProviderIDs,
        "emailProviderConstant": EmailAuthProvider.id,
        "googleCredentialProvider": googleCred.provider,
        "githubOAuthProvider": githubCred.provider,
        "githubOAuthHasIdAndAccessTokens":
          githubCred.idToken != nil && githubCred.accessToken != nil,
        "appleOAuthProvider": appleCred.provider,
        "appleOAuthHasIdAndAccessTokens":
          appleCred.idToken != nil && appleCred.accessToken != nil,
        "customOidcProvider": customOidcCred.provider,
        "googleSyntheticSignInOutcome": googleRejectOutcome,
        "appleSyntheticSignInOutcome": appleRejectOutcome,
        "_cleanupUids": cleanupUids,
      ]
    } catch {
      if let sh = stateHandle {
        auth.removeStateDidChangeListener(sh)
      }
      if let th = idTokenHandle {
        auth.removeIDTokenDidChangeListener(th)
      }
      await deleteAppAsync(tenantApp)
      if createdDefaultApp, let createdDefault = defaultApp {
        await deleteAppAsync(createdDefault)
      }
      throw error
    }
  }
}
