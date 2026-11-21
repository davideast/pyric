import Foundation

// MARK: - Token Modality & CountTokensResponse

/// Content part modality reported in token-counting metadata.
public struct ContentModality: Sendable, Hashable, Equatable, Codable {
    public static let unspecified = ContentModality(rawValue: "MODALITY_UNSPECIFIED")
    public static let text = ContentModality(rawValue: "TEXT")
    public static let image = ContentModality(rawValue: "IMAGE")
    public static let video = ContentModality(rawValue: "VIDEO")
    public static let audio = ContentModality(rawValue: "AUDIO")
    public static let document = ContentModality(rawValue: "DOCUMENT")

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

/// Token count attributed to a single `ContentModality`.
public struct ModalityTokenCount: Sendable, Equatable, Hashable, Decodable {
    public let modality: ContentModality
    public let tokenCount: Int

    public init(modality: ContentModality, tokenCount: Int) {
        self.modality = modality
        self.tokenCount = tokenCount
    }

    enum CodingKeys: String, CodingKey {
        case modality
        case tokenCount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.modality = try container.decodeIfPresent(ContentModality.self, forKey: .modality) ?? .unspecified
        self.tokenCount = try container.decodeIfPresent(Int.self, forKey: .tokenCount) ?? 0
    }
}

/// Response returned by `GenerativeModel.countTokens(...)`.
public struct CountTokensResponse: Sendable, Equatable, Decodable {
    public let totalTokens: Int
    public let totalBillableCharacters: Int?
    public let promptTokensDetails: [ModalityTokenCount]

    public init(
        totalTokens: Int,
        totalBillableCharacters: Int? = nil,
        promptTokensDetails: [ModalityTokenCount] = []
    ) {
        self.totalTokens = totalTokens
        self.totalBillableCharacters = totalBillableCharacters
        self.promptTokensDetails = promptTokensDetails
    }

    enum CodingKeys: String, CodingKey {
        case totalTokens
        case totalBillableCharacters
        case promptTokensDetails
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.totalTokens = try container.decodeIfPresent(Int.self, forKey: .totalTokens) ?? 0
        self.totalBillableCharacters = try container.decodeIfPresent(Int.self, forKey: .totalBillableCharacters)
        self.promptTokensDetails = try container.decodeIfPresent(
            [ModalityTokenCount].self,
            forKey: .promptTokensDetails
        ) ?? []
    }
}

// MARK: - FinishReason & PromptFeedback

/// Reason why a model stopped generating tokens for a `Candidate`.
public struct FinishReason: Sendable, Hashable, Equatable, Codable {
    public static let stop = FinishReason(rawValue: "STOP")
    public static let maxTokens = FinishReason(rawValue: "MAX_TOKENS")
    public static let safety = FinishReason(rawValue: "SAFETY")
    public static let recitation = FinishReason(rawValue: "RECITATION")
    public static let other = FinishReason(rawValue: "OTHER")
    public static let blocklist = FinishReason(rawValue: "BLOCKLIST")
    public static let prohibitedContent = FinishReason(rawValue: "PROHIBITED_CONTENT")
    public static let spii = FinishReason(rawValue: "SPII")
    public static let malformedFunctionCall = FinishReason(rawValue: "MALFORMED_FUNCTION_CALL")
    public static let imageSafety = FinishReason(rawValue: "IMAGE_SAFETY")
    public static let imageProhibitedContent = FinishReason(rawValue: "IMAGE_PROHIBITED_CONTENT")
    public static let imageOther = FinishReason(rawValue: "IMAGE_OTHER")
    public static let noImage = FinishReason(rawValue: "NO_IMAGE")
    public static let imageRecitation = FinishReason(rawValue: "IMAGE_RECITATION")
    public static let language = FinishReason(rawValue: "LANGUAGE")
    public static let unexpectedToolCall = FinishReason(rawValue: "UNEXPECTED_TOOL_CALL")
    public static let tooManyToolCalls = FinishReason(rawValue: "TOO_MANY_TOOL_CALLS")
    public static let missingThoughtSignature = FinishReason(rawValue: "MISSING_THOUGHT_SIGNATURE")
    public static let malformedResponse = FinishReason(rawValue: "MALFORMED_RESPONSE")

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

/// Prompt-level safety feedback and refusal reason.
public struct PromptFeedback: Sendable, Equatable, Decodable {
    public struct BlockReason: Sendable, Hashable, Equatable, Codable {
        public static let safety = BlockReason(rawValue: "SAFETY")
        public static let other = BlockReason(rawValue: "OTHER")
        public static let blocklist = BlockReason(rawValue: "BLOCKLIST")
        public static let prohibitedContent = BlockReason(rawValue: "PROHIBITED_CONTENT")

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

    public let blockReason: BlockReason?
    public let blockReasonMessage: String?
    public let safetyRatings: [SafetyRating]

    public init(
        blockReason: BlockReason?,
        blockReasonMessage: String? = nil,
        safetyRatings: [SafetyRating] = []
    ) {
        self.blockReason = blockReason
        self.blockReasonMessage = blockReasonMessage
        self.safetyRatings = safetyRatings
    }

