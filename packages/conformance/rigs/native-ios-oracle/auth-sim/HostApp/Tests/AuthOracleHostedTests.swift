import AuthOracleHost
import Foundation
import XCTest

final class AuthOracleHostedTests: XCTestCase {
  func testCaptureSelectedOracleProbe() async throws {
    let candidateBundles = [Bundle.main, Bundle(for: AuthOracleHostedTests.self)]
    var resolvedURL: URL?
    for bundle in candidateBundles {
      if let found = bundle.url(forResource: "oracle-input", withExtension: "json") {
        resolvedURL = found
        break
      }
    }
    guard let inputURL = resolvedURL else {
      XCTFail("Missing bundled oracle-input.json resource in AuthOracleHost")
      return
    }
    let inputData = try Data(contentsOf: inputURL)
    let outputData = try await AuthOracleHostBridge.run(inputData: inputData)
    print("PYRIC_IOS_ORACLE_RESULT_B64:\(outputData.base64EncodedString())")
    fflush(stdout)
  }
}
