package dev.pyric.auth

sealed class AuthLens {
    abstract fun toMap(): Map<String, Any?>

    data object Anon : AuthLens() {
        override fun toMap(): Map<String, Any?> = mapOf("mode" to "anon")
    }

    data object Admin : AuthLens() {
        override fun toMap(): Map<String, Any?> = mapOf("mode" to "admin")
    }

    data object AppSession : AuthLens() {
        override fun toMap(): Map<String, Any?> = mapOf("mode" to "app-session")
    }

    data class AsUser(
        val uid: String,
        val token: Map<String, Any?>? = null,
        val tenant: String? = null
    ) : AuthLens() {
        override fun toMap(): Map<String, Any?> {
            val tokenMap = if (token != null) {
                val merged = mutableMapOf<String, Any?>("sub" to uid, "user_id" to uid)
                merged.putAll(token)
                merged
            } else {
                mapOf("sub" to uid, "user_id" to uid)
            }
            val map = mutableMapOf<String, Any?>(
                "mode" to "as",
                "uid" to uid,
                "token" to tokenMap
            )
            if (tenant != null) map["tenant"] = tenant
            return map
        }
    }

    companion object {
        fun fromMap(map: Map<String, Any?>): AuthLens {
            val mode = (map["mode"] as? String)?.lowercase() ?: "anon"
            return when (mode) {
                "admin" -> Admin
                "app-session", "app_session" -> AppSession
                "as", "user" -> {
                    val uid = map["uid"] as? String ?: ""
                    @Suppress("UNCHECKED_CAST")
                    val token = map["token"] as? Map<String, Any?>
                    val tenant = map["tenant"] as? String
                    AsUser(uid = uid, token = token, tenant = tenant)
                }
                "anon", "anonymous" -> Anon
                else -> Anon
            }
        }
    }
}
