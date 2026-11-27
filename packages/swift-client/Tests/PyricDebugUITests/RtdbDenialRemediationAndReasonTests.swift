import Testing
import PyricDebugUI
import PyricFirestore

@Suite("RTDB Denial Reason & Remediation Parsing Tests")
struct RtdbDenialRemediationAndReasonTests {
    @Test("RulesDenialReport.from falls back to singular reason and captures remediation")
    func fallsBackToSingularReasonAndCapturesRemediation() {
        let context: AnySendable = .dictionary([
            "engine": .string("rtdb"),
            "matchedPath": .string("/rooms/$roomId/score"),
            "pathVariableBindings": .dictionary(["$roomId": .string("bob")]),
            "reason": .string("NO_MATCHING_RULE"),
            "remediation": .string("Allow writes for room members."),
            "request": .dictionary([
                "method": .string("set"),
                "path": .string("/rooms/bob/score"),
                "data": .int(42),
            ]),
        ])
        let report = RulesDenialReport.from(denialContext: context, message: "Permission denied")
        #expect(report.isRtdb)
        #expect(report.file == "database.rules.json")
        #expect(report.reasons == ["NO_MATCHING_RULE"])
        #expect(report.reason == "NO_MATCHING_RULE")
        #expect(report.remediation == "Allow writes for room members.")
        #expect(report.pathVariableBindings == ["$roomId": "bob"])
        #expect(report.proposedValue == .int(42))
    }
}
