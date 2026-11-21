package com.google.firebase.ai.type

/**
 * Tool definition container passed to `GenerativeModel`,
 * matching upstream `com.google.firebase.ai.type.Tool` (`firebase-bom:35.2.0`).
 */
class Tool internal constructor(
    val functionDeclarations: List<FunctionDeclaration>?
) {
    internal fun toWireMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        if (functionDeclarations != null) {
            out["functionDeclarations"] = functionDeclarations.map { it.toWireMap() }
        }
        return out
    }

    companion object {
        @JvmStatic
        fun functionDeclarations(functionDeclarations: List<FunctionDeclaration>): Tool =
            Tool(functionDeclarations.toList())
    }
}
