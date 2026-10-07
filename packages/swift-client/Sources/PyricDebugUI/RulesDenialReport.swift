import Foundation
import PyricFirestore

/// Structured representation of a Security Rules denial.
///
/// `engine` names the rules engine: `"firestore"` (the default when a denial
/// context names none) or `"rtdb"`. An RTDB denial carries the deciding rules
/// node (`matchedPath`), its expression (`matchedRule`), the `$` wildcard
/// bindings, and the proposed value (`proposedValue`) in place of a line citation.
public struct RulesDenialReport: Identifiable, Sendable, Equatable {
    public let id: UUID
    public let timestamp: Date
    public let engine: String
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
    public let matchedPath: String?
    public let matchedRule: String?
    public let pathVariableBindings: [String: String]?
    public let reason: String?
    public let errorCode: String?
    public let proposedValue: AnySendable?
    public let errorMessage: String

    public var isRtdb: Bool { engine == "rtdb" }

    public init(
        id: UUID = UUID(),
        timestamp: Date = Date(),
        engine: String = "firestore",
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
        matchedPath: String? = nil,
        matchedRule: String? = nil,
        pathVariableBindings: [String: String]? = nil,
        reason: String? = nil,
        errorCode: String? = nil,
        proposedValue: AnySendable? = nil,
        errorMessage: String = "Missing or insufficient permissions."
    ) {
        self.id = id
        self.timestamp = timestamp
        self.engine = engine
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
        } else if let matchedPath {
            self.citation = "\(file) \(matchedPath)"
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
        self.matchedPath = matchedPath
        self.matchedRule = matchedRule
        self.pathVariableBindings = pathVariableBindings
        self.reason = reason
        self.errorCode = errorCode
        self.proposedValue = proposedValue
        self.errorMessage = errorMessage
    }

    /// Constructs a `RulesDenialReport` from raw wire `denialContext` payload and error message.
    public static func from(denialContext: AnySendable, message: String = "Missing or insufficient permissions.") -> RulesDenialReport {
        let engine = denialContext["engine"]?.stringValue ?? "firestore"
        let isRtdb = engine == "rtdb"
        let matchedRule = denialContext["matchedRule"]?.stringValue

        let ruleObj = denialContext["rule"]
        let rawFile = ruleObj?["file"]?.stringValue ?? (isRtdb ? "database.rules.json" : "firestore.rules")
        let line = ruleObj?["line"]?.intValue.map { Int($0) }
        let col = (ruleObj?["col"]?.intValue ?? ruleObj?["column"]?.intValue).map { Int($0) }
        let citation = ruleObj?["citation"]?.stringValue
        let expression = ruleObj?["expression"]?.stringValue ?? matchedRule

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
            ?? authObj?["tenant"]?.stringValue

        let reqObj = denialContext["request"]
        let reqMethod = reqObj?["method"]?.stringValue
        let reqPath = reqObj?["path"]?.stringValue
        // RTDB writes may propose any JSON value, so the raw value is kept too.
        let proposedValue = isRtdb ? reqObj?["data"] : reqObj?["resourceData"]
        let proposedData = proposedValue?.dictionaryValue

        let resObj = denialContext["resource"]
        let existingData = resObj?["data"]?.dictionaryValue

        var failedFields: [String] = []
        if let fieldsArray = denialContext["failedFields"]?.arrayValue {
            failedFields = fieldsArray.compactMap { $0.stringValue }
        }

        let query = denialContext["query"]

        let bindings = denialContext["pathVariableBindings"]?.dictionaryValue?
            .compactMapValues { $0.stringValue }

        return RulesDenialReport(
            engine: engine,
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
            matchedPath: denialContext["matchedPath"]?.stringValue,
            matchedRule: matchedRule,
            pathVariableBindings: bindings,
            reason: denialContext["reason"]?.stringValue,
            errorCode: denialContext["errorCode"]?.stringValue,
            proposedValue: proposedValue,
            errorMessage: message
        )
    }

    /// Extracts a `RulesDenialReport` from a `PyricBridgeError` if it carries a `denialContext`.
    public static func from(error: PyricBridgeError) -> RulesDenialReport? {
        guard let denialContext = error.denialContext else { return nil }
        return from(denialContext: denialContext, message: error.message)
    }
}
