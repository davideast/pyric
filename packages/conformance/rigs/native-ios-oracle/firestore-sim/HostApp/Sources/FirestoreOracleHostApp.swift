import Foundation
import PyricIosFirestoreOracle
import SwiftUI

public enum FirestoreOracleHostBridge {
  public static func run(inputData: Data) async throws -> Data {
    try await FirestoreOracleProbeRunner.run(inputData: inputData)
  }
}

@main
struct FirestoreOracleHostApp: App {
  var body: some Scene {
    WindowGroup {
      EmptyView()
    }
  }
}
