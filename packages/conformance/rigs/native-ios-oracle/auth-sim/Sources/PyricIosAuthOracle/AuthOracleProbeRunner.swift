import Darwin
import FirebaseAuth
import FirebaseCore
import Foundation

public struct AuthOracleInputConfig: Decodable {
  public let mode: String?
  public let probeId: String?
  public let runId: String?
  public let projectId: String?
  public let googleAppId: String?
  public let gcmSenderId: String?
  public let apiKey: String?
  public let customToken: String?
  public let expectedCustomUid: String?
}

public enum AuthOracleError: LocalizedError {
  case missingField(String)
  case unknownProbe(String)
  case appLookupFailed(String)
  case expectedInvalidTokenError
  case expectedAuthRejection(String)
  case listenerTimeout(String)
  case invalidJsonObject

  public var errorDescription: String? {
    switch self {
    case .missingField(let name):
      return "Missing required Auth oracle input field '\(name)'"
    case .unknownProbe(let probeId):
      return "Unknown iOS Auth oracle probe '\(probeId)'"
    case .appLookupFailed(let appName):
      return "Failed to resolve configured FirebaseApp '\(appName)'"
    case .expectedInvalidTokenError:
      return "Expected signIn(withCustomToken:) with malformed token to throw an error"
    case .expectedAuthRejection(let step):
      return "Expected FirebaseAuth rejection during step '\(step)'"
    case .listenerTimeout(let step):
      return "Timed out waiting for FirebaseAuth listener condition '\(step)'"
    case .invalidJsonObject:
      return "Auth oracle behavior payload is not a valid JSON object"
    }
  }
}

struct CapturedIosAuthError {
  let domain: String
  let code: Int
  let errorName: String
}

public enum AuthOracleProbeRunner {
  static func emitCleanupUid(_ uid: String, into cleanupUids: inout [String]) {
    if !uid.isEmpty {
      if !cleanupUids.contains(uid) {
        cleanupUids.append(uid)
      }
      print("PYRIC_IOS_ORACLE_CLEANUP_UID:\(uid)")
      fflush(stdout)
    }
  }

  static func extractAuthError(_ error: Error) -> CapturedIosAuthError {
    let nsError = error as NSError
    let errorName = (nsError.userInfo[AuthErrors.userInfoNameKey] as? String) ?? ""
    return CapturedIosAuthError(
      domain: nsError.domain,
      code: nsError.code,
      errorName: errorName
    )
  }

  private static func requireNonEmpty(_ value: String?, field: String) throws -> String {
    guard let unwrapped = value, !unwrapped.isEmpty else {
      throw AuthOracleError.missingField(field)
    }
    return unwrapped
  }

  private static func isDecimalProjectNumber(_ text: String) -> Bool {
    guard !text.isEmpty, text.count <= 18 else { return false }
    return text.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
  }

  private static func isAsciiHex(_ text: String) -> Bool {
    guard !text.isEmpty else { return false }
    return text.unicodeScalars.allSatisfy { scalar in
      (scalar.value >= 48 && scalar.value <= 57)
        || (scalar.value >= 65 && scalar.value <= 70)
        || (scalar.value >= 97 && scalar.value <= 102)
    }
  }

  static func normalizeIosGoogleAppId(_ rawAppId: String, gcmSenderId: String) -> String {
    let trimmed = rawAppId.trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    if parts.count == 4, parts[0] == "1", isDecimalProjectNumber(parts[1]), isAsciiHex(parts[3]) {
      let lowerHex = parts[3].lowercased()
      if parts[2].lowercased() == "ios", lowerHex.count >= 1, lowerHex.count <= 16 {
        return "1:\(parts[1]):ios:\(lowerHex)"
      }
      let truncated = String(lowerHex.prefix(16))
      let padded = truncated + String(repeating: "0", count: max(0, 16 - truncated.count))
      return "1:\(parts[1]):ios:\(padded)"
    }
    if parts.count >= 2, parts[0] == "1", isDecimalProjectNumber(parts[1]) {
      return "1:\(parts[1]):ios:0000000000000000"
    }
    let trimmedSender = gcmSenderId.trimmingCharacters(in: .whitespacesAndNewlines)
    if isDecimalProjectNumber(trimmedSender) {
      return "1:\(trimmedSender):ios:0000000000000000"
    }
    return "1:000000000000:ios:0000000000000000"
  }

