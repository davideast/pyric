package com.google.firebase.ai.type

/**
 * OpenAPI-subset schema definition for structured output and tool declarations,
 * matching upstream `com.google.firebase.ai.type.Schema` (`firebase-bom:35.2.0`).
 */
class Schema internal constructor(
    val type: String,
    val description: String? = null,
    val format: String? = null,
    val nullable: Boolean? = null,
    val enum: List<String>? = null,
    val properties: Map<String, Schema>? = null,
    val required: List<String>? = null,
    val items: Schema? = null,
    val title: String? = null,
    val minItems: Int? = null,
    val maxItems: Int? = null,
    val minimum: Double? = null,
    val maximum: Double? = null,
    val anyOf: List<Schema>? = null,
    val propertyOrdering: List<String>? = null
) {
    internal fun toWireMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        if (type != TYPE_ANY_OF) {
            out["type"] = type
        }
        if (description != null) {
            out["description"] = description
        }
        if (format != null) {
            out["format"] = format
        }
        if (nullable != null) {
            out["nullable"] = nullable
        }
        if (enum != null) {
            out["enum"] = enum
        }
        if (properties != null) {
            val encodedProps = LinkedHashMap<String, Any?>(properties.size)
            for ((key, propSchema) in properties) {
                encodedProps[key] = propSchema.toWireMap()
            }
            out["properties"] = encodedProps
        }
        if (!required.isNullOrEmpty()) {
            out["required"] = required
        }
        if (propertyOrdering != null) {
            out["propertyOrdering"] = propertyOrdering
        }
        if (items != null) {
            out["items"] = items.toWireMap()
        }
        if (title != null) {
            out["title"] = title
        }
        if (minItems != null) {
            out["minItems"] = minItems
        }
        if (maxItems != null) {
            out["maxItems"] = maxItems
        }
        if (minimum != null) {
            out["minimum"] = minimum
        }
        if (maximum != null) {
            out["maximum"] = maximum
        }
        if (anyOf != null) {
            out["anyOf"] = anyOf.map { it.toWireMap() }
        }
        return out
    }

    companion object {
        private const val TYPE_STRING = "STRING"
        private const val TYPE_INTEGER = "INTEGER"
        private const val TYPE_NUMBER = "NUMBER"
        private const val TYPE_BOOLEAN = "BOOLEAN"
        private const val TYPE_ARRAY = "ARRAY"
        private const val TYPE_OBJECT = "OBJECT"
        private const val TYPE_ANY_OF = "ANYOF"

        @JvmStatic
        @JvmOverloads
        fun boolean(
            description: String? = null,
            nullable: Boolean = false,
            title: String? = null
        ): Schema = Schema(
            type = TYPE_BOOLEAN,
            description = description,
            nullable = nullable,
            title = title
        )

        @JvmStatic
        @JvmName("numInt")
        @JvmOverloads
        fun integer(
            description: String? = null,
            nullable: Boolean = false,
            title: String? = null,
            minimum: Double? = null,
            maximum: Double? = null
        ): Schema = Schema(
            type = TYPE_INTEGER,
            description = description,
            format = "int32",
            nullable = nullable,
            title = title,
            minimum = minimum,
            maximum = maximum
        )

        @JvmStatic
        @JvmName("numLong")
        @JvmOverloads
        fun long(
            description: String? = null,
            nullable: Boolean = false,
            title: String? = null,
            minimum: Double? = null,
            maximum: Double? = null
        ): Schema = Schema(
            type = TYPE_INTEGER,
            description = description,
            nullable = nullable,
            title = title,
            minimum = minimum,
            maximum = maximum
        )

        @JvmStatic
        @JvmName("numFloat")
        @JvmOverloads
        fun float(
            description: String? = null,
            nullable: Boolean = false,
            title: String? = null,
            minimum: Double? = null,
            maximum: Double? = null
        ): Schema = Schema(
            type = TYPE_NUMBER,
            description = description,
            format = "float",
            nullable = nullable,
            title = title,
            minimum = minimum,
            maximum = maximum
        )

        @JvmStatic
        @JvmName("numDouble")
        @JvmOverloads
        fun double(
            description: String? = null,
            nullable: Boolean = false,
            title: String? = null,
            minimum: Double? = null,
            maximum: Double? = null
        ): Schema = Schema(
            type = TYPE_NUMBER,
            description = description,
            nullable = nullable,
            title = title,
            minimum = minimum,
            maximum = maximum
        )

        @JvmStatic
        @JvmName("str")
        @JvmOverloads
        fun string(
            description: String? = null,
            nullable: Boolean = false,
            format: StringFormat? = null,
            title: String? = null
        ): Schema = Schema(
            type = TYPE_STRING,
            description = description,
            format = format?.value,
            nullable = nullable,
            title = title
        )

        @JvmStatic
        @JvmOverloads
        fun enumeration(
            values: List<String>,
            description: String? = null,
            nullable: Boolean = false,
            title: String? = null
        ): Schema {
            require(values.isNotEmpty()) { "Enumeration values must not be empty." }
            return Schema(
                type = TYPE_STRING,
                description = description,
                format = "enum",
                nullable = nullable,
                enum = values.toList(),
                title = title
            )
        }

        @JvmStatic
        @JvmOverloads
        fun array(
            items: Schema,
            description: String? = null,
            nullable: Boolean = false,
            title: String? = null,
            minItems: Int? = null,
            maxItems: Int? = null
        ): Schema = Schema(
            type = TYPE_ARRAY,
            description = description,
            nullable = nullable,
            items = items,
            title = title,
            minItems = minItems,
            maxItems = maxItems
        )

        @JvmStatic
        @JvmOverloads
        fun obj(
            properties: Map<String, Schema>,
            optionalProperties: List<String> = emptyList(),
            description: String? = null,
            nullable: Boolean = false,
            title: String? = null,
            propertyOrdering: List<String>? = null
        ): Schema {
            if (!properties.keys.containsAll(optionalProperties)) {
                val missing = optionalProperties.minus(properties.keys)
                throw IllegalArgumentException(
                    "All optional properties must be present in properties. Missing: $missing"
                )
            }
            if (propertyOrdering != null && !properties.keys.containsAll(propertyOrdering)) {
                val unknown = propertyOrdering.minus(properties.keys)
                throw IllegalArgumentException(
                    "All propertyOrdering entries must be present in properties. Missing: $unknown"
                )
            }
            val copiedProps = LinkedHashMap<String, Schema>(properties.size)
            copiedProps.putAll(properties)
            val requiredKeys = copiedProps.keys.minus(optionalProperties.toSet()).toList()
            return Schema(
                type = TYPE_OBJECT,
                description = description,
                nullable = nullable,
                properties = copiedProps,
                required = requiredKeys,
                title = title,
                propertyOrdering = propertyOrdering?.toList()
            )
        }

        @JvmStatic
        fun anyOf(schemas: List<Schema>): Schema {
            require(schemas.isNotEmpty()) { "The anyOf schema list must not be empty." }
            return Schema(
                type = TYPE_ANY_OF,
                anyOf = schemas.toList()
            )
        }
    }
}
