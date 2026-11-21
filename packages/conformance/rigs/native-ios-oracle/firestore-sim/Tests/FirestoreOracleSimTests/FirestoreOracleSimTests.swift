import Foundation
import PyricIosFirestoreOracle
import XCTest

final class FirestoreOracleSimTests: XCTestCase {
  func testCaptureSelectedOracleProbe() async throws {
    guard let inputURL = Bundle.module.url(forResource: "oracle-input", withExtension: "json") else {
      XCTFail("Missing bundled oracle-input.json resource in FirestoreOracleSimTests")
      return
    }
    let inputData = try Data(contentsOf: inputURL)
    let outputData = try await FirestoreOracleProbeRunner.run(inputData: inputData)
    print("PYRIC_IOS_ORACLE_RESULT_B64:\(outputData.base64EncodedString())")
    fflush(stdout)
  }
}
