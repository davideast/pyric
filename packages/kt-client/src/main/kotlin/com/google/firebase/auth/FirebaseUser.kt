package com.google.firebase.auth

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.firebase.FirebaseException
import dev.pyric.auth.BridgeAuthOperations
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.net.URI
import java.time.Instant

class FirebaseUser internal constructor(
    internal val auth: FirebaseAuth,
    @Volatile internal var rawData: Map<String, Any?>,
    @Volatile internal var signInProviderOverride: String? = null
) : UserInfo {

    @Volatile
    @Suppress("UNCHECKED_CAST")
    var customClaims: Map<String, Any?> = extractCustomClaims(
        (rawData["customClaims"] as? Map<String, Any?>)
            ?: (rawData["claims"] as? Map<String, Any?>)
    )
        internal set

    override val uid: String get() = rawData["uid"] as? String ?: ""
    override val email: String? get() = rawData["email"] as? String
    override val displayName: String? get() = rawData["displayName"] as? String
    override val photoUrl: URI? get() = (rawData["photoURL"] as? String)?.let { runCatching { URI.create(it) }.getOrNull() }
    val photoUrlString: String? get() = rawData["photoURL"] as? String
    override val phoneNumber: String? get() = rawData["phoneNumber"] as? String
    val isAnonymous: Boolean get() = rawData["isAnonymous"] as? Boolean ?: false
    override val isEmailVerified: Boolean get() = rawData["emailVerified"] as? Boolean ?: false
    override val providerId: String get() = rawData["providerId"] as? String ?: "firebase"
    val tenantId: String? get() = (rawData["tenantId"] as? String) ?: auth.tenantId

    private fun buildMasterFirebaseUserInfo(): UserInfo {
        val masterUid = uid
        val masterEmail = email
        val masterDisplayName = displayName
        val masterPhotoUrl = photoUrl
        val masterPhone = phoneNumber
        val masterEmailVerified = isEmailVerified
        return object : UserInfo {
            override val uid: String = masterUid
            override val email: String? = masterEmail
            override val displayName: String? = masterDisplayName
            override val photoUrl: URI? = masterPhotoUrl
            override val phoneNumber: String? = masterPhone
            override val providerId: String = "firebase"
            override val isEmailVerified: Boolean = masterEmailVerified
        }
    }

    val providerData: List<UserInfo>
        get() {
            @Suppress("UNCHECKED_CAST")
            val rawList = rawData["providerData"] as? List<Map<String, Any?>> ?: emptyList()
            val mapped = rawList.map { p ->
                val pUid = p["uid"] as? String ?: ""
                val pEmail = p["email"] as? String
                val pDisplayName = p["displayName"] as? String
                val pPhotoUrl = (p["photoURL"] as? String)?.let { runCatching { URI.create(it) }.getOrNull() }
                val pPhone = p["phoneNumber"] as? String
                val pProviderId = p["providerId"] as? String ?: ""
                val pEmailVerified = p["emailVerified"] as? Boolean ?: false

                object : UserInfo {
                    override val uid: String = pUid
                    override val email: String? = pEmail
                    override val displayName: String? = pDisplayName
                    override val photoUrl: URI? = pPhotoUrl
                    override val phoneNumber: String? = pPhone
                    override val providerId: String = pProviderId
                    override val isEmailVerified: Boolean = pEmailVerified
                }
            }
            val existingFirebase = mapped.firstOrNull { it.providerId == "firebase" }
            if (existingFirebase != null) {
                if (mapped.first().providerId == "firebase" && mapped.count { it.providerId == "firebase" } == 1) {
                    return mapped
                }
                val linkedProviders = mapped.filter { it.providerId != "firebase" }
                return listOf(existingFirebase) + linkedProviders
            }
            return listOf(buildMasterFirebaseUserInfo()) + mapped
        }

    internal fun resolveSignInProvider(): String {
        signInProviderOverride?.takeIf { it.isNotBlank() }?.let { return it }
        if (isAnonymous) return "anonymous"
        for (info in providerData) {
            val pid = info.providerId
            if (pid.isNotBlank() && pid != "firebase") {
                return pid
            }
        }
        val primary = rawData["providerId"] as? String
        if (!primary.isNullOrBlank() && primary != "firebase") {
            return primary
        }
        if (email != null) return "password"
        if (phoneNumber != null) return "phone"
        return "custom"
    }

    internal fun buildJwtClaims(): Map<String, Any?> {
        val result = LinkedHashMap<String, Any?>()
        displayName?.let { result["name"] = it }
        photoUrlString?.let { result["picture"] = it }
        result.putAll(customClaims)
        result["sub"] = uid
        result["user_id"] = uid
        if (isAnonymous) {
            result["provider_id"] = "anonymous"
        }
        val identities = LinkedHashMap<String, List<String>>()
        email?.let { userEmail ->
            result["email"] = userEmail
            result["email_verified"] = isEmailVerified
            identities["email"] = listOf(userEmail)
        }
        phoneNumber?.let { phone ->
            result["phone_number"] = phone
            identities["phone"] = listOf(phone)
        }
        for (info in providerData) {
            val pid = info.providerId
            if (pid.isNotBlank() && pid !in NON_FEDERATED_PROVIDER_IDS) {
                val linkedUid = info.uid.ifBlank { uid }
                identities[pid] = listOf(linkedUid)
            }
        }
        result["firebase"] = mapOf(
            "identities" to identities,
            "sign_in_provider" to resolveSignInProvider()
        )
        return result
    }

    fun getIdToken(forceRefresh: Boolean = false): Task<GetTokenResult> {
        val tcs = TaskCompletionSource<GetTokenResult>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.getIdTokenResult(auth.bridgeClient, forceRefresh)
                val token = res["token"] as? String ?: ""
                @Suppress("UNCHECKED_CAST")
                val claims = res["claims"] as? Map<String, Any?> ?: emptyMap()
                val exp = parseTimestampSeconds(res["expirationTime"], claims["exp"])
                val authTime = parseTimestampSeconds(res["authTime"], claims["auth_time"])
                val issuedAt = parseTimestampSeconds(res["issuedAtTime"], claims["iat"])
                @Suppress("UNCHECKED_CAST")
                val firebaseMap = claims["firebase"] as? Map<String, Any?>
                val provider = (res["signInProvider"] as? String)
                    ?: (firebaseMap?.get("sign_in_provider") as? String)
                if (!provider.isNullOrBlank()) {
                    signInProviderOverride = provider
                }
                customClaims = extractCustomClaims(claims)
                auth.notifyTokenRefreshed(this@FirebaseUser)
                tcs.setResult(GetTokenResult(token, claims, exp, authTime, issuedAt, provider))
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    fun getIdTokenResult(forceRefresh: Boolean = false): Task<GetTokenResult> =
        getIdToken(forceRefresh)

    fun updateProfile(request: UserProfileChangeRequest): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val updated = BridgeAuthOperations.updateProfile(
                    auth.bridgeClient,
                    request.displayName,
                    request.photoUri?.toString(),
                    includeDisplayName = request.displayNameSet,
                    includePhotoURL = request.photoUriSet
                )
                rawData = updated
                @Suppress("UNCHECKED_CAST")
                (updated["customClaims"] as? Map<String, Any?> ?: updated["claims"] as? Map<String, Any?>)?.let {
                    customClaims = extractCustomClaims(it)
                }
                auth.notifyUserUpdated(this@FirebaseUser)
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(auth.wrapException(e))
            }
        }
        return tcs.task
    }

    fun reload(): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val user = BridgeAuthOperations.reload(auth.bridgeClient, uid)
                    ?: BridgeAuthOperations.getCurrentUser(auth.bridgeClient)
                if (user != null) {
                    rawData = user
                    @Suppress("UNCHECKED_CAST")
                    (user["customClaims"] as? Map<String, Any?> ?: user["claims"] as? Map<String, Any?>)?.let {
                        customClaims = extractCustomClaims(it)
                    }
                }
                auth.notifyUserUpdated(this@FirebaseUser)
                tcs.setResult(null)
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    fun delete(): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                BridgeAuthOperations.deleteUser(auth.bridgeClient)
                auth.clearCurrentUserAfterDelete(uid)
                tcs.setResult(null)
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    fun linkWithCredential(credential: AuthCredential): Task<AuthResult> {
        if (providerData.any { it.providerId == credential.provider }) {
            val failed = TaskCompletionSource<AuthResult>()
            failed.setException(FirebaseException("User has already been linked to the given provider."))
            return failed.task
        }
        val tcs = TaskCompletionSource<AuthResult>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.linkWithCredential(
                    auth.bridgeClient,
                    uid,
                    credential.toWireMap(),
                    tenantId
                )
                val enriched = auth.enrichSignInResponseIfNeeded(res)
                tcs.setResult(applyCredentialOperationResult(enriched, credential.provider))
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    fun reauthenticate(credential: AuthCredential): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.reauthenticateWithCredential(
                    auth.bridgeClient,
                    uid,
                    credential.toWireMap(),
                    tenantId
                )
                applyCredentialOperationResult(res, credential.provider)
                tcs.setResult(null)
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    fun reauthenticateAndRetrieveData(credential: AuthCredential): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.reauthenticateWithCredential(
                    auth.bridgeClient,
                    uid,
                    credential.toWireMap(),
                    tenantId
                )
                val enriched = auth.enrichSignInResponseIfNeeded(res)
                tcs.setResult(applyCredentialOperationResult(enriched, credential.provider))
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    fun unlink(provider: String): Task<AuthResult> {
        require(provider.isNotEmpty()) { "Given String is empty or null" }
        val tcs = TaskCompletionSource<AuthResult>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.unlink(auth.bridgeClient, uid, provider, tenantId)
                @Suppress("UNCHECKED_CAST")
                val updated = (res["user"] as? Map<String, Any?>) ?: res
                if (updated["uid"] is String) {
                    applyUpdatedUserMap(updated)
                }
                auth.notifyUserUpdated(this@FirebaseUser)
                tcs.setResult(AuthResult(this@FirebaseUser, null))
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    fun updatePassword(password: String): Task<Void?> {
        require(password.isNotEmpty()) { "Given String is empty or null" }
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val updated = BridgeAuthOperations.updatePassword(auth.bridgeClient, password)
                if (updated["uid"] is String) {
                    applyUpdatedUserMap(updated)
                }
                auth.notifyUserUpdated(this@FirebaseUser)
                tcs.setResult(null)
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    fun updateEmail(email: String): Task<Void?> {
        require(email.isNotEmpty()) { "Given String is empty or null" }
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val updated = BridgeAuthOperations.updateEmail(auth.bridgeClient, email)
                if (updated["uid"] is String) {
                    applyUpdatedUserMap(updated)
                }
                auth.notifyUserUpdated(this@FirebaseUser)
                tcs.setResult(null)
            } catch (e: Exception) {
                val wrapped = auth.wrapException(e)
                auth.clearCurrentUserIfInvalidated(wrapped, uid)
                tcs.setException(wrapped)
            }
        }
        return tcs.task
    }

    private fun applyCredentialOperationResult(
        res: Map<String, Any?>,
        fallbackProvider: String
    ): AuthResult {
        @Suppress("UNCHECKED_CAST")
        val userMap = (res["user"] as? Map<String, Any?>) ?: res
        @Suppress("UNCHECKED_CAST")
        val addInfo = res["additionalUserInfo"] as? Map<String, Any?>
        val explicitProviderId = (addInfo?.get("providerId") as? String) ?: (res["providerId"] as? String)
        if (userMap["uid"] is String) {
            applyUpdatedUserMap(userMap, res)
        }
        val effectiveProvider = explicitProviderId ?: fallbackProvider
        if (effectiveProvider.isNotBlank()) {
            signInProviderOverride = effectiveProvider
        }
        auth.notifyUserUpdated(this)
        val isNew = (addInfo?.get("isNewUser") as? Boolean) ?: false
        return AuthResult(this, AdditionalUserInfo(explicitProviderId ?: fallbackProvider, isNew))
    }

    private fun applyUpdatedUserMap(
        userMap: Map<String, Any?>,
        envelope: Map<String, Any?>? = null
    ) {
        rawData = userMap
        @Suppress("UNCHECKED_CAST")
        val claims = (userMap["customClaims"] as? Map<String, Any?>)
            ?: (userMap["claims"] as? Map<String, Any?>)
            ?: (envelope?.get("customClaims") as? Map<String, Any?>)
            ?: (envelope?.get("claims") as? Map<String, Any?>)
        if (claims != null) {
            customClaims = extractCustomClaims(claims)
        }
    }

    companion object {
        private val NON_FEDERATED_PROVIDER_IDS = setOf("password", "phone", "anonymous", "firebase")

        internal val STANDARD_JWT_CLAIM_KEYS = setOf(
            "firebase",
            "uid",
            "user_id",
            "sub",
            "iss",
            "aud",
            "iat",
            "exp",
            "auth_time",
            "email",
            "email_verified",
            "phone_number",
            "name",
            "picture",
            "nonce",
            "provider_id"
        )

        internal fun extractCustomClaims(claims: Map<String, Any?>?): Map<String, Any?> {
            if (claims == null || claims.isEmpty()) return emptyMap()
            val filtered = LinkedHashMap<String, Any?>()
            for ((key, value) in claims) {
                if (key !in STANDARD_JWT_CLAIM_KEYS) {
                    filtered[key] = value
                }
            }
            return filtered
        }

        internal fun parseTimestampSeconds(rawTime: Any?, claimValue: Any?): Long {
            if (rawTime is Number) return rawTime.toLong()
            if (rawTime is String && rawTime.isNotBlank()) {
                val asLong = rawTime.toLongOrNull()
                if (asLong != null) return asLong
                val parsed = runCatching { Instant.parse(rawTime).epochSecond }.getOrNull()
                if (parsed != null) return parsed
            }
            if (claimValue is Number) return claimValue.toLong()
            return 0L
        }
    }
}
