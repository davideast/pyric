import Foundation
#if canImport(CoreLocation)
import CoreLocation
#endif

// MARK: - Function Calling & Grounding Tools

/// Structured declaration of a client-executed function exposed to a `GenerativeModel`.
public struct FunctionDeclaration: Sendable, Equatable, Encodable {
    public let name: String
    public let description: String
    public let parameters: Schema?

    public init(
        name: String,
        description: String,
        parameters: [String: Schema],
        optionalParameters: [String] = []
    ) {
        self.name = name
        self.description = description
        self.parameters = Schema.object(
            properties: parameters,
            optionalProperties: optionalParameters,
            nullable: false
        )
    }

    enum CodingKeys: String, CodingKey {
        case name
        case description
        case parameters
    }
}

/// Enables Grounding with Google Search.
public struct GoogleSearch: Sendable, Equatable, Encodable {
    public init() {}
}

/// Enables Grounding with Google Maps.
public struct GoogleMaps: Sendable, Equatable, Encodable {
    public let enableWidget: Bool?

    public init(enableWidget: Bool? = nil) {
        self.enableWidget = enableWidget
    }
}

/// Enables server-side Python code execution.
public struct CodeExecution: Sendable, Equatable, Encodable {
    public init() {}
}

/// Enables URL context grounding.
public struct URLContext: Sendable, Equatable, Encodable {
    public init() {}
}

/// Tool definition passed to `FirebaseAI.generativeModel(...)` (`GenerativeModel.Tool`).
public struct Tool: Sendable, Equatable, Encodable {
    public let functionDeclarations: [FunctionDeclaration]?
    public let googleSearch: GoogleSearch?
    public let googleMaps: GoogleMaps?
    public let urlContext: URLContext?
    public let codeExecution: CodeExecution?

    package init(
        functionDeclarations: [FunctionDeclaration]? = nil,
        googleSearch: GoogleSearch? = nil,
        googleMaps: GoogleMaps? = nil,
        urlContext: URLContext? = nil,
        codeExecution: CodeExecution? = nil
    ) {
        self.functionDeclarations = functionDeclarations
        self.googleSearch = googleSearch
        self.googleMaps = googleMaps
        self.urlContext = urlContext
        self.codeExecution = codeExecution
    }

    public static func functionDeclarations(_ functionDeclarations: [FunctionDeclaration]) -> Tool {
        Tool(functionDeclarations: functionDeclarations)
    }

    public static func googleSearch(_ googleSearch: GoogleSearch = GoogleSearch()) -> Tool {
        Tool(googleSearch: googleSearch)
    }

    public static func googleMaps(enableWidget: Bool? = nil) -> Tool {
        Tool(googleMaps: GoogleMaps(enableWidget: enableWidget))
    }

    public static func urlContext() -> Tool {
        Tool(urlContext: URLContext())
    }

    public static func codeExecution() -> Tool {
        Tool(codeExecution: CodeExecution())
    }
}

/// Execution mode and allowed-function constraints for function calling.
public struct FunctionCallingConfig: Sendable, Equatable, Encodable {
    public enum Mode: String, Sendable, Equatable, Encodable {
        case auto = "AUTO"
        case any = "ANY"
        case none = "NONE"
    }

    public let mode: Mode?
    public let allowedFunctionNames: [String]?

    package init(mode: Mode? = nil, allowedFunctionNames: [String]? = nil) {
        self.mode = mode
        self.allowedFunctionNames = allowedFunctionNames
    }

    public static func auto() -> FunctionCallingConfig {
        FunctionCallingConfig(mode: .auto)
    }

    public static func any(allowedFunctionNames: [String]? = nil) -> FunctionCallingConfig {
        FunctionCallingConfig(mode: .any, allowedFunctionNames: allowedFunctionNames)
    }

    public static func none() -> FunctionCallingConfig {
        FunctionCallingConfig(mode: Mode.none)
    }
}

/// Cross-platform latitude/longitude coordinate for grounding `RetrievalConfig`.
public struct RetrievalLocation: Sendable, Equatable, Hashable, Encodable {
    public let latitude: Double
    public let longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}

/// Configuration for grounding retrieval tools.
public struct RetrievalConfig: Sendable, Equatable, Encodable {
    public let location: RetrievalLocation?
    public let languageCode: String?

    public init(location: RetrievalLocation? = nil, languageCode: String? = nil) {
        self.location = location
        self.languageCode = languageCode
    }

    #if canImport(CoreLocation)
    public init(location: CLLocationCoordinate2D, languageCode: String? = nil) {
        self.location = RetrievalLocation(latitude: location.latitude, longitude: location.longitude)
        self.languageCode = languageCode
    }
    #endif

    enum CodingKeys: String, CodingKey {
        case location = "latLng"
        case languageCode
    }
}

/// Tool configuration for any `Tool` specified on a model or request.
public struct ToolConfig: Sendable, Equatable, Encodable {
    public let functionCallingConfig: FunctionCallingConfig?
    public let retrievalConfig: RetrievalConfig?

    public init(
        functionCallingConfig: FunctionCallingConfig? = nil,
        retrievalConfig: RetrievalConfig? = nil
    ) {
        self.functionCallingConfig = functionCallingConfig
        self.retrievalConfig = retrievalConfig
    }
}

