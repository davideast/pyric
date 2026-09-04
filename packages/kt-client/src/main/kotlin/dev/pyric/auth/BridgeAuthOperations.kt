package dev.pyric.auth

import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

object BridgeAuthOperations {

    suspend fun createUser(client: PyricBridgeClient, email: String, password: String): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.createUser", mapOf("email" to email, "password" to password)) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun signInEmail(client: PyricBridgeClient, email: String, password: String): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.signInEmail", mapOf("email" to email, "password" to password)) as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun signInAnonymously(client: PyricBridgeClient): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.signInAnonymously", emptyMap()) as? Map<String, Any?> ?: emptyMap()
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

    suspend fun updateProfile(client: PyricBridgeClient, displayName: String?, photoURL: String?): Map<String, Any?> {
        val params = mutableMapOf<String, Any?>()
        if (displayName != null) params["displayName"] = displayName
        if (photoURL != null) params["photoURL"] = photoURL
        @Suppress("UNCHECKED_CAST")
        return client.op("auth.updateProfile", params) as? Map<String, Any?> ?: emptyMap()
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
