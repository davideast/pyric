import FirebaseAuth
import Foundation

extension AuthOracleProbeRunner {
  static func runEmailPasswordAndErrorCodes(
    auth: Auth,
    runId: String
  ) async throws -> [String: Any] {
    var cleanupUids: [String] = []

    if auth.currentUser != nil {
      try? auth.signOut()
    }

    let safeRunToken = runId.lowercased()
    let email = "ios-ep-\(safeRunToken)@example.com"
    let missingEmail = "ios-missing-\(safeRunToken)@example.com"
    let validPassword = "ValidPass!2468"

    let created = try await auth.createUser(withEmail: email, password: validPassword)
    let createdUid = created.user.uid
    emitCleanupUid(createdUid, into: &cleanupUids)

    let signUpIsAnonymous = created.user.isAnonymous
    let signUpEmailMatches = created.user.email?.lowercased() == email
    let signUpEmailVerified = created.user.isEmailVerified
    let currentUserMatchesAfterSignUp = auth.currentUser?.uid == createdUid

    var duplicateEmailError = CapturedIosAuthError(domain: "", code: -1, errorName: "")
    var duplicateRejected = false
    do {
      let unexpected = try await auth.createUser(withEmail: email, password: "OtherPass!1357")
      emitCleanupUid(unexpected.user.uid, into: &cleanupUids)
    } catch {
      duplicateRejected = true
      duplicateEmailError = extractAuthError(error)
    }
    if !duplicateRejected {
      throw AuthOracleError.expectedAuthRejection("duplicate-email")
    }

    try auth.signOut()
    let signedIn = try await auth.signIn(withEmail: email, password: validPassword)
    emitCleanupUid(signedIn.user.uid, into: &cleanupUids)
    let signInUidMatchesSignUp = signedIn.user.uid == createdUid
    let signInIsAnonymous = signedIn.user.isAnonymous
    let currentUserMatchesAfterSignIn = auth.currentUser?.uid == createdUid

    try auth.signOut()
    var wrongPasswordError = CapturedIosAuthError(domain: "", code: -1, errorName: "")
    var wrongPasswordRejected = false
    do {
      let unexpected = try await auth.signIn(withEmail: email, password: "WrongPass!9999")
      emitCleanupUid(unexpected.user.uid, into: &cleanupUids)
    } catch {
      wrongPasswordRejected = true
      wrongPasswordError = extractAuthError(error)
    }
    if !wrongPasswordRejected {
      throw AuthOracleError.expectedAuthRejection("wrong-password")
    }

    var invalidEmailError = CapturedIosAuthError(domain: "", code: -1, errorName: "")
    var invalidEmailRejected = false
    do {
      let unexpected = try await auth.signIn(
        withEmail: "not-a-valid-email",
        password: validPassword
      )
      emitCleanupUid(unexpected.user.uid, into: &cleanupUids)
    } catch {
      invalidEmailRejected = true
      invalidEmailError = extractAuthError(error)
    }
    if !invalidEmailRejected {
      throw AuthOracleError.expectedAuthRejection("invalid-email")
    }

    var userNotFoundError = CapturedIosAuthError(domain: "", code: -1, errorName: "")
    var userNotFoundRejected = false
    do {
      let unexpected = try await auth.signIn(withEmail: missingEmail, password: validPassword)
      emitCleanupUid(unexpected.user.uid, into: &cleanupUids)
    } catch {
      userNotFoundRejected = true
      userNotFoundError = extractAuthError(error)
    }
    if !userNotFoundRejected {
      throw AuthOracleError.expectedAuthRejection("user-not-found")
    }

    let wrongPasswordMatchesExpectedEnum =
      wrongPasswordError.code == AuthErrorCode.wrongPassword.rawValue
      || wrongPasswordError.code == AuthErrorCode.invalidCredential.rawValue
    let userNotFoundMatchesExpectedEnum =
      userNotFoundError.code == AuthErrorCode.userNotFound.rawValue
      || userNotFoundError.code == AuthErrorCode.invalidCredential.rawValue

    return [
      "signUpIsAnonymous": signUpIsAnonymous,
      "signUpEmailMatches": signUpEmailMatches,
      "signUpEmailVerified": signUpEmailVerified,
      "currentUserMatchesAfterSignUp": currentUserMatchesAfterSignUp,
      "duplicateEmailDomain": duplicateEmailError.domain,
      "duplicateEmailCode": duplicateEmailError.code,
      "duplicateEmailMatchesEnum":
        duplicateEmailError.code == AuthErrorCode.emailAlreadyInUse.rawValue,
      "duplicateEmailErrorName": duplicateEmailError.errorName,
      "signInUidMatchesSignUp": signInUidMatchesSignUp,
      "signInIsAnonymous": signInIsAnonymous,
      "currentUserMatchesAfterSignIn": currentUserMatchesAfterSignIn,
      "wrongPasswordDomain": wrongPasswordError.domain,
      "wrongPasswordCode": wrongPasswordError.code,
      "wrongPasswordErrorName": wrongPasswordError.errorName,
      "wrongPasswordMatchesExpectedEnum": wrongPasswordMatchesExpectedEnum,
      "invalidEmailDomain": invalidEmailError.domain,
      "invalidEmailCode": invalidEmailError.code,
      "invalidEmailMatchesEnum":
        invalidEmailError.code == AuthErrorCode.invalidEmail.rawValue,
      "invalidEmailErrorName": invalidEmailError.errorName,
      "userNotFoundDomain": userNotFoundError.domain,
      "userNotFoundCode": userNotFoundError.code,
      "userNotFoundErrorName": userNotFoundError.errorName,
      "userNotFoundMatchesExpectedEnum": userNotFoundMatchesExpectedEnum,
      "_cleanupUids": cleanupUids,
    ]
  }

