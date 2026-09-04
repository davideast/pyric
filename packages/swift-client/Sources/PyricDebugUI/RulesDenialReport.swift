import Foundation
import PyricFirestore

/// Structured representation of a Security Rules evaluation rejection (CEL denial).
public struct RulesDenialReport: Identifiable, Sendable, Equatable {
    public let id: UUID
    public let timestamp: Date
    public let file: String
    public let line: Int?
    public let col: Int?
    public let citation: String
    public let expression: String?
    public let reasons: [String]
    public let authUid: String?
    public let authTenant: String?
    public let authClaims: [String: AnySendable]?
    public let requestMethod: String?
    public let requestPath: String?
    public let proposedData: [String: AnySendable]?
    public let existingData: [String: AnySendable]?
    public let failedFields: [String]
    public let query: AnySendable?
    public let errorMessage: String

    public init(
        id: UUID = UUID(),
        timestamp: Date = Date(),
        file: String = "firestore.rules",
        line: Int? = nil,
        col: Int? = nil,
        citation: String? = nil,
        expression: String? = nil,
        reasons: [String] = [],
        authUid: String? = nil,
        authTenant: String? = nil,
        authClaims: [String: AnySendable]? = nil,
        requestMethod: String? = nil,
        requestPath: String? = nil,
        proposedData: [String: AnySendable]? = nil,
        existingData: [String: AnySendable]? = nil,
        failedFields: [String] = [],
        query: AnySendable? = nil,
        errorMessage: String = "Missing or insufficient permissions."
    ) {
        self.id = id
        self.timestamp = timestamp
        self.file = file
        self.line = line
        self.col = col
        if let citation, !citation.isEmpty {
            self.citation = citation
        } else if let line {
            if let col {
                self.citation = "\(file):\(line):\(col)"
            } else {
                self.citation = "\(file):\(line)"
            }
        } else {
            self.citation = file
        }
        self.expression = expression
        self.reasons = reasons
        self.authUid = authUid
        self.authTenant = authTenant
        self.authClaims = authClaims
        self.requestMethod = requestMethod
        self.requestPath = requestPath
        self.proposedData = proposedData
        self.existingData = existingData
        self.failedFields = failedFields
        self.query = query
        self.errorMessage = errorMessage
    }

    /// Constructs a `RulesDenialReport` from raw wire `denialContext` payload and error message.
    public static func from(denialContext: AnySendable, message: String = "Missing or insufficient permissions.") -> RulesDenialReport {
        let ruleObj = denialContext["rule"]
        let rawFile = ruleObj?["file"]?.stringValue ?? "firestore.rules"
        let line = ruleObj?["line"]?.intValue.map { Int($0) }
        let col = (ruleObj?["col"]?.intValue ?? ruleObj?["column"]?.intValue).map { Int($0) }
        let citation = ruleObj?["citation"]?.stringValue
        let expression = ruleObj?["expression"]?.stringValue

        var reasons: [String] = []
        if let reasonsArray = denialContext["reasons"]?.arrayValue {
            reasons = reasonsArray.compactMap { $0.stringValue }
        }
        if reasons.isEmpty {
            reasons = [message]
        }

        let authObj = denialContext["auth"]
        let authUid = authObj?["uid"]?.stringValue
        let authClaims = authObj?["token"]?.dictionaryValue
        let authTenant = authObj?["token"]?["firebase"]?["tenant"]?.stringValue

        let reqObj = denialContext["request"]
        let reqMethod = reqObj?["method"]?.stringValue
        let reqPath = reqObj?["path"]?.stringValue
        let proposedData = reqObj?["resourceData"]?.dictionaryValue

        let resObj = denialContext["resource"]
        let existingData = resObj?["data"]?.dictionaryValue

        var failedFields: [String] = []
        if let fieldsArray = denialContext["failedFields"]?.arrayValue {
            failedFields = fieldsArray.compactMap { $0.stringValue }
        }

        let query = denialContext["query"]

        return RulesDenialReport(
            file: rawFile,
            line: line,
            col: col,
            citation: citation,
            expression: expression,
            reasons: reasons,
            authUid: authUid,
            authTenant: authTenant,
            authClaims: authClaims,
            requestMethod: reqMethod,
            requestPath: reqPath,
            proposedData: proposedData,
            existingData: existingData,
            failedFields: failedFields,
            query: query,
            errorMessage: message
        )
    }

    /// Extracts a `RulesDenialReport` from a `PyricBridgeError` if it carries a `denialContext`.
    public static func from(error: PyricBridgeError) -> RulesDenialReport? {
        guard let denialContext = error.denialContext else { return nil }
        return from(denialContext: denialContext, message: error.message)
    }
}
