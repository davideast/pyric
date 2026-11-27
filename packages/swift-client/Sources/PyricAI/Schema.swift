import Foundation

/// OpenAPI 3.0 data types supported by Gemini `Schema` definitions.
public enum DataType: String, Sendable, Codable, Equatable, Hashable {
    case string = "STRING"
    case number = "NUMBER"
    case integer = "INTEGER"
    case boolean = "BOOLEAN"
    case array = "ARRAY"
    case object = "OBJECT"
}

/// Defines structured input and output schemas for Gemini structured outputs and function calling,
/// mirroring `FirebaseAILogic.Schema` (`13.2.0`).
public final class Schema: Sendable, Encodable, Equatable {
    /// Modifiers describing the expected format of a string `Schema`.
    public struct StringFormat: Sendable, Equatable, Hashable, Encodable {
        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public static func custom(_ format: String) -> StringFormat {
            StringFormat(rawValue: format)
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    /// Modifiers describing the expected format of an integer `Schema`.
    public struct IntegerFormat: Sendable, Equatable, Hashable, Encodable {
        public static let int32 = IntegerFormat(rawValue: "int32")
        public static let int64 = IntegerFormat(rawValue: "int64")

        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public static func custom(_ format: String) -> IntegerFormat {
            IntegerFormat(rawValue: format)
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    package let dataType: DataType?
    public var type: String { dataType?.rawValue ?? "UNSPECIFIED" }
    public let format: String?
    public let description: String?
    public let title: String?
    public let nullable: Bool?
    public let enumValues: [String]?
    public let items: Schema?
    public let minItems: Int?
    public let maxItems: Int?
    public let minimum: Double?
    public let maximum: Double?
    private let exactIntMinimum: Int?
    private let exactIntMaximum: Int?
    public let properties: [String: Schema]?
    public let anyOf: [Schema]?
    public let requiredProperties: [String]?
    public let propertyOrdering: [String]?

    private init(
        type: DataType?,
        format: String?,
        description: String?,
        title: String?,
        nullable: Bool?,
        enumValues: [String]?,
        items: Schema?,
        minItems: Int?,
        maxItems: Int?,
        minimum: Double?,
        maximum: Double?,
        exactIntMinimum: Int?,
        exactIntMaximum: Int?,
        anyOf: [Schema]?,
        properties: [String: Schema]?,
        requiredProperties: [String]?,
        propertyOrdering: [String]?
    ) {
        precondition(
            type != nil || anyOf != nil,
            "A schema must have either a `type` or an `anyOf` array of sub-schemas."
        )
        self.dataType = type
        self.format = format
        self.description = description
        self.title = title
        self.nullable = nullable
        self.enumValues = enumValues
        self.items = items
        self.minItems = minItems
        self.maxItems = maxItems
        self.minimum = minimum
        self.maximum = maximum
        self.exactIntMinimum = exactIntMinimum
        self.exactIntMaximum = exactIntMaximum
        self.anyOf = anyOf
        self.properties = properties
        self.requiredProperties = requiredProperties
        self.propertyOrdering = propertyOrdering
    }

    public required convenience init(
        type: DataType?,
        format: String? = nil,
        description: String? = nil,
        title: String? = nil,
        nullable: Bool? = nil,
        enumValues: [String]? = nil,
        items: Schema? = nil,
        minItems: Int? = nil,
        maxItems: Int? = nil,
        minimum: Double? = nil,
        maximum: Double? = nil,
        anyOf: [Schema]? = nil,
        properties: [String: Schema]? = nil,
        requiredProperties: [String]? = nil,
        propertyOrdering: [String]? = nil
    ) {
        self.init(
            type: type,
            format: format,
            description: description,
            title: title,
            nullable: nullable,
            enumValues: enumValues,
            items: items,
            minItems: minItems,
            maxItems: maxItems,
            minimum: minimum,
            maximum: maximum,
            exactIntMinimum: nil,
            exactIntMaximum: nil,
            anyOf: anyOf,
            properties: properties,
            requiredProperties: requiredProperties,
            propertyOrdering: propertyOrdering
        )
    }

    // MARK: - Static Schema Builders

    public static func string(
        description: String? = nil,
        title: String? = nil,
        nullable: Bool = false,
        format: StringFormat? = nil
    ) -> Schema {
        Schema(
            type: .string,
            format: format?.rawValue,
            description: description,
            title: title,
            nullable: nullable
        )
    }

    public static func enumeration(
        values: [String],
        description: String? = nil,
        title: String? = nil,
        nullable: Bool = false
    ) -> Schema {
        Schema(
            type: .string,
            format: "enum",
            description: description,
            title: title,
            nullable: nullable,
            enumValues: values
        )
    }

    public static func float(
        description: String? = nil,
        title: String? = nil,
        nullable: Bool = false,
        minimum: Float? = nil,
        maximum: Float? = nil
    ) -> Schema {
        Schema(
            type: .number,
            format: "float",
            description: description,
            title: title,
            nullable: nullable,
            minimum: minimum.map { Double($0) },
            maximum: maximum.map { Double($0) }
        )
    }

    public static func double(
        description: String? = nil,
        title: String? = nil,
        nullable: Bool = false,
        minimum: Double? = nil,
        maximum: Double? = nil
    ) -> Schema {
        Schema(
            type: .number,
            description: description,
            title: title,
            nullable: nullable,
            minimum: minimum,
            maximum: maximum
        )
    }

    public static func integer(
        description: String? = nil,
        title: String? = nil,
        nullable: Bool = false,
        format: IntegerFormat? = nil,
        minimum: Int? = nil,
        maximum: Int? = nil
    ) -> Schema {
        Schema(
            type: .integer,
            format: format?.rawValue,
            description: description,
            title: title,
            nullable: nullable,
            enumValues: nil,
            items: nil,
            minItems: nil,
            maxItems: nil,
            minimum: minimum.map { Double($0) },
            maximum: maximum.map { Double($0) },
            exactIntMinimum: minimum,
            exactIntMaximum: maximum,
            anyOf: nil,
            properties: nil,
            requiredProperties: nil,
            propertyOrdering: nil
        )
    }

    public static func boolean(
        description: String? = nil,
        title: String? = nil,
        nullable: Bool = false
    ) -> Schema {
        Schema(type: .boolean, description: description, title: title, nullable: nullable)
    }

    public static func array(
        items: Schema,
        description: String? = nil,
        title: String? = nil,
        nullable: Bool = false,
        minItems: Int? = nil,
        maxItems: Int? = nil
    ) -> Schema {
        Schema(
            type: .array,
            description: description,
            title: title,
            nullable: nullable,
            items: items,
            minItems: minItems,
            maxItems: maxItems
        )
    }

    public static func object(
        properties: [String: Schema],
        optionalProperties: [String] = [],
        propertyOrdering: [String]? = nil,
        description: String? = nil,
        title: String? = nil,
        nullable: Bool = false
    ) -> Schema {
        var requiredProps = Set(properties.keys)
        for optionalKey in optionalProperties {
            precondition(
                properties.keys.contains(optionalKey),
                "Optional property \"\(optionalKey)\" is not defined in object properties."
            )
            requiredProps.remove(optionalKey)
        }
        return Schema(
            type: .object,
            description: description,
            title: title,
            nullable: nullable,
            properties: properties,
            requiredProperties: requiredProps.sorted(),
            propertyOrdering: propertyOrdering
        )
    }

    public static func anyOf(schemas: [Schema]) -> Schema {
        Schema(type: nil, anyOf: schemas)
    }

    // MARK: - Encodable & JSON Schema Conversion

    enum CodingKeys: String, CodingKey {
        case dataType = "type"
        case format
        case description
        case title
        case nullable
        case enumValues = "enum"
        case items
        case minItems
        case maxItems
        case minimum
        case maximum
        case anyOf
        case properties
        case requiredProperties = "required"
        case propertyOrdering
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(dataType, forKey: .dataType)
        try container.encodeIfPresent(format, forKey: .format)
        try container.encodeIfPresent(description, forKey: .description)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(nullable, forKey: .nullable)
        try container.encodeIfPresent(enumValues, forKey: .enumValues)
        try container.encodeIfPresent(items, forKey: .items)
        try container.encodeIfPresent(minItems, forKey: .minItems)
        try container.encodeIfPresent(maxItems, forKey: .maxItems)
        if let exactIntMinimum {
            try container.encode(exactIntMinimum, forKey: .minimum)
        } else if let minimum {
            guard minimum.isFinite else {
                throw EncodingError.invalidValue(
                    minimum,
                    EncodingError.Context(
                        codingPath: container.codingPath + [CodingKeys.minimum],
                        debugDescription: "Schema minimum must be finite."
                    )
                )
            }
            try container.encode(minimum, forKey: .minimum)
        }
        if let exactIntMaximum {
            try container.encode(exactIntMaximum, forKey: .maximum)
        } else if let maximum {
            guard maximum.isFinite else {
                throw EncodingError.invalidValue(
                    maximum,
                    EncodingError.Context(
                        codingPath: container.codingPath + [CodingKeys.maximum],
                        debugDescription: "Schema maximum must be finite."
                    )
                )
            }
            try container.encode(maximum, forKey: .maximum)
        }
        try container.encodeIfPresent(anyOf, forKey: .anyOf)
        try container.encodeIfPresent(properties, forKey: .properties)
        try container.encodeIfPresent(requiredProperties, forKey: .requiredProperties)
        try container.encodeIfPresent(propertyOrdering, forKey: .propertyOrdering)
    }

    /// Converts this `Schema` to Gemini JSON Schema representation (`JSONObject`).
    public func toJSONSchema() -> JSONObject {
        var json: JSONObject = [:]
        if let dataType {
            let typeName = dataType.rawValue.lowercased()
            if nullable == true {
                json["type"] = .array([.string(typeName), .string("null")])
            } else {
                json["type"] = .string(typeName)
            }
        }
        if let title { json["title"] = .string(title) }
        if let description { json["description"] = .string(description) }
        if let format, enumValues == nil {
            json["format"] = .string(format)
        }
        if let enumValues {
            var values: [JSONValue] = enumValues.map { .string($0) }
            if nullable == true {
                values.append(.null)
            }
            json["enum"] = .array(values)
        }
        if let minimum { json["minimum"] = .number(minimum) }
        if let maximum { json["maximum"] = .number(maximum) }
        if let items { json["items"] = .object(items.toJSONSchema()) }
        if let minItems { json["minItems"] = .number(Double(minItems)) }
        if let maxItems { json["maxItems"] = .number(Double(maxItems)) }
        if dataType == .object || properties != nil {
            if let properties {
                json["properties"] = .object(properties.mapValues { .object($0.toJSONSchema()) })
            }
            json["required"] = .array((requiredProperties ?? []).map { .string($0) })
            json["additionalProperties"] = .bool(false)
            if let propertyOrdering {
                json["propertyOrdering"] = .array(propertyOrdering.map { .string($0) })
            }
        }
        if let anyOf {
            json["anyOf"] = .array(anyOf.map { .object($0.toJSONSchema()) })
        }
        return json
    }

    public static func == (lhs: Schema, rhs: Schema) -> Bool {
        lhs.dataType == rhs.dataType &&
            lhs.format == rhs.format &&
            lhs.description == rhs.description &&
            lhs.title == rhs.title &&
            lhs.nullable == rhs.nullable &&
            lhs.enumValues == rhs.enumValues &&
            lhs.items == rhs.items &&
            lhs.minItems == rhs.minItems &&
            lhs.maxItems == rhs.maxItems &&
            lhs.minimum == rhs.minimum &&
            lhs.maximum == rhs.maximum &&
            lhs.exactIntMinimum == rhs.exactIntMinimum &&
            lhs.exactIntMaximum == rhs.exactIntMaximum &&
            lhs.properties == rhs.properties &&
            lhs.anyOf == rhs.anyOf &&
            lhs.requiredProperties == rhs.requiredProperties &&
            lhs.propertyOrdering == rhs.propertyOrdering
    }
}
