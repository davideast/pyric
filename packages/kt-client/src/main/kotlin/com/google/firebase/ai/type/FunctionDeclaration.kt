package com.google.firebase.ai.type

/**
 * Defines a callable function declaration exposed to the model via [Tool.functionDeclarations],
 * matching upstream `com.google.firebase.ai.type.FunctionDeclaration` (`firebase-bom:35.2.0`).
 */
class FunctionDeclaration
@JvmOverloads
constructor(
    val name: String,
    val description: String,
    val parameters: Map<String, Schema> = emptyMap(),
    val optionalParameters: List<String> = emptyList()
) {
    internal val schema: Schema

    init {
        require(name.isNotBlank()) { "FunctionDeclaration name must not be blank." }
        schema = Schema.obj(
            properties = parameters,
            optionalProperties = optionalParameters,
            nullable = false
        )
    }

    internal fun toWireMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["name"] = name
        out["description"] = description
        out["parameters"] = schema.toWireMap()
        return out
    }
}