  static func deleteAppAsync(_ app: FirebaseApp) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      app.delete { _ in
        continuation.resume(returning: ())
      }
    }
  }

  private static func runAnonymousAndCustomTokenSession(
    auth: Auth,
    customToken: String,
    expectedCustomUid: String
  ) async throws -> [String: Any] {
    var cleanupUids: [String] = []

    if auth.currentUser != nil {
      try? auth.signOut()
    }

    let anonResult = try await auth.signInAnonymously()
    let anonUser = anonResult.user
    emitCleanupUid(anonUser.uid, into: &cleanupUids)
    let anonymousIsAnonymous = anonUser.isAnonymous
    let anonymousMatchesCurrent = auth.currentUser?.uid == anonUser.uid

    let customResult = try await auth.signIn(withCustomToken: customToken)
    let customUser = customResult.user
    emitCleanupUid(customUser.uid, into: &cleanupUids)
    let customUidMatchesExpected = customUser.uid == expectedCustomUid
    let customIsAnonymous = customUser.isAnonymous

    let tokenResult = try await customUser.getIDTokenResult(forcingRefresh: true)
    let roleClaim = tokenResult.claims["role"] as? String ?? ""
    let tierClaim = (tokenResult.claims["tier"] as? NSNumber)?.intValue ?? -1
    let signInProvider = tokenResult.signInProvider

    var invalidCustomTokenDomain = ""
    var invalidCustomTokenCode = -1
    var invalidCustomTokenErrorName = ""
    var invalidTokenRejected = false

    do {
      let unexpected = try await auth.signIn(withCustomToken: "not-a-valid-jwt")
      emitCleanupUid(unexpected.user.uid, into: &cleanupUids)
    } catch {
      invalidTokenRejected = true
      let captured = extractAuthError(error)
      invalidCustomTokenDomain = captured.domain
      invalidCustomTokenCode = captured.code
      invalidCustomTokenErrorName = captured.errorName
    }

    if !invalidTokenRejected {
      throw AuthOracleError.expectedInvalidTokenError
    }

    try auth.signOut()
    let currentUserNilAfterSignOut = auth.currentUser == nil

    return [
      "anonymousIsAnonymous": anonymousIsAnonymous,
      "anonymousMatchesCurrent": anonymousMatchesCurrent,
      "customUidMatchesExpected": customUidMatchesExpected,
      "customIsAnonymous": customIsAnonymous,
      "customClaimsRole": roleClaim,
      "customClaimsTier": tierClaim,
      "signInProvider": signInProvider,
      "invalidCustomTokenDomain": invalidCustomTokenDomain,
      "invalidCustomTokenMatchesEnum":
        invalidCustomTokenCode == AuthErrorCode.invalidCustomToken.rawValue,
      "invalidCustomTokenCode": invalidCustomTokenCode,
      "invalidCustomTokenErrorName": invalidCustomTokenErrorName,
      "currentUserNilAfterSignOut": currentUserNilAfterSignOut,
      "_cleanupUids": cleanupUids,
    ]
  }

  public static func run(inputData: Data) async throws -> Data {
    let input = try JSONDecoder().decode(AuthOracleInputConfig.self, from: inputData)
    if input.mode == "template" {
      let noopPayload: [String: Any] = ["mode": "template", "ok": true]
      return try JSONSerialization.data(withJSONObject: noopPayload, options: [.sortedKeys])
    }

    let probeId = try requireNonEmpty(input.probeId, field: "probeId")
    let runId = try requireNonEmpty(input.runId, field: "runId")
    let projectId = try requireNonEmpty(input.projectId, field: "projectId")
    let googleAppId = try requireNonEmpty(input.googleAppId, field: "googleAppId")
    let gcmSenderId = try requireNonEmpty(input.gcmSenderId, field: "gcmSenderId")
    let apiKey = try requireNonEmpty(input.apiKey, field: "apiKey")

    let appName = "pyric-ios-auth-\(runId)"
    let resolvedGoogleAppId = normalizeIosGoogleAppId(googleAppId, gcmSenderId: gcmSenderId)
    let options = FirebaseOptions(googleAppID: resolvedGoogleAppId, gcmSenderID: gcmSenderId)
    options.apiKey = apiKey
    options.projectID = projectId
    if (options.bundleID ?? "").isEmpty {
      options.bundleID = "dev.pyric.ios.oracle.auth"
    }

    FirebaseApp.configure(name: appName, options: options)
    guard let app = FirebaseApp.app(name: appName) else {
      throw AuthOracleError.appLookupFailed(appName)
    }

    let auth = Auth.auth(app: app)
    do {
      let behavior: [String: Any]
      switch probeId {
      case "auth-swift-anonymous-and-custom-token-session":
        let customToken = try requireNonEmpty(input.customToken, field: "customToken")
        let expectedUid = try requireNonEmpty(input.expectedCustomUid, field: "expectedCustomUid")
        behavior = try await runAnonymousAndCustomTokenSession(
          auth: auth,
          customToken: customToken,
          expectedCustomUid: expectedUid
        )
      case "auth-swift-email-password-and-error-codes":
        behavior = try await runEmailPasswordAndErrorCodes(auth: auth, runId: runId)
      case "auth-swift-profile-token-claims-and-delete-lifecycle":
        behavior = try await runProfileTokenClaimsAndDeleteLifecycle(auth: auth, runId: runId)
      case "auth-swift-instance-linking-reauth-and-oauth-credentials":
        behavior = try await runInstanceLinkingReauthAndOAuthCredentials(
          auth: auth,
          app: app,
          options: options,
          runId: runId
        )
      default:
        throw AuthOracleError.unknownProbe(probeId)
      }

      try? auth.signOut()
      await deleteAppAsync(app)

      guard JSONSerialization.isValidJSONObject(behavior) else {
        throw AuthOracleError.invalidJsonObject
      }
      return try JSONSerialization.data(
        withJSONObject: behavior,
        options: [.sortedKeys, .prettyPrinted]
      )
    } catch {
      try? auth.signOut()
      await deleteAppAsync(app)
      throw error
    }
  }
}
