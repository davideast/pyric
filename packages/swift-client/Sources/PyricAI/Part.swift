import Foundation

/// A protocol describing any value convertible into an array of model-interpretable `Part` values.
public protocol PartsRepresentable {
    var partsValue: [any Part] { get }
}

/// A discrete piece of multimodal content interpretable by a generative AI model.
public protocol Part: PartsRepresentable, Codable, Sendable, Equatable {
    /// Indicates whether this part represents a summary of the model's internal reasoning process.
    var isThought: Bool { get }
}

public extension Part {
    var partsValue: [any Part] { [self] }
}

extension String: PartsRepresentable {
    public var partsValue: [any Part] { [TextPart(self)] }
}

extension Array: PartsRepresentable where Element == any PartsRepresentable {
    public var partsValue: [any Part] { flatMap { $0.partsValue } }
}

/// Optional speaker and delivery metadata for text-to-speech synthesis turns.
public struct SpeechMetadata: Codable, Sendable, Equatable, Hashable {
    public let speaker: String?
    public let prompt: String?

    public init(speaker: String? = nil, prompt: String? = nil) {
        self.speaker = speaker
        self.prompt = prompt
    }
}

// MARK: - Concrete Part Types

/// A text part containing a string value.
public struct TextPart: Part {
    public let text: String
    public let speechMetadata: SpeechMetadata?
    public let thoughtSignature: String?
    package let _isThought: Bool?

    public var isThought: Bool { _isThought ?? false }

    public init(_ text: String) {
        self.init(text, speechMetadata: nil, isThought: nil, thoughtSignature: nil)
    }

    public init(_ text: String, speechMetadata: SpeechMetadata?) {
        self.init(text, speechMetadata: speechMetadata, isThought: nil, thoughtSignature: nil)
    }

    public init(
        _ text: String,
        speechMetadata: SpeechMetadata? = nil,
        isThought: Bool?,
        thoughtSignature: String? = nil
    ) {
        self.text = text
        self.speechMetadata = speechMetadata
        self._isThought = isThought
        self.thoughtSignature = thoughtSignature
    }

    enum CodingKeys: String, CodingKey {
        case text
        case speechMetadata
        case _isThought = "thought"
        case thoughtSignature
    }
}

/// Binary media data provided inline (base64-encoded on the Gemini JSON wire).
public struct InlineDataPart: Part {
    package struct WireInlineData: Codable, Equatable, Sendable {
        let mimeType: String
        let data: Data

        init(data: Data, mimeType: String) {
            self.data = data
            self.mimeType = mimeType
        }
    }

    package let inlineData: WireInlineData
    package let _isThought: Bool?
    public let thoughtSignature: String?

    public var data: Data { inlineData.data }
    public var mimeType: String { inlineData.mimeType }
    public var isThought: Bool { _isThought ?? false }

    public init(data: Data, mimeType: String) {
        self.init(WireInlineData(data: data, mimeType: mimeType), isThought: nil, thoughtSignature: nil)
    }

    package init(_ inlineData: WireInlineData, isThought: Bool?, thoughtSignature: String?) {
        self.inlineData = inlineData
        self._isThought = isThought
        self.thoughtSignature = thoughtSignature
    }

    enum CodingKeys: String, CodingKey {
        case inlineData
        case _isThought = "thought"
        case thoughtSignature
    }
}

/// Media data referenced by URI (such as a `gs://` Cloud Storage URI or HTTPS URL).
public struct FileDataPart: Part {
    package struct WireFileData: Codable, Equatable, Sendable {
        let fileURI: String
        let mimeType: String

        enum CodingKeys: String, CodingKey {
            case fileURI = "fileUri"
            case mimeType
        }
    }

    package let fileData: WireFileData
    package let _isThought: Bool?
    public let thoughtSignature: String?

    public var uri: String { fileData.fileURI }
    public var mimeType: String { fileData.mimeType }
    public var isThought: Bool { _isThought ?? false }

    public init(uri: String, mimeType: String) {
        self.init(WireFileData(fileURI: uri, mimeType: mimeType), isThought: nil, thoughtSignature: nil)
    }

    package init(_ fileData: WireFileData, isThought: Bool?, thoughtSignature: String?) {
        self.fileData = fileData
        self._isThought = isThought
        self.thoughtSignature = thoughtSignature
    }

    enum CodingKeys: String, CodingKey {
        case fileData
        case _isThought = "thought"
        case thoughtSignature
    }
}

/// A predicted function call returned by the model.
public struct FunctionCallPart: Part {
    package struct WireFunctionCall: Codable, Equatable, Sendable {
        let name: String
        let args: JSONObject
        let id: String?

        init(name: String, args: JSONObject, id: String?) {
            self.name = name
            self.args = args
            self.id = id
        }

        enum CodingKeys: String, CodingKey {
            case name
            case args
            case id
        }

        package init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.name = try container.decode(String.self, forKey: .name)
            self.args = try container.decodeIfPresent(JSONObject.self, forKey: .args) ?? [:]
            self.id = try container.decodeIfPresent(String.self, forKey: .id)
        }
    }

    package let functionCall: WireFunctionCall
    package let _isThought: Bool?
    public let thoughtSignature: String?

    public var name: String { functionCall.name }
    public var args: JSONObject { functionCall.args }
    public var functionId: String? { functionCall.id }
    public var isThought: Bool { _isThought ?? false }

    public init(name: String, args: JSONObject) {
        self.init(WireFunctionCall(name: name, args: args, id: nil), isThought: nil, thoughtSignature: nil)
    }

    public init(name: String, args: JSONObject, id: String? = nil) {
        self.init(WireFunctionCall(name: name, args: args, id: id), isThought: nil, thoughtSignature: nil)
    }

    public init(
        name: String,
        args: JSONObject,
        id: String? = nil,
        isThought: Bool? = nil,
        thoughtSignature: String? = nil
    ) {
        self.init(
            WireFunctionCall(name: name, args: args, id: id),
            isThought: isThought,
            thoughtSignature: thoughtSignature
        )
    }

    package init(_ functionCall: WireFunctionCall, isThought: Bool?, thoughtSignature: String?) {
        self.functionCall = functionCall
        self._isThought = isThought
        self.thoughtSignature = thoughtSignature
    }

    enum CodingKeys: String, CodingKey {
        case functionCall
        case _isThought = "thought"
        case thoughtSignature
    }
}

