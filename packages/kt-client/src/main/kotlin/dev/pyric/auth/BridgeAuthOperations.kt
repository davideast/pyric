package dev.pyric.auth

import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

internal data class SequencedAuthResponse(
    val data: Map<String, Any?>,
    val wireSeq: Long
)

internal data class SequencedAuthSnapshot(
    val data: Map<String, Any?>?,
    val wireSeq: Long
)

object BridgeAuthOperations {

    suspend fun createUser(client: PyricBridgeClient, email: String, password: String, tenantId: String? = null): Map<String, Any?> =
        createUserSequenced(client, email, password, tenantId).data

    internal suspend fun createUserSequenced(
        client: PyricBridgeClient,
        email: String,
        password: String,
        tenantId: String? = null
    ): SequencedAuthResponse {
        val params = mutableMapOf<String, Any?>("email" to email, "password" to password)
        if (tenantId != null) params["tenantId"] = tenantId
        val res = client.opSequenced("auth.createUser", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun signInEmail(client: PyricBridgeClient, email: String, password: String, tenantId: String? = null): Map<String, Any?> =
        signInEmailSequenced(client, email, password, tenantId).data

    internal suspend fun signInEmailSequenced(
        client: PyricBridgeClient,
        email: String,
        password: String,
        tenantId: String? = null
    ): SequencedAuthResponse {
        val params = mutableMapOf<String, Any?>("email" to email, "password" to password)
        if (tenantId != null) params["tenantId"] = tenantId
        val res = client.opSequenced("auth.signInEmail", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun signInAnonymously(client: PyricBridgeClient, tenantId: String? = null): Map<String, Any?> =
        signInAnonymouslySequenced(client, tenantId).data

    internal suspend fun signInAnonymouslySequenced(
        client: PyricBridgeClient,
        tenantId: String? = null
    ): SequencedAuthResponse {
        val params = mutableMapOf<String, Any?>()
        if (tenantId != null) params["tenantId"] = tenantId
        val res = client.opSequenced("auth.signInAnonymously", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun signInWithCustomToken(
        client: PyricBridgeClient,
        customToken: String,
        tenantId: String? = null
    ): Map<String, Any?> = signInWithCustomTokenSequenced(client, customToken, tenantId).data

    internal suspend fun signInWithCustomTokenSequenced(
        client: PyricBridgeClient,
        customToken: String,
        tenantId: String? = null
    ): SequencedAuthResponse {
        val params = mutableMapOf<String, Any?>("customToken" to customToken)
        if (tenantId != null) params["tenantId"] = tenantId
        val res = client.opSequenced("auth.signInWithCustomToken", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun mockSignInResult(
        client: PyricBridgeClient,
        providerId: String,
        uid: String,
        email: String? = null,
        displayName: String? = null,
        photoURL: String? = null,
        emailVerified: Boolean? = null,
        customClaims: Map<String, Any?> = emptyMap()
    ) {
        val identity = mutableMapOf<String, Any?>(
            "uid" to uid,
            "providerId" to providerId,
            "email" to email,
            "displayName" to displayName,
            "photoURL" to photoURL,
            "customClaims" to customClaims
        )
        if (emailVerified != null) {
            identity["emailVerified"] = emailVerified
        }
        client.op("auth.mockSignInResult", mapOf("identity" to identity))
    }

    suspend fun reload(client: PyricBridgeClient, uid: String): Map<String, Any?>? =
        reloadSequenced(client, uid).data

    internal suspend fun reloadSequenced(client: PyricBridgeClient, uid: String): SequencedAuthSnapshot {
        val res = client.opSequenced("auth.reload", mapOf("uid" to uid))
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthSnapshot(res.value as? Map<String, Any?>, res.wireSeq)
    }

    suspend fun deleteUser(client: PyricBridgeClient) {
        deleteUserSequenced(client)
    }

    internal suspend fun deleteUserSequenced(client: PyricBridgeClient): Long =
        client.opSequenced("auth.deleteUser", emptyMap()).wireSeq

    suspend fun signInWithCredential(client: PyricBridgeClient, credential: Map<String, Any?>, tenantId: String? = null): Map<String, Any?> =
        signInWithCredentialSequenced(client, credential, tenantId).data

    internal suspend fun signInWithCredentialSequenced(
        client: PyricBridgeClient,
        credential: Map<String, Any?>,
        tenantId: String? = null
    ): SequencedAuthResponse {
        val params = mutableMapOf<String, Any?>("credential" to credential)
        if (tenantId != null) params["tenantId"] = tenantId
        val res = client.opSequenced("auth.signInWithCredential", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun signInWithCredential(client: PyricBridgeClient, credentialMap: Map<String, Any?>): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.signInWithCredential", credentialMap) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun signOut(client: PyricBridgeClient) {
        signOutSequenced(client)
    }

    internal suspend fun signOutSequenced(client: PyricBridgeClient): Long =
        client.opSequenced("auth.signOut", emptyMap()).wireSeq

    suspend fun getIdToken(client: PyricBridgeClient, forceRefresh: Boolean = false): String {
        return client.op("auth.getIdToken", mapOf("forceRefresh" to forceRefresh)) as? String ?: ""
    }

    suspend fun getIdTokenResult(client: PyricBridgeClient, forceRefresh: Boolean = false): Map<String, Any?> =
        getIdTokenResultSequenced(client, forceRefresh).data

    internal suspend fun getIdTokenResultSequenced(
        client: PyricBridgeClient,
        forceRefresh: Boolean = false
    ): SequencedAuthResponse {
        val res = client.opSequenced("auth.getIdTokenResult", mapOf("forceRefresh" to forceRefresh))
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun getCurrentUser(client: PyricBridgeClient): Map<String, Any?>? =
        getCurrentUserSequenced(client).data

    internal suspend fun getCurrentUserSequenced(client: PyricBridgeClient): SequencedAuthSnapshot {
        val res = client.opSequenced("auth.getCurrentUser", emptyMap())
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthSnapshot(res.value as? Map<String, Any?>, res.wireSeq)
    }

    suspend fun listUsers(client: PyricBridgeClient): List<Map<String, Any?>> {
        @Suppress("UNCHECKED_CAST")
        val list = client.op("auth.listUsers", emptyMap()) as? List<Map<String, Any?>>
        return list ?: emptyList()
    }

    suspend fun updateProfile(
        client: PyricBridgeClient,
        displayName: String?,
        photoURL: String?,
        includeDisplayName: Boolean = displayName != null,
        includePhotoURL: Boolean = photoURL != null
    ): Map<String, Any?> = updateProfileSequenced(client, displayName, photoURL, includeDisplayName, includePhotoURL).data

    internal suspend fun updateProfileSequenced(
        client: PyricBridgeClient,
        displayName: String?,
        photoURL: String?,
        includeDisplayName: Boolean = displayName != null,
        includePhotoURL: Boolean = photoURL != null
    ): SequencedAuthResponse {
        val params = mutableMapOf<String, Any?>()
        if (includeDisplayName) params["displayName"] = displayName
        if (includePhotoURL) params["photoURL"] = photoURL
        val res = client.opSequenced("auth.updateProfile", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun linkWithCredential(
        client: PyricBridgeClient,
        uid: String,
        credential: Map<String, Any?>,
        tenantId: String? = null
    ): Map<String, Any?> = linkWithCredentialSequenced(client, uid, credential, tenantId).data

    internal suspend fun linkWithCredentialSequenced(
        client: PyricBridgeClient,
        uid: String,
        credential: Map<String, Any?>,
        tenantId: String? = null
    ): SequencedAuthResponse {
        val params = LinkedHashMap<String, Any?>()
        params["uid"] = uid
        params["credential"] = credential
        params["tenantId"] = tenantId
        val res = client.opSequenced("auth.linkWithCredential", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun reauthenticateWithCredential(
        client: PyricBridgeClient,
        uid: String,
        credential: Map<String, Any?>,
        tenantId: String? = null
    ): Map<String, Any?> = reauthenticateWithCredentialSequenced(client, uid, credential, tenantId).data

    internal suspend fun reauthenticateWithCredentialSequenced(
        client: PyricBridgeClient,
        uid: String,
        credential: Map<String, Any?>,
        tenantId: String? = null
    ): SequencedAuthResponse {
        val params = LinkedHashMap<String, Any?>()
        params["uid"] = uid
        params["credential"] = credential
        params["tenantId"] = tenantId
        val res = client.opSequenced("auth.reauthenticateWithCredential", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun unlink(
        client: PyricBridgeClient,
        uid: String,
        providerId: String,
        tenantId: String? = null
    ): Map<String, Any?> = unlinkSequenced(client, uid, providerId, tenantId).data

    internal suspend fun unlinkSequenced(
        client: PyricBridgeClient,
        uid: String,
        providerId: String,
        tenantId: String? = null
    ): SequencedAuthResponse {
        val params = LinkedHashMap<String, Any?>()
        params["uid"] = uid
        params["providerId"] = providerId
        params["tenantId"] = tenantId
        val res = client.opSequenced("auth.unlink", params)
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun updatePassword(client: PyricBridgeClient, password: String): Map<String, Any?> =
        updatePasswordSequenced(client, password).data

    internal suspend fun updatePasswordSequenced(client: PyricBridgeClient, password: String): SequencedAuthResponse {
        val res = client.opSequenced("auth.updatePassword", mapOf("password" to password))
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    suspend fun updateEmail(client: PyricBridgeClient, email: String): Map<String, Any?> =
        updateEmailSequenced(client, email).data

    internal suspend fun updateEmailSequenced(client: PyricBridgeClient, email: String): SequencedAuthResponse {
        val res = client.opSequenced("auth.updateEmail", mapOf("email" to email))
        @Suppress("UNCHECKED_CAST")
        return SequencedAuthResponse(res.value as? Map<String, Any?> ?: emptyMap(), res.wireSeq)
    }

    fun subscribeAuthState(client: PyricBridgeClient): Flow<Map<String, Any?>?> {
        return client.subscribe("authState").map { raw ->
            @Suppress("UNCHECKED_CAST")
            raw as? Map<String, Any?>
        }
    }

    internal fun subscribeAuthStateSequenced(client: PyricBridgeClient): Flow<SequencedAuthSnapshot> =
        client.subscribeSequenced("authState").map { snap ->
            @Suppress("UNCHECKED_CAST")
            SequencedAuthSnapshot(snap.value as? Map<String, Any?>, snap.wireSeq)
        }

    fun subscribeIdToken(client: PyricBridgeClient): Flow<Map<String, Any?>?> {
        return client.subscribe("idToken").map { raw ->
            @Suppress("UNCHECKED_CAST")
            raw as? Map<String, Any?>
        }
    }

    internal fun subscribeIdTokenSequenced(client: PyricBridgeClient): Flow<SequencedAuthSnapshot> =
        client.subscribeSequenced("idToken").map { snap ->
            @Suppress("UNCHECKED_CAST")
            SequencedAuthSnapshot(snap.value as? Map<String, Any?>, snap.wireSeq)
        }
}
