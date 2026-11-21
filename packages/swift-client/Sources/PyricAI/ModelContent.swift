import Foundation

/// Internal tagged union backing `ModelContent` wire serialization and `Equatable` synthesis.
package struct InternalPart: Equatable, Sendable {
    package enum OneOfData: Equatable, Sendable {
        case text(String)
        case inlineData(InlineDataPart.WireInlineData)
        case fileData(FileDataPart.WireFileData)
        case functionCall(FunctionCallPart.WireFunctionCall)
        case functionResponse(FunctionResponsePart.WireFunctionResponse)
        case executableCode(ExecutableCodePart.WireExecutableCode)
        case codeExecutionResult(CodeExecutionResultPart.WireCodeExecutionResult)
    }

    package let data: OneOfData?
    package let speechMetadata: SpeechMetadata?
    package let isThought: Bool?
    package let thoughtSignature: String?

    package init(
        _ data: OneOfData?,
        speechMetadata: SpeechMetadata? = nil,
        isThought: Bool? = nil,
        thoughtSignature: String? = nil
    ) {
        self.data = data
        self.speechMetadata = speechMetadata
        self.isThought = isThought
        self.thoughtSignature = thoughtSignature
    }
}

extension InternalPart: Codable {
    enum PayloadKeys: String, CodingKey {
        case text
        case inlineData
        case fileData
        case functionCall
        case functionResponse
        case executableCode
        case codeExecutionResult
        case isThought = "thought"
        case thoughtSignature
        case speechMetadata
    }

    package func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: PayloadKeys.self)
        if let data {
            switch data {
            case .text(let value):
                try container.encode(value, forKey: .text)
            case .inlineData(let value):
                try container.encode(value, forKey: .inlineData)
            case .fileData(let value):
                try container.encode(value, forKey: .fileData)
            case .functionCall(let value):
                try container.encode(value, forKey: .functionCall)
            case .functionResponse(let value):
                try container.encode(value, forKey: .functionResponse)
            case .executableCode(let value):
                try container.encode(value, forKey: .executableCode)
            case .codeExecutionResult(let value):
                try container.encode(value, forKey: .codeExecutionResult)
            }
        }
        try container.encodeIfPresent(isThought, forKey: .isThought)
        try container.encodeIfPresent(thoughtSignature, forKey: .thoughtSignature)
        try container.encodeIfPresent(speechMetadata, forKey: .speechMetadata)
    }

    package init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKeys.self)
        if container.contains(.text) {
            self.data = .text(try container.decode(String.self, forKey: .text))
        } else if container.contains(.inlineData) {
            self.data = .inlineData(
                try container.decode(InlineDataPart.WireInlineData.self, forKey: .inlineData)
            )
        } else if container.contains(.fileData) {
            self.data = .fileData(
                try container.decode(FileDataPart.WireFileData.self, forKey: .fileData)
            )
        } else if container.contains(.functionCall) {
            self.data = .functionCall(
                try container.decode(FunctionCallPart.WireFunctionCall.self, forKey: .functionCall)
            )
        } else if container.contains(.functionResponse) {
            self.data = .functionResponse(
                try container.decode(
                    FunctionResponsePart.WireFunctionResponse.self,
                    forKey: .functionResponse
                )
            )
        } else if container.contains(.executableCode) {
            self.data = .executableCode(
                try container.decode(
                    ExecutableCodePart.WireExecutableCode.self,
                    forKey: .executableCode
                )
            )
        } else if container.contains(.codeExecutionResult) {
            self.data = .codeExecutionResult(
                try container.decode(
                    CodeExecutionResultPart.WireCodeExecutionResult.self,
                    forKey: .codeExecutionResult
                )
            )
        } else {
            self.data = nil
        }
        self.isThought = try container.decodeIfPresent(Bool.self, forKey: .isThought)
        self.thoughtSignature = try container.decodeIfPresent(String.self, forKey: .thoughtSignature)
        self.speechMetadata = try container.decodeIfPresent(
            SpeechMetadata.self,
            forKey: .speechMetadata
        )
    }
}

/// Multimodal conversation turn containing an optional `role` and heterogeneous `Part` items.
public struct ModelContent: Equatable, Sendable, Codable {
    /// Role of the entity creating the content (`"user"`, `"model"`), or `nil` when omitted.
    public let role: String?

