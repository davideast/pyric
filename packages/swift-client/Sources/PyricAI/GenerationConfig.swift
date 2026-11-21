import Foundation

/// Output modalities supported by Gemini `GenerationConfig`.
public struct ResponseModality: Sendable, Equatable, Hashable, Codable {
    public static let text = ResponseModality(rawValue: "TEXT")
    public static let image = ResponseModality(rawValue: "IMAGE")
    public static let audio = ResponseModality(rawValue: "AUDIO")

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

/// Controls the internal reasoning ("thinking") behavior of Gemini 2.5+ and 3.x models.
public struct ThinkingConfig: Sendable, Equatable, Encodable {
    public struct ThinkingLevel: Sendable, Equatable, Hashable, Codable {
        public static let minimal = ThinkingLevel(rawValue: "MINIMAL")
        public static let low = ThinkingLevel(rawValue: "LOW")
        public static let medium = ThinkingLevel(rawValue: "MEDIUM")
        public static let high = ThinkingLevel(rawValue: "HIGH")

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

    public let thinkingBudget: Int?
    public let thinkingLevel: ThinkingLevel?
    public let includeThoughts: Bool?

    public init(thinkingBudget: Int? = nil, includeThoughts: Bool? = nil) {
        self.thinkingBudget = thinkingBudget
        self.thinkingLevel = nil
        self.includeThoughts = includeThoughts
    }

    public init(thinkingLevel: ThinkingLevel, includeThoughts: Bool? = nil) {
        self.thinkingBudget = nil
        self.thinkingLevel = thinkingLevel
        self.includeThoughts = includeThoughts
    }
}

/// Configuration options for Gemini image generation.
public struct ImageConfig: Sendable, Equatable, Encodable {
    public struct AspectRatio: Sendable, Equatable, Hashable, Encodable {
        public static let square1x1 = AspectRatio(rawValue: "1:1")
        public static let portrait9x16 = AspectRatio(rawValue: "9:16")
        public static let landscape16x9 = AspectRatio(rawValue: "16:9")
        public static let portrait3x4 = AspectRatio(rawValue: "3:4")
        public static let landscape4x3 = AspectRatio(rawValue: "4:3")
        public static let portrait2x3 = AspectRatio(rawValue: "2:3")
        public static let landscape3x2 = AspectRatio(rawValue: "3:2")
        public static let portrait4x5 = AspectRatio(rawValue: "4:5")
        public static let landscape5x4 = AspectRatio(rawValue: "5:4")
        public static let portrait1x4 = AspectRatio(rawValue: "1:4")
        public static let landscape4x1 = AspectRatio(rawValue: "4:1")
        public static let portrait1x8 = AspectRatio(rawValue: "1:8")
        public static let landscape8x1 = AspectRatio(rawValue: "8:1")
        public static let ultrawide21x9 = AspectRatio(rawValue: "21:9")

        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public struct ImageSize: Sendable, Equatable, Hashable, Encodable {
        public static let size512 = ImageSize(rawValue: "512")
        public static let size1K = ImageSize(rawValue: "1K")
        public static let size2K = ImageSize(rawValue: "2K")
        public static let size4K = ImageSize(rawValue: "4K")

        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public let aspectRatio: AspectRatio?
    public let imageSize: ImageSize?

    public init(aspectRatio: AspectRatio? = nil, imageSize: ImageSize? = nil) {
        self.aspectRatio = aspectRatio
        self.imageSize = imageSize
    }
}

/// Model generation parameters sent with content-generation requests, mirroring `GenerationConfig` (`13.2.0`).
public struct GenerationConfig: Sendable, Equatable, Encodable {
    public var temperature: Float?
    public var topP: Float?
    public var topK: Int?
    public var candidateCount: Int?
    public var maxOutputTokens: Int?
    public var presencePenalty: Float?
    public var frequencyPenalty: Float?
    public var stopSequences: [String]?
    public var responseMIMEType: String?
    public var responseSchema: Schema?
    public var responseModalities: [ResponseModality]?
    public var thinkingConfig: ThinkingConfig?
    public var imageConfig: ImageConfig?

    public init(
        temperature: Float? = nil,
        topP: Float? = nil,
        topK: Int? = nil,
        candidateCount: Int? = nil,
        maxOutputTokens: Int? = nil,
        presencePenalty: Float? = nil,
        frequencyPenalty: Float? = nil,
        stopSequences: [String]? = nil,
        responseMIMEType: String? = nil,
        responseSchema: Schema? = nil,
        responseModalities: [ResponseModality]? = nil,
        thinkingConfig: ThinkingConfig? = nil,
        imageConfig: ImageConfig? = nil
    ) {
        self.temperature = temperature
        self.topP = topP
        self.topK = topK
        self.candidateCount = candidateCount
        self.maxOutputTokens = maxOutputTokens
        self.presencePenalty = presencePenalty
        self.frequencyPenalty = frequencyPenalty
        self.stopSequences = stopSequences
        self.responseMIMEType = responseMIMEType
        self.responseSchema = responseSchema
        self.responseModalities = responseModalities
        self.thinkingConfig = thinkingConfig
        self.imageConfig = imageConfig
    }

    enum CodingKeys: String, CodingKey {
        case temperature
        case topP
        case topK
        case candidateCount
        case maxOutputTokens
        case presencePenalty
        case frequencyPenalty
        case stopSequences
        case responseMIMEType = "responseMimeType"
        case responseSchema
        case responseModalities
        case thinkingConfig
        case imageConfig
    }
}