    enum CodingKeys: String, CodingKey {
        case blockReason
        case blockReasonMessage
        case safetyRatings
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.blockReason = try container.decodeIfPresent(BlockReason.self, forKey: .blockReason)
        self.blockReasonMessage = try container.decodeIfPresent(String.self, forKey: .blockReasonMessage)
        self.safetyRatings = try container.decodeIfPresent([SafetyRating].self, forKey: .safetyRatings) ?? []
    }
}

// MARK: - Candidate & GenerateContentResponse

/// A single generated response candidate from the model.
public struct Candidate: Sendable, Equatable, Decodable {
    public let content: ModelContent
    public let safetyRatings: [SafetyRating]
    public let finishReason: FinishReason?
    public let finishMessage: String?
    public let citationMetadata: CitationMetadata?
    public let groundingMetadata: GroundingMetadata?
    public let urlContextMetadata: URLContextMetadata?

    public init(
        content: ModelContent,
        safetyRatings: [SafetyRating] = [],
        finishReason: FinishReason? = nil,
        citationMetadata: CitationMetadata? = nil,
        groundingMetadata: GroundingMetadata? = nil,
        urlContextMetadata: URLContextMetadata? = nil,
        finishMessage: String? = nil
    ) {
        self.content = content
        self.safetyRatings = safetyRatings
        self.finishReason = finishReason
        self.finishMessage = finishMessage
        self.citationMetadata = citationMetadata
        self.groundingMetadata = groundingMetadata
        self.urlContextMetadata = urlContextMetadata
    }

    package var isEmpty: Bool {
        content.parts.isEmpty &&
            finishReason == nil &&
            finishMessage == nil &&
            citationMetadata == nil &&
            groundingMetadata == nil &&
            urlContextMetadata == nil
    }

    enum CodingKeys: String, CodingKey {
        case content
        case safetyRatings
        case finishReason
        case finishMessage
        case citationMetadata
        case groundingMetadata
        case urlContextMetadata
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let decodedContent = try container.decodeIfPresent(ModelContent.self, forKey: .content) {
            self.content = decodedContent
        } else {
            self.content = ModelContent(role: "model", parts: [])
        }
        let decodedRatings = try container.decodeIfPresent([SafetyRating].self, forKey: .safetyRatings) ?? []
        self.safetyRatings = decodedRatings.filter {
            $0.category != .unspecified && $0.probability != .unspecified
        }
        self.finishReason = try container.decodeIfPresent(FinishReason.self, forKey: .finishReason)
        self.finishMessage = try container.decodeIfPresent(String.self, forKey: .finishMessage)
        self.citationMetadata = try container.decodeIfPresent(CitationMetadata.self, forKey: .citationMetadata)
        self.groundingMetadata = try container.decodeIfPresent(GroundingMetadata.self, forKey: .groundingMetadata)
        if let urlMeta = try container.decodeIfPresent(URLContextMetadata.self, forKey: .urlContextMetadata),
           !urlMeta.urlMetadata.isEmpty {
            self.urlContextMetadata = urlMeta
        } else {
            self.urlContextMetadata = nil
        }
    }
}

/// Complete or streamed response from `GenerativeModel.generateContent` / `generateContentStream`,
/// mirroring `FirebaseAILogic.GenerateContentResponse` (`13.2.0`).
public struct GenerateContentResponse: Sendable, Equatable, Decodable {
    public static let unknownModelVersion = "unknown-model-version"

    public struct UsageMetadata: Sendable, Equatable, Decodable {
        public let promptTokenCount: Int
        public let cachedContentTokenCount: Int
        public let candidatesTokenCount: Int
        public let toolUsePromptTokenCount: Int
        public let thoughtsTokenCount: Int
        public let totalTokenCount: Int
        public let promptTokensDetails: [ModalityTokenCount]
        public let cacheTokensDetails: [ModalityTokenCount]
        public let candidatesTokensDetails: [ModalityTokenCount]
        public let toolUsePromptTokensDetails: [ModalityTokenCount]

        public init(
            promptTokenCount: Int = 0,
            cachedContentTokenCount: Int = 0,
            candidatesTokenCount: Int = 0,
            toolUsePromptTokenCount: Int = 0,
            thoughtsTokenCount: Int = 0,
            totalTokenCount: Int = 0,
            promptTokensDetails: [ModalityTokenCount] = [],
            cacheTokensDetails: [ModalityTokenCount] = [],
            candidatesTokensDetails: [ModalityTokenCount] = [],
            toolUsePromptTokensDetails: [ModalityTokenCount] = []
        ) {
            self.promptTokenCount = promptTokenCount
            self.cachedContentTokenCount = cachedContentTokenCount
            self.candidatesTokenCount = candidatesTokenCount
            self.toolUsePromptTokenCount = toolUsePromptTokenCount
            self.thoughtsTokenCount = thoughtsTokenCount
            self.totalTokenCount = totalTokenCount
            self.promptTokensDetails = promptTokensDetails
            self.cacheTokensDetails = cacheTokensDetails
            self.candidatesTokensDetails = candidatesTokensDetails
            self.toolUsePromptTokensDetails = toolUsePromptTokensDetails
        }