// MARK: - Safety Categories, Ratings, and Thresholds

/// Categories describing potential harm a piece of content may pose.
public struct HarmCategory: Sendable, Hashable, Equatable, Codable {
    public static let unspecified = HarmCategory(rawValue: "HARM_CATEGORY_UNSPECIFIED")
    public static let harassment = HarmCategory(rawValue: "HARM_CATEGORY_HARASSMENT")
    public static let hateSpeech = HarmCategory(rawValue: "HARM_CATEGORY_HATE_SPEECH")
    public static let sexuallyExplicit = HarmCategory(rawValue: "HARM_CATEGORY_SEXUALLY_EXPLICIT")
    public static let dangerousContent = HarmCategory(rawValue: "HARM_CATEGORY_DANGEROUS_CONTENT")
    public static let civicIntegrity = HarmCategory(rawValue: "HARM_CATEGORY_CIVIC_INTEGRITY")

    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.rawValue = try container.decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Model-assigned harm rating for a candidate or prompt.
public struct SafetyRating: Sendable, Hashable, Equatable, Decodable {
    public struct HarmProbability: Sendable, Hashable, Equatable, Codable {
        public static let unspecified = HarmProbability(rawValue: "HARM_PROBABILITY_UNSPECIFIED")
        public static let negligible = HarmProbability(rawValue: "NEGLIGIBLE")
        public static let low = HarmProbability(rawValue: "LOW")
        public static let medium = HarmProbability(rawValue: "MEDIUM")
        public static let high = HarmProbability(rawValue: "HIGH")

        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            self.rawValue = try container.decode(String.self)
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public struct HarmSeverity: Sendable, Hashable, Equatable, Codable {
        public static let unspecified = HarmSeverity(rawValue: "HARM_SEVERITY_UNSPECIFIED")
        public static let negligible = HarmSeverity(rawValue: "HARM_SEVERITY_NEGLIGIBLE")
        public static let low = HarmSeverity(rawValue: "HARM_SEVERITY_LOW")
        public static let medium = HarmSeverity(rawValue: "HARM_SEVERITY_MEDIUM")
        public static let high = HarmSeverity(rawValue: "HARM_SEVERITY_HIGH")

        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            self.rawValue = try container.decode(String.self)
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public let category: HarmCategory
    public let probability: HarmProbability
    public let probabilityScore: Float
    public let severity: HarmSeverity
    public let severityScore: Float
    public let blocked: Bool

    public init(
        category: HarmCategory,
        probability: HarmProbability,
        probabilityScore: Float = 0.0,
        severity: HarmSeverity = .unspecified,
        severityScore: Float = 0.0,
        blocked: Bool = false
    ) {
        self.category = category
        self.probability = probability
        self.probabilityScore = probabilityScore
        self.severity = severity
        self.severityScore = severityScore
        self.blocked = blocked
    }

    enum CodingKeys: String, CodingKey {
        case category
        case probability
        case probabilityScore
        case severity
        case severityScore
        case blocked
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.category = try container.decodeIfPresent(HarmCategory.self, forKey: .category) ?? .unspecified
        self.probability = try container.decodeIfPresent(HarmProbability.self, forKey: .probability) ?? .unspecified
        self.probabilityScore = try container.decodeIfPresent(Float.self, forKey: .probabilityScore) ?? 0.0
        self.severity = try container.decodeIfPresent(HarmSeverity.self, forKey: .severity) ?? .unspecified
        self.severityScore = try container.decodeIfPresent(Float.self, forKey: .severityScore) ?? 0.0
        self.blocked = try container.decodeIfPresent(Bool.self, forKey: .blocked) ?? false
    }
}

/// Threshold configuration controlling which harmful content categories are blocked.
public struct SafetySetting: Sendable, Hashable, Equatable, Encodable {
    public struct HarmBlockThreshold: Sendable, Hashable, Equatable, Encodable {
        public static let blockLowAndAbove = HarmBlockThreshold(rawValue: "BLOCK_LOW_AND_ABOVE")
        public static let blockMediumAndAbove = HarmBlockThreshold(rawValue: "BLOCK_MEDIUM_AND_ABOVE")
        public static let blockOnlyHigh = HarmBlockThreshold(rawValue: "BLOCK_ONLY_HIGH")
        public static let blockNone = HarmBlockThreshold(rawValue: "BLOCK_NONE")
        public static let off = HarmBlockThreshold(rawValue: "OFF")

        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public struct HarmBlockMethod: Sendable, Hashable, Equatable, Encodable {
        public static let severity = HarmBlockMethod(rawValue: "SEVERITY")
        public static let probability = HarmBlockMethod(rawValue: "PROBABILITY")

        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public let harmCategory: HarmCategory
    public let threshold: HarmBlockThreshold
    public let method: HarmBlockMethod?

    public init(
        harmCategory: HarmCategory,
        threshold: HarmBlockThreshold,
        method: HarmBlockMethod? = nil
    ) {
        self.harmCategory = harmCategory
        self.threshold = threshold
        self.method = method
    }

    enum CodingKeys: String, CodingKey {
        case harmCategory = "category"
        case threshold
        case method
    }
}
