package com.google.firebase.ai.type

/**
 * Controls how the model predicts function calls when tools are declared,
 * matching upstream `com.google.firebase.ai.type.FunctionCallingConfig` (`firebase-bom:35.2.0`).
 */
class FunctionCallingConfig
@JvmOverloads
constructor(
    val mode: Mode,
    val allowedFunctionNames: List<String>? = null
) {
    enum class Mode {
        AUTO,
        ANY,
        NONE
    }

    internal fun toWireMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["mode"] = mode.name
        if (!allowedFunctionNames.isNullOrEmpty()) {
            out["allowedFunctionNames"] = allowedFunctionNames.toList()
        }
        return out
    }

    companion object {
        @JvmStatic
        fun auto(): FunctionCallingConfig = FunctionCallingConfig(Mode.AUTO)

        @JvmStatic
        @JvmOverloads
        fun any(allowedFunctionNames: List<String>? = null): FunctionCallingConfig =
            FunctionCallingConfig(Mode.ANY, allowedFunctionNames?.toList())

        @JvmStatic
        fun none(): FunctionCallingConfig = FunctionCallingConfig(Mode.NONE)
    }
}
