package dev.pyric.auth

import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

object BridgeAuthOperations {

    suspend fun createUser(client: PyricBridgeClient, email: String, password: String, tenantId: String? = null): Map<String, Any?> {
        val params = mutableMapOf<String, Any?>("email" to email, "password" to password)
        if (tenantId != null) params["tenantId"] = tenantId
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.createUser", params) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun signInEmail(client: PyricBridgeClient, email: String, password: String, tenantId: String? = null): Map<String, Any?> {
        val params = mutableMapOf<String, Any?>("email" to email, "password" to password)
        if (tenantId != null) params["tenantId"] = tenantId
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.signInEmail", params) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun signInAnonymously(client: PyricBridgeClient, tenantId: String? = null): Map<String, Any?> {
        val params = mutableMapOf<String, Any?>()
        if (tenantId != null) params["tenantId"] = tenantId
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.signInAnonymously", params) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun signInWithCustomToken(
        client: PyricBridgeClient,
        customToken: String,
        tenantId: String? = null
    ): Map<String, Any?> {
        val params = mutableMapOf<String, Any?>("customToken" to customToken)
        if (tenantId != null) params["tenantId"] = tenantId
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.signInWithCustomToken", params) as? Map<String, Any?> ?: emptyMap()
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

    suspend fun reload(client: PyricBridgeClient, uid: String): Map<String, Any?>? {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.reload", mapOf("uid" to uid)) as? Map<String, Any?>
    }

    suspend fun deleteUser(client: PyricBridgeClient) {
        client.op("auth.deleteUser", emptyMap())
    }

    suspend fun signInWithCredential(client: PyricBridgeClient, credential: Map<String, Any?>, tenantId: String? = null): Map<String, Any?> {
        val params = mutableMapOf<String, Any?>("credential" to credential)
        if (tenantId != null) params["tenantId"] = tenantId
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.signInWithCredential", params) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun signInWithCredential(client: PyricBridgeClient, credentialMap: Map<String, Any?>): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.signInWithCredential", credentialMap) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun signOut(client: PyricBridgeClient) {
        client.op("auth.signOut", emptyMap())
    }

    suspend fun getIdToken(client: PyricBridgeClient, forceRefresh: Boolean = false): String {
        return client.op("auth.getIdToken", mapOf("forceRefresh" to forceRefresh)) as? String ?: ""
    }

    suspend fun getIdTokenResult(client: PyricBridgeClient, forceRefresh: Boolean = false): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.getIdTokenResult", mapOf("forceRefresh" to forceRefresh)) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun getCurrentUser(client: PyricBridgeClient): Map<String, Any?>? {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.getCurrentUser", emptyMap()) as? Map<String, Any?>
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
    ): Map<String, Any?> {
        val params = mutableMapOf<String, Any?>()
        if (includeDisplayName) params["displayName"] = displayName
        if (includePhotoURL) params["photoURL"] = photoURL
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.updateProfile", params) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun linkWithCredential(
        client: PyricBridgeClient,
        uid: String,
        credential: Map<String, Any?>,
        tenantId: String? = null
    ): Map<String, Any?> {
        val params = LinkedHashMap<String, Any?>()
        params["uid"] = uid
        params["credential"] = credential
        params["tenantId"] = tenantId
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.linkWithCredential", params) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun reauthenticateWithCredential(
        client: PyricBridgeClient,
        uid: String,
        credential: Map<String, Any?>,
        tenantId: String? = null
    ): Map<String, Any?> {
        val params = LinkedHashMap<String, Any?>()
        params["uid"] = uid
        params["credential"] = credential
        params["tenantId"] = tenantId
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.reauthenticateWithCredential", params) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun unlink(
        client: PyricBridgeClient,
        uid: String,
        providerId: String,
        tenantId: String? = null
    ): Map<String, Any?> {
        val params = LinkedHashMap<String, Any?>()
        params["uid"] = uid
        params["providerId"] = providerId
        params["tenantId"] = tenantId
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.unlink", params) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun updatePassword(client: PyricBridgeClient, password: String): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.updatePassword", mapOf("password" to password)) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun updateEmail(client: PyricBridgeClient, email: String): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.updateEmail", mapOf("email" to email)) as? Map<String, Any?> ?: emptyMap()
    }

    fun subscribeAuthState(client: PyricBridgeClient): Flow<Map<String, Any?>?> {
        return client.subscribe("authState").map { raw ->
            @Suppress("UNCHECKED_CAST")
            raw as? Map<String, Any?>
        }
    }

    fun subscribeIdToken(client: PyricBridgeClient): Flow<Map<String, Any?>?> {
        return client.subscribe("idToken").map { raw ->
            @Suppress("UNCHECKED_CAST")
            raw as? Map<String, Any?>
        }
    }
}