        enum CodingKeys: String, CodingKey {
            case promptTokenCount
            case cachedContentTokenCount
            case candidatesTokenCount
            case toolUsePromptTokenCount
            case thoughtsTokenCount
            case totalTokenCount
            case promptTokensDetails
            case cacheTokensDetails
            case candidatesTokensDetails
            case toolUsePromptTokensDetails
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.promptTokenCount = try container.decodeIfPresent(Int.self, forKey: .promptTokenCount) ?? 0
            self.cachedContentTokenCount = try container.decodeIfPresent(
                Int.self,
                forKey: .cachedContentTokenCount
            ) ?? 0
            self.candidatesTokenCount = try container.decodeIfPresent(Int.self, forKey: .candidatesTokenCount) ?? 0
            self.toolUsePromptTokenCount = try container.decodeIfPresent(
                Int.self,
                forKey: .toolUsePromptTokenCount
            ) ?? 0
            self.thoughtsTokenCount = try container.decodeIfPresent(Int.self, forKey: .thoughtsTokenCount) ?? 0
            self.totalTokenCount = try container.decodeIfPresent(Int.self, forKey: .totalTokenCount) ?? 0
            self.promptTokensDetails = try container.decodeIfPresent(
                [ModalityTokenCount].self,
                forKey: .promptTokensDetails
            ) ?? []
            self.cacheTokensDetails = try container.decodeIfPresent(
                [ModalityTokenCount].self,
                forKey: .cacheTokensDetails
            ) ?? []
            self.candidatesTokensDetails = try container.decodeIfPresent(
                [ModalityTokenCount].self,
                forKey: .candidatesTokensDetails
            ) ?? []
            self.toolUsePromptTokensDetails = try container.decodeIfPresent(
                [ModalityTokenCount].self,
                forKey: .toolUsePromptTokensDetails
            ) ?? []
        }
    }

    public let candidates: [Candidate]
    public let promptFeedback: PromptFeedback?
    public let usageMetadata: UsageMetadata?
    public let responseID: String?
    public let modelVersion: String

    /// Concatenated text of all non-thought `TextPart`s on the first candidate, or `nil` when none exist.
    public var text: String? {
        extractText(isThought: false)
    }

    /// Concatenated text of all thought `TextPart`s (`isThought == true`) on the first candidate, or `nil` when none exist.
    public var thoughtSummary: String? {
        extractText(isThought: true)
    }

    /// All non-thought `FunctionCallPart`s on the first candidate.
    public var functionCalls: [FunctionCallPart] {
        guard let first = candidates.first else { return [] }
        return first.content.parts.compactMap { part in
            guard let fnCall = part as? FunctionCallPart, !part.isThought else {
                return nil
            }
            return fnCall
        }
    }

    /// All non-thought `InlineDataPart`s on the first candidate.
    public var inlineDataParts: [InlineDataPart] {
        guard let first = candidates.first else { return [] }
        return first.content.parts.compactMap { part in
            guard let inlinePart = part as? InlineDataPart, !part.isThought else {
                return nil
            }
            return inlinePart
        }
    }

    public init(
        candidates: [Candidate],
        promptFeedback: PromptFeedback? = nil,
        usageMetadata: UsageMetadata? = nil
    ) {
        self.init(
            candidates: candidates,
            promptFeedback: promptFeedback,
            usageMetadata: usageMetadata,
            responseID: nil,
            modelVersion: nil
        )
    }

    package init(
        candidates: [Candidate],
        promptFeedback: PromptFeedback?,
        usageMetadata: UsageMetadata?,
        responseID: String?,
        modelVersion: String?
    ) {
        self.candidates = candidates
        self.promptFeedback = promptFeedback
        self.usageMetadata = usageMetadata
        self.responseID = responseID
        self.modelVersion = modelVersion ?? Self.unknownModelVersion
    }

    private func extractText(isThought: Bool) -> String? {
        guard let first = candidates.first else { return nil }
        let values = first.content.parts.compactMap { part -> String? in
            guard let textPart = part as? TextPart, part.isThought == isThought else {
                return nil
            }
            return textPart.text
        }
        guard !values.isEmpty else { return nil }
        return values.joined()
    }

    enum CodingKeys: String, CodingKey {
        case candidates
        case promptFeedback
        case usageMetadata
        case responseID = "responseId"
        case modelVersion
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.candidates)
            || container.contains(.promptFeedback)
            || container.contains(.usageMetadata) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "GenerateContentResponse is missing candidates, promptFeedback, and usageMetadata."
                )
            )
        }
        self.candidates = try container.decodeIfPresent([Candidate].self, forKey: .candidates) ?? []
        self.promptFeedback = try container.decodeIfPresent(PromptFeedback.self, forKey: .promptFeedback)
        self.usageMetadata = try container.decodeIfPresent(UsageMetadata.self, forKey: .usageMetadata)
        self.responseID = try container.decodeIfPresent(String.self, forKey: .responseID)
        self.modelVersion = try container.decodeIfPresent(String.self, forKey: .modelVersion)
            ?? Self.unknownModelVersion
    }
}
