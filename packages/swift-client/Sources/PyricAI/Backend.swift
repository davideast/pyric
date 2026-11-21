import Foundation

/// Represents available backend APIs for the Firebase AI Logic SDK (`PyricAI`),
/// mirroring `FirebaseAILogic` (`13.2.0`).
public struct Backend: Sendable, Hashable, Equatable {
    /// Backend service family targeted by a `FirebaseAI` instance.
    public enum Kind: String, Sendable, Hashable, Equatable {
        case googleAI
        case vertexAI
    }

    /// Active backend service family.
    public let kind: Kind

    /// Configured region when targeting Vertex AI / Agent Platform (`nil` for Google AI).
    public let location: String?

    package init(kind: Kind, location: String?) {
        self.kind = kind
        self.location = location
    }

    /// Initializes a `Backend` configured for the Gemini Developer API (Google AI).
    public static func googleAI() -> Backend {
        Backend(kind: .googleAI, location: nil)
    }

    /// Initializes a `Backend` configured for the Vertex AI Gemini API.
    ///
    /// - Parameter location: Google Cloud region identifier, defaulting to `"us-central1"`.
    public static func vertexAI(location: String = "us-central1") -> Backend {
        let trimmed = location.trimmingCharacters(in: .whitespacesAndNewlines)
        precondition(
            !trimmed.isEmpty && !trimmed.contains("/"),
            "Invalid Vertex AI location \"\(location)\"."
        )
        return Backend(kind: .vertexAI, location: trimmed)
    }

    /// Initializes a `Backend` configured for the Agent Platform Gemini API (`FirebaseAILogic 13.2.0` alias).
    ///
    /// - Parameter location: Region identifier, defaulting to `"global"`.
    public static func agentPlatform(location: String = "global") -> Backend {
        let trimmed = location.trimmingCharacters(in: .whitespacesAndNewlines)
        precondition(
            !trimmed.isEmpty && !trimmed.contains("/"),
            "Invalid Agent Platform location \"\(location)\"."
        )
        return Backend(kind: .vertexAI, location: trimmed)
    }

    /// Normalizes a user-supplied `modelName` into the canonical Gemini resource path expected by `AiBroker`.
    package func normalizedModelResourceName(for modelName: String) -> String {
        let trimmed = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        precondition(
            !trimmed.isEmpty && trimmed.allSatisfy({ !$0.isWhitespace && !$0.isNewline }),
            "Invalid model name \"\(modelName)\"; model name must not be empty or contain whitespace."
        )
        switch kind {
        case .googleAI:
            if trimmed.hasPrefix("models/") {
                return trimmed
            }
            return "models/\(trimmed)"
        case .vertexAI:
            if trimmed.contains("/") {
                if trimmed.hasPrefix("models/") {
                    return "publishers/google/\(trimmed)"
                }
                return trimmed
            }
            return "publishers/google/models/\(trimmed)"
        }
    }
}

/// Configuration parameters for sending requests to the AI backend.
public struct RequestOptions: Sendable, Hashable, Equatable {
    /// Request timeout interval in seconds; defaults to `180.0`.
    public let timeout: TimeInterval

    public init(timeout: TimeInterval = 180.0) {
        self.timeout = timeout
    }
}

/// Optional Pyric sandbox answer-engine configuration carried on the first bridge AI call.
public enum PyricAIEngineConfig: Sendable, Equatable {
    case scripted(script: [JSONObject]? = nil)
    case openai(baseUrl: String? = nil, model: String? = nil, modelMap: [String: String]? = nil)
    case gemini(baseUrl: String? = nil, apiKey: String? = nil)
}