/// Structured output from executing a `FunctionCallPart` on the client.
public struct FunctionResponsePart: Part {
    package struct WireFunctionResponse: Codable, Equatable, Sendable {
        let name: String
        let response: JSONObject
        let id: String?

        init(name: String, response: JSONObject, id: String? = nil) {
            self.name = name
            self.response = response
            self.id = id
        }
    }

    package let functionResponse: WireFunctionResponse
    package let _isThought: Bool?
    public let thoughtSignature: String?

    public var name: String { functionResponse.name }
    public var response: JSONObject { functionResponse.response }
    public var functionId: String? { functionResponse.id }
    public var isThought: Bool { _isThought ?? false }

    public init(name: String, response: JSONObject) {
        self.init(
            WireFunctionResponse(name: name, response: response, id: nil),
            isThought: nil,
            thoughtSignature: nil
        )
    }

    public init(name: String, response: JSONObject, functionId: String? = nil) {
        self.init(
            WireFunctionResponse(name: name, response: response, id: functionId),
            isThought: nil,
            thoughtSignature: nil
        )
    }

    package init(_ functionResponse: WireFunctionResponse, isThought: Bool?, thoughtSignature: String?) {
        self.functionResponse = functionResponse
        self._isThought = isThought
        self.thoughtSignature = thoughtSignature
    }

    enum CodingKeys: String, CodingKey {
        case functionResponse
        case _isThought = "thought"
        case thoughtSignature
    }
}

/// A part containing code generated and executed by the model.
public struct ExecutableCodePart: Part {
    public struct Language: Sendable, Equatable, Hashable, Codable, CustomStringConvertible {
        public static let unspecified = Language(rawValue: "LANGUAGE_UNSPECIFIED")
        public static let python = Language(rawValue: "PYTHON")

        public let rawValue: String
        public var description: String { rawValue }

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

    package struct WireExecutableCode: Codable, Equatable, Sendable {
        let language: Language?
        let code: String?
    }

    package let executableCode: WireExecutableCode
    package let _isThought: Bool?
    public let thoughtSignature: String?

    public var language: Language { executableCode.language ?? .unspecified }
    public var code: String { executableCode.code ?? "" }
    public var isThought: Bool { _isThought ?? false }

    public init(language: Language, code: String) {
        self.init(
            WireExecutableCode(language: language, code: code),
            isThought: nil,
            thoughtSignature: nil
        )
    }

    package init(_ executableCode: WireExecutableCode, isThought: Bool?, thoughtSignature: String?) {
        self.executableCode = executableCode
        self._isThought = isThought
        self.thoughtSignature = thoughtSignature
    }

    enum CodingKeys: String, CodingKey {
        case executableCode
        case _isThought = "thought"
        case thoughtSignature
    }
}

/// The result of executing an `ExecutableCodePart`.
public struct CodeExecutionResultPart: Part {
    public struct Outcome: Sendable, Equatable, Hashable, Codable, CustomStringConvertible {
        public static let unspecified = Outcome(rawValue: "OUTCOME_UNSPECIFIED")
        public static let ok = Outcome(rawValue: "OUTCOME_OK")
        public static let failed = Outcome(rawValue: "OUTCOME_FAILED")
        public static let deadlineExceeded = Outcome(rawValue: "OUTCOME_DEADLINE_EXCEEDED")

        public let rawValue: String
        public var description: String { rawValue }

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

    package struct WireCodeExecutionResult: Codable, Equatable, Sendable {
        let outcome: Outcome?
        let output: String?
    }

    package let codeExecutionResult: WireCodeExecutionResult
    package let _isThought: Bool?
    public let thoughtSignature: String?

    public var outcome: Outcome { codeExecutionResult.outcome ?? .unspecified }
    public var output: String? { codeExecutionResult.output }
    public var isThought: Bool { _isThought ?? false }

    public init(outcome: Outcome, output: String) {
        self.init(
            codeExecutionResult: WireCodeExecutionResult(outcome: outcome, output: output),
            isThought: nil,
            thoughtSignature: nil
        )
    }

    package init(
        codeExecutionResult: WireCodeExecutionResult,
        isThought: Bool?,
        thoughtSignature: String?
    ) {
        self.codeExecutionResult = codeExecutionResult
        self._isThought = isThought
        self.thoughtSignature = thoughtSignature
    }

    enum CodingKeys: String, CodingKey {
        case codeExecutionResult
        case _isThought = "thought"
        case thoughtSignature
    }
}
