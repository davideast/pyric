import Foundation
import PyricIosAuthOracle
import SwiftUI

public enum AuthOracleHostBridge {
  public static func run(inputData: Data) async throws -> Data {
    try await AuthOracleProbeRunner.run(inputData: inputData)
  }
}

@main
struct AuthOracleHostApp: App {
  var body: some Scene {
    WindowGroup {
      EmptyView()
    }
  }
}
