package com.google.firebase.auth

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import dev.pyric.auth.BridgeAuthOperations
import dev.pyric.auth.CredentialsProvider
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

class FirebaseAuth internal constructor(
    val app: FirebaseApp,
    val bridgeClient: PyricBridgeClient,
    dispatcher: CoroutineDispatcher = Dispatchers.IO
) : CredentialsProvider {

    private val scope = CoroutineScope(dispatcher)
    private val sync = FirebaseAuthBridgeSync(this, scope)

    val currentUser: FirebaseUser?
        get() = sync.currentUser

    val lensOverrideFlow: StateFlow<AuthLens?>
        get() = sync.lensOverrideFlow

    override val authLensFlow: StateFlow<AuthLens>
        get() = sync.authLensFlow

    fun setAuthLens(lens: AuthLens?) {
        sync.setAuthLens(lens)
    }

    fun clearAuthLensOverride() {
        setAuthLens(null)
    }

    var tenantId: String?
        get() = sync.tenantId
        set(value) {
            sync.tenantId = value
        }

    @Volatile
    private var _languageCode: String? = null

    val languageCode: String?
        get() = _languageCode

    fun setLanguageCode(languageCode: String) {
        require(languageCode.isNotEmpty()) { "Given String is empty or null" }
        _languageCode = languageCode
    }

    fun useAppLanguage() {
        _languageCode = java.util.Locale.getDefault().toLanguageTag().ifBlank { "en" }
    }

    private class ActiveListenerEntry<T>(val listener: T) {
        val active = AtomicBoolean(true)
    }

    private val authStateListeners = CopyOnWriteArrayList<ActiveListenerEntry<AuthStateListener>>()
    private val idTokenListeners = CopyOnWriteArrayList<ActiveListenerEntry<IdTokenListener>>()

    init {
        // A replaced bridge host holds no user for this session. Sign the session
        // back in before the observers are re-sent.
        bridgeClient.restoreAuth = { op ->
            val user = currentUser
            if (user != null) {
                op("auth.restorePortSession", mapOf("uid" to user.uid, "tenantId" to user.tenantId))
            }
        }
        sync.startSubscriptions()
    }

    override fun getEffectiveLens(): AuthLens = sync.getEffectiveLens()

    fun signInWithEmailAndPassword(email: String, password: String): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.signInEmailSequenced(bridgeClient, email, password, tenantId)
                val enriched = enrichSignInResponseIfNeeded(res.data)
                val authResult = sync.handleAuthSuccess(enriched, res.wireSeq)
                tcs.setResult(authResult)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    fun createUserWithEmailAndPassword(email: String, password: String): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.createUserSequenced(bridgeClient, email, password, tenantId)
                val authResult = sync.handleAuthSuccess(res.data, res.wireSeq)
                tcs.setResult(authResult)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    fun signInAnonymously(): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.signInAnonymouslySequenced(bridgeClient, tenantId)
                val authResult = sync.handleAuthSuccess(res.data, res.wireSeq, defaultSignInProvider = "anonymous")
                tcs.setResult(authResult)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    fun signInWithCustomToken(token: String): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.signInWithCustomTokenSequenced(bridgeClient, token, tenantId)
                val enriched = enrichSignInResponseIfNeeded(res.data)
                val authResult = sync.handleAuthSuccess(enriched, res.wireSeq, defaultSignInProvider = "custom")
                tcs.setResult(authResult)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    fun signInWithCredential(credential: Map<String, Any?>): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.signInWithCredentialSequenced(bridgeClient, credential, tenantId)
                val enriched = enrichSignInResponseIfNeeded(res.data)
                val fallbackProvider = credential["providerId"] as? String
                val authResult = sync.handleAuthSuccess(enriched, res.wireSeq, defaultSignInProvider = fallbackProvider)
                tcs.setResult(authResult)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    fun signInWithCredential(credential: AuthCredential): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.signInWithCredentialSequenced(
                    bridgeClient,
                    credential.toWireMap(),
                    tenantId
                )
                val enriched = enrichSignInResponseIfNeeded(res.data)
                val authResult = sync.handleAuthSuccess(enriched, res.wireSeq, defaultSignInProvider = credential.provider)
                tcs.setResult(authResult)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    internal suspend fun enrichSignInResponseIfNeeded(res: Map<String, Any?>): Map<String, Any?> =
        sync.enrichSignInResponseIfNeeded(res)

    /**
     * Stages a federated provider identity on this FirebaseAuth instance's active
     * bridge connection so the next `signInWithCredential` for [providerId] resolves
     * against the live Pyric host (`auth.mockSignInResult`).
     */
    @JvmOverloads
    fun stageSignInResult(
        providerId: String,
        uid: String,
        email: String? = null,
        displayName: String? = null,
        photoUrl: String? = null,
        emailVerified: Boolean? = null,
        customClaims: Map<String, Any?> = emptyMap()
    ): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                BridgeAuthOperations.mockSignInResult(
                    client = bridgeClient,
                    providerId = providerId,
                    uid = uid,
                    email = email,
                    displayName = displayName,
                    photoURL = photoUrl,
                    emailVerified = emailVerified,
                    customClaims = customClaims
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    fun signOut() {
        // Signing out is synchronous in the Firebase Android SDK: when this
        // returns, currentUser is null and the next request is unauthenticated.
        // Clear the local session first; the host is told afterwards.
        sync.signOutLocal()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                BridgeAuthOperations.signOutSequenced(bridgeClient)
            } catch (_: Exception) {}
        }
    }

    fun authStateFlow(): StateFlow<FirebaseUser?> = sync.currentUserFlow

    fun idTokenFlow(): Flow<FirebaseUser?> = flow {
        val channel = Channel<FirebaseUser?>(Channel.UNLIMITED)
        val listener = IdTokenListener { auth ->
            channel.trySend(auth.currentUser)
        }
        addIdTokenListener(listener)
        try {
            for (user in channel) {
                emit(user)
            }
        } finally {
            removeIdTokenListener(listener)
            channel.close()
            while (channel.tryReceive().isSuccess) {}
        }
    }

    fun addAuthStateListener(listener: AuthStateListener) {
        val entry = ActiveListenerEntry(listener)
        authStateListeners.add(entry)
        if (entry.active.get()) {
            listener.onAuthStateChanged(this)
        }
    }

    fun removeAuthStateListener(listener: AuthStateListener) {
        val entry = authStateListeners.firstOrNull {
            it.listener == listener && it.active.compareAndSet(true, false)
        }
        if (entry != null) {
            authStateListeners.remove(entry)
        }
    }

    fun addIdTokenListener(listener: IdTokenListener) {
        val entry = ActiveListenerEntry(listener)
        idTokenListeners.add(entry)
        if (entry.active.get()) {
            listener.onIdTokenChanged(this)
        }
    }

    fun removeIdTokenListener(listener: IdTokenListener) {
        val entry = idTokenListeners.firstOrNull {
            it.listener == listener && it.active.compareAndSet(true, false)
        }
        if (entry != null) {
            idTokenListeners.remove(entry)
        }
    }

    internal fun commitUserMutation(user: FirebaseUser, wireSeq: Long = 0L, mutate: () -> Unit): Boolean =
        sync.commitUserMutation(user, wireSeq, mutate)

    internal fun notifyTokenRefreshed(user: FirebaseUser, wireSeq: Long = 0L) {
        sync.notifyTokenRefreshed(user, wireSeq)
    }

    internal fun notifyUserUpdated(user: FirebaseUser, wireSeq: Long = 0L) {
        sync.notifyUserUpdated(user, wireSeq)
    }

    internal fun clearCurrentUserIfInvalidated(error: Exception, targetUid: String) {
        sync.clearCurrentUserIfInvalidated(error, targetUid)
    }

    internal fun clearCurrentUserAfterDelete(targetUid: String, wireSeq: Long = 0L) {
        sync.clearCurrentUserAfterDelete(targetUid, wireSeq)
    }

    internal fun notifyAuthStateChanged() {
        for (entry in authStateListeners) {
            if (entry.active.get()) entry.listener.onAuthStateChanged(this)
        }
    }

    internal fun notifyIdTokenChanged() {
        for (entry in idTokenListeners) {
            if (entry.active.get()) entry.listener.onIdTokenChanged(this)
        }
    }

    internal fun wrapException(e: Exception): Exception {
        if (e is FirebaseAuthException) return e
        val rawWireCode = (e as? FirebaseFirestoreException)?.wireCode?.lowercase() ?: ""
        val msg = e.message ?: "Authentication error"
        val combined = if (rawWireCode.isNotEmpty()) "$rawWireCode $msg" else msg
        if (combined.contains("provider-already-linked", ignoreCase = true)) {
            return FirebaseException("User has already been linked to the given provider.", e)
        }
        val code = when {
            combined.contains("custom-token-mismatch", ignoreCase = true) -> "ERROR_CUSTOM_TOKEN_MISMATCH"
            combined.contains("invalid-custom-token", ignoreCase = true) -> "ERROR_INVALID_CUSTOM_TOKEN"
            combined.contains("user-token-expired", ignoreCase = true) -> "ERROR_USER_TOKEN_EXPIRED"
            combined.contains("user-not-found", ignoreCase = true) -> "ERROR_USER_NOT_FOUND"
            combined.contains("wrong-password", ignoreCase = true) -> "ERROR_WRONG_PASSWORD"
            combined.contains("email-already-in-use", ignoreCase = true) -> "ERROR_EMAIL_ALREADY_IN_USE"
            combined.contains("account-exists-with-different-credential", ignoreCase = true) ->
                "ERROR_ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL"
            combined.contains("credential-already-in-use", ignoreCase = true) -> "ERROR_CREDENTIAL_ALREADY_IN_USE"
            combined.contains("invalid-email", ignoreCase = true) -> "ERROR_INVALID_EMAIL"
            combined.contains("weak-password", ignoreCase = true) -> "ERROR_WEAK_PASSWORD"
            combined.contains("operation-not-allowed", ignoreCase = true) -> "ERROR_OPERATION_NOT_ALLOWED"
            combined.contains("user-disabled", ignoreCase = true) -> "ERROR_USER_DISABLED"
            combined.contains("invalid-credential", ignoreCase = true) -> "ERROR_INVALID_CREDENTIAL"
            combined.contains("requires-recent-login", ignoreCase = true) -> "ERROR_REQUIRES_RECENT_LOGIN"
            combined.contains("too-many-requests", ignoreCase = true) -> "ERROR_TOO_MANY_REQUESTS"
            combined.contains("no-such-provider", ignoreCase = true) -> "ERROR_NO_SUCH_PROVIDER"
            combined.contains("user-mismatch", ignoreCase = true) -> "ERROR_USER_MISMATCH"
            combined.contains("no-mock-configured", ignoreCase = true) -> "ERROR_INVALID_CREDENTIAL"
            else -> "ERROR_UNKNOWN"
        }
        // The same subclasses the Firebase Android SDK throws for these codes.
        return when (code) {
            "ERROR_USER_NOT_FOUND", "ERROR_USER_DISABLED", "ERROR_USER_TOKEN_EXPIRED" ->
                FirebaseAuthInvalidUserException(code, msg, e)
            "ERROR_WRONG_PASSWORD", "ERROR_INVALID_EMAIL", "ERROR_INVALID_CREDENTIAL",
            "ERROR_INVALID_CUSTOM_TOKEN", "ERROR_CUSTOM_TOKEN_MISMATCH" ->
                FirebaseAuthInvalidCredentialsException(code, msg, e)
            "ERROR_EMAIL_ALREADY_IN_USE", "ERROR_ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL",
            "ERROR_CREDENTIAL_ALREADY_IN_USE" ->
                FirebaseAuthUserCollisionException(code, msg, e)
            "ERROR_WEAK_PASSWORD" ->
                FirebaseAuthWeakPasswordException(code, msg, reason = msg, cause = e)
            "ERROR_REQUIRES_RECENT_LOGIN" ->
                FirebaseAuthRecentLoginRequiredException(code, msg, e)
            else -> FirebaseAuthException(code, msg, e)
        }
    }

    fun interface AuthStateListener {
        fun onAuthStateChanged(auth: FirebaseAuth)
    }

    fun interface IdTokenListener {
        fun onIdTokenChanged(auth: FirebaseAuth)
    }

    companion object {
        private val instances = ConcurrentHashMap<String, FirebaseAuth>()

        @JvmStatic
        fun getInstance(): FirebaseAuth = getInstance(FirebaseApp.getInstance())

        @JvmStatic
        fun getInstance(app: FirebaseApp): FirebaseAuth {
            return instances.computeIfAbsent(app.name) {
                FirebaseAuth(app, app.getOrCreateBridgeClient())
            }
        }

        @JvmStatic
        fun getInstance(app: FirebaseApp, bridgeClient: PyricBridgeClient): FirebaseAuth {
            return instances.computeIfAbsent(app.name) {
                app.getOrCreateBridgeClient(bridgeClient)
                FirebaseAuth(app, bridgeClient)
            }
        }

        @JvmStatic
        fun getInstance(
            app: FirebaseApp,
            bridgeClient: PyricBridgeClient,
            dispatcher: CoroutineDispatcher
        ): FirebaseAuth {
            return instances.computeIfAbsent(app.name) {
                app.getOrCreateBridgeClient(bridgeClient)
                FirebaseAuth(app, bridgeClient, dispatcher)
            }
        }

        @JvmStatic
        fun clearInstancesForTest() {
            for (auth in instances.values) {
                auth.scope.cancel()
                auth.bridgeClient.terminate()
            }
            instances.clear()
        }
    }
}