  static func runProfileTokenClaimsAndDeleteLifecycle(
    auth: Auth,
    runId: String
  ) async throws -> [String: Any] {
    var cleanupUids: [String] = []

    if auth.currentUser != nil {
      try? auth.signOut()
    }

    let email = "ios-prof-\(runId.lowercased())@example.com"
    let password = "ValidPass!2468"
    let created = try await auth.createUser(withEmail: email, password: password)
    let createdUser = created.user
    emitCleanupUid(createdUser.uid, into: &cleanupUids)

    let initialDisplayNameNil = createdUser.displayName == nil
    let initialPhotoUrlNil = createdUser.photoURL == nil

    let profileRequest = createdUser.createProfileChangeRequest()
    profileRequest.displayName = "Ada Lovelace"
    profileRequest.photoURL = URL(string: "https://example.com/avatars/ada.png")
    try await profileRequest.commitChanges()

    let displayNameAfterCommit = createdUser.displayName ?? ""
    let photoUrlAfterCommit = createdUser.photoURL?.absoluteString ?? ""

    try await createdUser.reload()
    let reloadedUser = auth.currentUser ?? createdUser
    let displayNameAfterReload = reloadedUser.displayName ?? ""
    let photoUrlAfterReload = reloadedUser.photoURL?.absoluteString ?? ""

    let tokenResult = try await reloadedUser.getIDTokenResult(forcingRefresh: true)
    let jwtSegmentCount = tokenResult.token.components(separatedBy: ".").count
    let signInProvider = tokenResult.signInProvider
    let expirationAfterAuthDate = tokenResult.expirationDate > tokenResult.authDate
    let issuedAtPresent = tokenResult.issuedAtDate.timeIntervalSince1970 > 1_700_000_000

    let claimEmailMatchesUser =
      (tokenResult.claims["email"] as? String)?.lowercased() == email
    let claimEmailVerified = (tokenResult.claims["email_verified"] as? Bool) ?? true
    let claimSubMatchesUid = (tokenResult.claims["sub"] as? String) == reloadedUser.uid
    let claimUserIdMatchesUid = (tokenResult.claims["user_id"] as? String) == reloadedUser.uid
    let claimNameAfterProfileUpdate = (tokenResult.claims["name"] as? String) ?? ""
    let claimPictureAfterProfileUpdate = (tokenResult.claims["picture"] as? String) ?? ""
    let firebaseClaim = tokenResult.claims["firebase"] as? [String: Any]
    let firebaseSignInProvider = (firebaseClaim?["sign_in_provider"] as? String) ?? ""
    let identitiesClaim = firebaseClaim?["identities"] as? [String: Any]
    let emailIdentities = identitiesClaim?["email"] as? [String]
    let firebaseEmailIdentityCount = emailIdentities?.count ?? 0

    try await reloadedUser.delete()
    let currentUserNilAfterDelete = auth.currentUser == nil

    var signInAfterDeleteError = CapturedIosAuthError(domain: "", code: -1, errorName: "")
    var signInAfterDeleteRejected = false
    do {
      let unexpected = try await auth.signIn(withEmail: email, password: password)
      emitCleanupUid(unexpected.user.uid, into: &cleanupUids)
    } catch {
      signInAfterDeleteRejected = true
      signInAfterDeleteError = extractAuthError(error)
    }
    if !signInAfterDeleteRejected {
      throw AuthOracleError.expectedAuthRejection("sign-in-after-delete")
    }

    let signInAfterDeleteMatchesExpectedEnum =
      signInAfterDeleteError.code == AuthErrorCode.userNotFound.rawValue
      || signInAfterDeleteError.code == AuthErrorCode.invalidCredential.rawValue

    return [
      "initialDisplayNameNil": initialDisplayNameNil,
      "initialPhotoUrlNil": initialPhotoUrlNil,
      "displayNameAfterCommit": displayNameAfterCommit,
      "photoUrlAfterCommit": photoUrlAfterCommit,
      "displayNameAfterReload": displayNameAfterReload,
      "photoUrlAfterReload": photoUrlAfterReload,
      "jwtSegmentCount": jwtSegmentCount,
      "signInProvider": signInProvider,
      "expirationAfterAuthDate": expirationAfterAuthDate,
      "issuedAtPresent": issuedAtPresent,
      "claimEmailMatchesUser": claimEmailMatchesUser,
      "claimEmailVerified": claimEmailVerified,
      "claimSubMatchesUid": claimSubMatchesUid,
      "claimUserIdMatchesUid": claimUserIdMatchesUid,
      "claimNameAfterProfileUpdate": claimNameAfterProfileUpdate,
      "claimPictureAfterProfileUpdate": claimPictureAfterProfileUpdate,
      "firebaseSignInProvider": firebaseSignInProvider,
      "firebaseEmailIdentityCount": firebaseEmailIdentityCount,
      "currentUserNilAfterDelete": currentUserNilAfterDelete,
      "signInAfterDeleteRejected": signInAfterDeleteRejected,
      "signInAfterDeleteDomain": signInAfterDeleteError.domain,
      "signInAfterDeleteCode": signInAfterDeleteError.code,
      "signInAfterDeleteErrorName": signInAfterDeleteError.errorName,
      "signInAfterDeleteMatchesExpectedEnum": signInAfterDeleteMatchesExpectedEnum,
      "_cleanupUids": cleanupUids,
    ]
  }
}
