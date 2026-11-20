package dev.pyric.bridge

internal object BridgeAppCheckAttachment {
    private val INTERNAL_METHODS = setOf(
        "sandbox.clock",
        "auth.restorePortSession"
    )
    private val INTERNAL_SUB_TARGETS = setOf(
        "authState",
        "idToken",
        "events",
        "presence"
    )

    suspend fun attachToOpParams(
        method: String,
        params: Map<String, Any?>,
        tokenProvider: (suspend () -> String?)?
    ): Map<String, Any?> {
        if (tokenProvider == null) return params
        if (method.startsWith("appCheck.") || method in INTERNAL_METHODS) return params
        if (params.containsKey("appCheckToken")) return params
        val token = try {
            tokenProvider.invoke()
        } catch (_: Throwable) {
            null
        }
        if (token.isNullOrEmpty()) return params
        val copy = LinkedHashMap<String, Any?>(params.size + 1)
        copy.putAll(params)
        copy["appCheckToken"] = token
        return copy
    }

    suspend fun resolveForSubscription(
        target: Any,
        tokenProvider: (suspend () -> String?)?
    ): String? {
        if (tokenProvider == null) return null
        if (target is String && target in INTERNAL_SUB_TARGETS) return null
        val token = try {
            tokenProvider.invoke()
        } catch (_: Throwable) {
            null
        }
        if (token.isNullOrEmpty()) return null
        return token
    }
}
