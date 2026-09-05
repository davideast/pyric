package dev.pyric.debug.model

data class SandboxUser(
    val uid: String,
    val email: String? = null,
    val displayName: String? = null,
    val photoUrl: String? = null,
    val isAnonymous: Boolean = false,
    val customClaims: Map<String, Any?> = emptyMap(),
    val createdAt: String? = null,
    val lastLoginAt: String? = null,
    val disabled: Boolean = false
) {
    val displayInitials: String
        get() {
            if (!displayName.isNullOrBlank()) {
                val parts = displayName.trim().split("\\s+".toRegex())
                return if (parts.size >= 2) {
                    "${parts[0].first().uppercase()}${parts[1].first().uppercase()}"
                } else {
                    parts[0].take(2).uppercase()
                }
            }
            if (!email.isNullOrBlank()) {
                return email.take(2).uppercase()
            }
            return if (isAnonymous) "?" else uid.take(2).uppercase()
        }

    val tenantId: String?
        get() {
            val direct = customClaims["tenant"] as? String
            if (!direct.isNullOrEmpty()) return direct
            @Suppress("UNCHECKED_CAST")
            val firebaseClaim = customClaims["firebase"] as? Map<String, Any?>
            return firebaseClaim?.get("tenant") as? String
        }

    val role: String?
        get() = (customClaims["role"] as? String)
            ?: if (customClaims["admin"] == true) "admin" else null

    companion object {
        fun fromMap(map: Map<String, Any?>): SandboxUser {
            val uid = map["uid"] as? String ?: ""
            val email = map["email"] as? String
            val displayName = map["displayName"] as? String
            val photoUrl = (map["photoUrl"] ?: map["photoURL"]) as? String
            val isAnonymous = map["isAnonymous"] == true
            val disabled = map["disabled"] == true
            val createdAt = map["createdAt"] as? String
            val lastLoginAt = map["lastLoginAt"] as? String
            @Suppress("UNCHECKED_CAST")
            val claims = (map["customClaims"] as? Map<String, Any?>)
                ?: (map["claims"] as? Map<String, Any?>)
                ?: emptyMap()

            return SandboxUser(
                uid = uid,
                email = email,
                displayName = displayName,
                photoUrl = photoUrl,
                isAnonymous = isAnonymous,
                customClaims = claims,
                createdAt = createdAt,
                lastLoginAt = lastLoginAt,
                disabled = disabled
            )
        }
    }
}