    package let internalParts: [InternalPart]

    /// Decoded `Part` items contained in this `ModelContent`.
    public var parts: [any Part] {
        internalParts.compactMap { part -> (any Part)? in
            switch part.data {
            case .text(let text):
                return TextPart(
                    text,
                    speechMetadata: part.speechMetadata,
                    isThought: part.isThought,
                    thoughtSignature: part.thoughtSignature
                )
            case .inlineData(let inlineData):
                return InlineDataPart(
                    inlineData,
                    isThought: part.isThought,
                    thoughtSignature: part.thoughtSignature
                )
            case .fileData(let fileData):
                return FileDataPart(
                    fileData,
                    isThought: part.isThought,
                    thoughtSignature: part.thoughtSignature
                )
            case .functionCall(let functionCall):
                return FunctionCallPart(
                    functionCall,
                    isThought: part.isThought,
                    thoughtSignature: part.thoughtSignature
                )
            case .functionResponse(let functionResponse):
                return FunctionResponsePart(
                    functionResponse,
                    isThought: part.isThought,
                    thoughtSignature: part.thoughtSignature
                )
            case .executableCode(let executableCode):
                return ExecutableCodePart(
                    executableCode,
                    isThought: part.isThought,
                    thoughtSignature: part.thoughtSignature
                )
            case .codeExecutionResult(let codeExecutionResult):
                return CodeExecutionResultPart(
                    codeExecutionResult: codeExecutionResult,
                    isThought: part.isThought,
                    thoughtSignature: part.thoughtSignature
                )
            case .none:
                return nil
            }
        }
    }

    public init(role: String? = "user", parts: [any Part]) {
        self.role = role
        var converted: [InternalPart] = []
        converted.reserveCapacity(parts.count)
        for part in parts {
            switch part {
            case let textPart as TextPart:
                converted.append(InternalPart(
                    .text(textPart.text),
                    speechMetadata: textPart.speechMetadata,
                    isThought: textPart._isThought,
                    thoughtSignature: textPart.thoughtSignature
                ))
            case let inlinePart as InlineDataPart:
                converted.append(InternalPart(
                    .inlineData(inlinePart.inlineData),
                    isThought: inlinePart._isThought,
                    thoughtSignature: inlinePart.thoughtSignature
                ))
            case let filePart as FileDataPart:
                converted.append(InternalPart(
                    .fileData(filePart.fileData),
                    isThought: filePart._isThought,
                    thoughtSignature: filePart.thoughtSignature
                ))
            case let fnCallPart as FunctionCallPart:
                converted.append(InternalPart(
                    .functionCall(fnCallPart.functionCall),
                    isThought: fnCallPart._isThought,
                    thoughtSignature: fnCallPart.thoughtSignature
                ))
            case let fnRespPart as FunctionResponsePart:
                converted.append(InternalPart(
                    .functionResponse(fnRespPart.functionResponse),
                    isThought: fnRespPart._isThought,
                    thoughtSignature: fnRespPart.thoughtSignature
                ))
            case let execPart as ExecutableCodePart:
                converted.append(InternalPart(
                    .executableCode(execPart.executableCode),
                    isThought: execPart._isThought,
                    thoughtSignature: execPart.thoughtSignature
                ))
            case let execResPart as CodeExecutionResultPart:
                converted.append(InternalPart(
                    .codeExecutionResult(execResPart.codeExecutionResult),
                    isThought: execResPart._isThought,
                    thoughtSignature: execResPart.thoughtSignature
                ))
            default:
                break
            }
        }
        self.internalParts = converted
    }

    public init(role: String? = "user", parts: any PartsRepresentable...) {
        self.init(role: role, parts: parts.flatMap { $0.partsValue })
    }

    package init(role: String?, internalParts: [InternalPart]) {
        self.role = role
        self.internalParts = internalParts
    }

    enum CodingKeys: String, CodingKey {
        case role
        case internalParts = "parts"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.role = try container.decodeIfPresent(String.self, forKey: .role)
        self.internalParts = try container.decodeIfPresent([InternalPart].self, forKey: .internalParts) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(role, forKey: .role)
        try container.encode(internalParts, forKey: .internalParts)
    }
}
