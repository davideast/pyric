package com.google.firebase.auth

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import dev.pyric.auth.BridgeAuthOperations
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.net.URI

class FirebaseUser internal constructor(
    internal val auth: FirebaseAuth,
    internal var rawData: Map<String, Any?>
) : UserInfo {

    @Suppress("UNCHECKED_CAST")
    var customClaims: Map<String, Any?> = (rawData["customClaims"] as? Map<String, Any?>)
        ?: (rawData["claims"] as? Map<String, Any?>)
        ?: emptyMap()
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

    val providerData: List<UserInfo>
        get() {
            @Suppress("UNCHECKED_CAST")
            val rawList = rawData["providerData"] as? List<Map<String, Any?>> ?: return emptyList()
            return rawList.map { p ->
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
        }

    fun getIdToken(forceRefresh: Boolean = false): Task<GetTokenResult> {
        val tcs = TaskCompletionSource<GetTokenResult>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                val res = BridgeAuthOperations.getIdTokenResult(auth.bridgeClient, forceRefresh)
                val token = res["token"] as? String ?: ""
                @Suppress("UNCHECKED_CAST")
                val claims = res["claims"] as? Map<String, Any?> ?: emptyMap()
                val exp = (res["expirationTime"] as? Number)?.toLong() ?: 0L
                val authTime = (res["authTime"] as? Number)?.toLong() ?: 0L
                val issuedAt = (res["issuedAtTime"] as? Number)?.toLong() ?: 0L
                val provider = res["signInProvider"] as? String
                customClaims = claims
                auth.notifyTokenRefreshed(this@FirebaseUser)
                tcs.setResult(GetTokenResult(token, claims, exp, authTime, issuedAt, provider))
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun getIdTokenResult(forceRefresh: Boolean = false): Task<GetTokenResult> =
        getIdToken(forceRefresh)

    fun updateProfile(request: UserProfileChangeRequest): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                val updated = BridgeAuthOperations.updateProfile(
                    auth.bridgeClient,
                    request.displayName,
                    request.photoUri?.toString()
                )
                rawData = updated
                @Suppress("UNCHECKED_CAST")
                (updated["customClaims"] as? Map<String, Any?> ?: updated["claims"] as? Map<String, Any?>)?.let {
                    customClaims = it
                }
                auth.notifyUserUpdated(this@FirebaseUser)
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun reload(): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                val user = BridgeAuthOperations.getCurrentUser(auth.bridgeClient)
                if (user != null) {
                    rawData = user
                    @Suppress("UNCHECKED_CAST")
                    (user["customClaims"] as? Map<String, Any?> ?: user["claims"] as? Map<String, Any?>)?.let {
                        customClaims = it
                    }
                }
                try {
                    val res = BridgeAuthOperations.getIdTokenResult(auth.bridgeClient, forceRefresh = true)
                    @Suppress("UNCHECKED_CAST")
                    val claims = res["claims"] as? Map<String, Any?>
                    if (claims != null) {
                        customClaims = claims
                    }
                } catch (_: Exception) {}
                auth.notifyUserUpdated(this@FirebaseUser)
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }
}
