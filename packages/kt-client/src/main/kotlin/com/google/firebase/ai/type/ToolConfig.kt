package com.google.firebase.ai.type

/**
 * Tool execution configuration passed to `GenerativeModel`,
 * matching upstream `com.google.firebase.ai.type.ToolConfig` (`firebase-bom:35.2.0`).
 */
class ToolConfig
@JvmOverloads
constructor(
    val functionCallingConfig: FunctionCallingConfig? = null
) {
    internal fun toWireMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        if (functionCallingConfig != null) {
            out["functionCallingConfig"] = functionCallingConfig.toWireMap()
        }
        return out
    }
}
