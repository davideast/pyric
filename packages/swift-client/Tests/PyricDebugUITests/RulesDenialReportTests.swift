import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth
@testable import PyricDebugUI

@Suite("Rules Denial Report & User Model Tests")
struct RulesDenialReportTests {

    @Test("Parses canonical CEL denial context into RulesDenialReport")
    func testParseCanonicalDenialContext() {
        let rawContext: [String: Any] = [
            "rule": [
                "file": "firestore.rules",
                "line": 14,
                "col": 7,
                "citation": "firestore.rules:14:7",
                "expression": "allow read: if request.auth.uid == resource.data.ownerId;"
            ],
            "reasons": [
                "Evaluation error: false",
                "request.auth.uid is 'alice'",
                "resource.data.ownerId is 'bob'"
            ],
            "auth": [
                "uid": "alice",
                "token": [
                    "email": "alice@example.com",
                    "firebase": ["tenant": "tenant-saas"],
                    "role": "editor"
                ]
            ],
            "request": [
                "method": "get",
                "path": "databases/(default)/documents/posts/1",
                "resourceData": [
                    "title": "New Title",
                    "ownerId": "alice"
                ]
            ],
            "resource": [
                "exists": true,
                "data": [
                    "title": "Old Title",
                    "ownerId": "bob"
                ]
            ],
            "failedFields": ["ownerId"],
            "query": [
                "limit": 20
            ]
        ]

        let denialContext = AnySendable.from(rawContext)
        let report = RulesDenialReport.from(denialContext: denialContext, message: "Permission denied")

        #expect(report.file == "firestore.rules")
        #expect(report.line == 14)
        #expect(report.col == 7)
        #expect(report.citation == "firestore.rules:14:7")
        #expect(report.expression == "allow read: if request.auth.uid == resource.data.ownerId;")
        #expect(report.reasons.count == 3)
        #expect(report.reasons[1] == "request.auth.uid is 'alice'")
        #expect(report.authUid == "alice")
        #expect(report.authTenant == "tenant-saas")
        #expect(report.authClaims?["role"]?.stringValue == "editor")
        #expect(report.requestMethod == "get")
        #expect(report.requestPath == "databases/(default)/documents/posts/1")
        #expect(report.proposedData?["title"]?.stringValue == "New Title")
        #expect(report.existingData?["ownerId"]?.stringValue == "bob")
        #expect(report.failedFields == ["ownerId"])
        #expect(report.query?["limit"]?.intValue == 20)
        #expect(report.errorMessage == "Permission denied")
    }

    @Test("Gracefully falls back when citation is missing and constructs file:line:col")
    func testFallbackCitationConstruction() {
        let rawContext: [String: Any] = [
            "rule": [
                "file": "custom.rules",
                "line": 42,
                "col": 5,
                "expression": "allow write: if false;"
            ],
            "reasons": []
        ]
        let denialContext = AnySendable.from(rawContext)
        let report = RulesDenialReport.from(denialContext: denialContext, message: "Missing permissions")

        #expect(report.file == "custom.rules")
        #expect(report.line == 42)
        #expect(report.col == 5)
        #expect(report.citation == "custom.rules:42:5")
        #expect(report.expression == "allow write: if false;")
        #expect(report.reasons == ["Missing permissions"])
    }

    @Test("Extracts RulesDenialReport directly from PyricBridgeError with denialContext")
    func testFromPyricBridgeError() {
        let rawContext: [String: Any] = [
            "rule": [
                "file": "firestore.rules",
                "line": 10,
                "col": 2,
                "citation": "firestore.rules:10:2"
            ],
            "reasons": ["Rule denied"]
        ]
        let error = PyricBridgeError.fromCode(
            code: "permission-denied",
            message: "Denied by rules",
            denialContext: AnySendable.from(rawContext)
        )

        let report = RulesDenialReport.from(error: error)
        #expect(report != nil)
        #expect(report?.citation == "firestore.rules:10:2")
        #expect(report?.errorMessage == "Denied by rules")
    }

    @Test("Parses SandboxUserRecord from wire dictionary")
    func testParseSandboxUserRecord() {
        let wire: [String: Any] = [
            "uid": "user-42",
            "email": "user42@example.com",
            "displayName": "User Forty Two",
            "photoURL": "https://example.com/photo.png",
            "tenantId": "tenant-enterprise",
            "customClaims": [
                "admin": true,
                "role": "lead"
            ]
        ]
        let record = SandboxUserRecord.fromWire(AnySendable.from(wire))
        #expect(record != nil)
        #expect(record?.uid == "user-42")
        #expect(record?.id == "user-42")
        #expect(record?.email == "user42@example.com")
        #expect(record?.displayName == "User Forty Two")
        #expect(record?.photoURL == "https://example.com/photo.png")
        #expect(record?.tenantId == "tenant-enterprise")
        #expect(record?.customClaims["admin"]?.boolValue == true)
        #expect(record?.customClaims["role"]?.stringValue == "lead")
    }
}
