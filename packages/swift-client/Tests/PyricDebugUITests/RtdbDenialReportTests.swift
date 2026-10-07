import Foundation
import Testing
@testable import PyricFirestore
@testable import PyricDebugUI

/// The envelope a denied sandbox RTDB write sends over the bridge, captured by
/// `packages/cli/scripts/capture-rtdb-denial-envelope.ts`.
private func capturedEnvelope() throws -> AnySendable {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/rtdb-denial-envelope.json")
    return try JSONDecoder().decode(AnySendable.self, from: Data(contentsOf: url))
}

@Suite("RTDB Rules Denial Report")
struct RtdbDenialReportTests {

    @Test("Parses the engine and the RTDB rule fields from a captured envelope")
    func parsesCapturedEnvelope() throws {
        let envelope = try capturedEnvelope()
        let error = PyricBridgeError.fromCode(
            code: envelope["code"]?.stringValue ?? "",
            message: envelope["message"]?.stringValue ?? "",
            denialContext: envelope["denialContext"]
        )
        let report = try #require(RulesDenialReport.from(error: error))

        #expect(report.engine == "rtdb")
        #expect(report.isRtdb)
        #expect(report.file == "database.rules.json")
        #expect(report.matchedPath == "/rooms/$roomId")
        #expect(report.matchedRule == "auth.uid == $roomId || auth.token.role == 'editor'")
        #expect(report.expression == report.matchedRule)
        #expect(report.citation == "database.rules.json /rooms/$roomId")
        #expect(report.pathVariableBindings == ["$roomId": "bob"])
        #expect(report.reason?.contains("evaluated to false") == true)
        #expect(report.errorCode == nil)
        #expect(report.requestMethod == "set")
        #expect(report.requestPath == "/rooms/bob/title")
        #expect(report.proposedValue == .dictionary(["text": .string("Renamed"), "by": .string("alice")]))
        #expect(report.proposedData?["text"] == .string("Renamed"))
        #expect(report.authUid == "alice")
        #expect(report.authTenant == "tenant-a")
        #expect(report.reasons.count == 1)
        #expect(report.errorMessage == "PERMISSION_DENIED: Permission denied")
    }

    @Test("A denial context without an engine is a Firestore denial")
    func defaultsToFirestore() {
        let report = RulesDenialReport.from(denialContext: .dictionary(["reasons": .array([.string("denied")])]))
        #expect(report.engine == "firestore")
        #expect(!report.isRtdb)
        #expect(report.file == "firestore.rules")
        #expect(report.matchedPath == nil)
    }
}
