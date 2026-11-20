package com.google.firebase.auth

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.firebase.FirebaseApp
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
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

class FirebaseAuth internal constructor(
    val app: FirebaseApp,
    val bridgeClient: PyricBridgeClient,
    dispatcher: CoroutineDispatcher = Dispatchers.IO
) : CredentialsProvider {

    private val scope = CoroutineScope(dispatcher)

    private val _currentUser = MutableStateFlow<FirebaseUser?>(null)
    val currentUser: FirebaseUser? get() = _currentUser.value

    private val _lensOverride = MutableStateFlow<AuthLens?>(null)
    val lensOverrideFlow: StateFlow<AuthLens?> = _lensOverride.asStateFlow()

    private val _authLens = MutableStateFlow<AuthLens>(AuthLens.Anon)
    override val authLensFlow: StateFlow<AuthLens> = _authLens.asStateFlow()

    fun setAuthLens(lens: AuthLens?) {
        _lensOverride.value = lens
        updateAuthLens()
    }

    fun clearAuthLensOverride() {
        setAuthLens(null)
    }

    var tenantId: String? = null
        set(value) {
            field = value
            updateAuthLens()
        }

    private val authStateListeners = CopyOnWriteArrayList<AuthStateListener>()
    private val idTokenListeners = CopyOnWriteArrayList<IdTokenListener>()

    private val authStateLock = Any()
    private var initialBridgeSnapshotReceived = false
    private var initialIdTokenSnapshotReceived = false

    init {
        // A replaced bridge host holds no user for this session. Sign the session
        // back in before the observers are re-sent.
        bridgeClient.restoreAuth = { op ->
            val user = currentUser
            if (user != null) {
                op("auth.restorePortSession", mapOf("uid" to user.uid, "tenantId" to user.tenantId))
            }
        }
        scope.launch {
            try {
                BridgeAuthOperations.subscribeAuthState(bridgeClient).collect { rawUser ->
                    updateUserFromBridge(rawUser)
                }
            } catch (_: Throwable) {}
        }
        scope.launch {
            try {
                BridgeAuthOperations.subscribeIdToken(bridgeClient).collect { rawSnap ->
                    val shouldNotify = synchronized(authStateLock) {
                        if (!initialIdTokenSnapshotReceived) {
                            initialIdTokenSnapshotReceived = true
                            if (rawSnap == null) return@synchronized false
                        }
                        rawSnap != null || _currentUser.value != null
                    }
                    if (!shouldNotify) return@collect
                    if (rawSnap == null) {
                        updateUserFromBridge(null)
                        return@collect
                    }
                    currentUser?.let { user ->
                        @Suppress("UNCHECKED_CAST")
                        val snapClaims = (rawSnap["customClaims"] as? Map<String, Any?>)
                            ?: (rawSnap["claims"] as? Map<String, Any?>)
                        if (snapClaims != null) {
                            user.customClaims = FirebaseUser.extractCustomClaims(snapClaims)
                            updateAuthLens()
                        } else {
                            try {
                                val res = BridgeAuthOperations.getIdTokenResult(bridgeClient, forceRefresh = false)
                                val provider = res["signInProvider"] as? String
                                if (!provider.isNullOrBlank()) {
                                    user.signInProviderOverride = provider
                                }
                                @Suppress("UNCHECKED_CAST")
                                val claims = res["claims"] as? Map<String, Any?>
                                if (claims != null) {
                                    user.customClaims = FirebaseUser.extractCustomClaims(claims)
                                    updateAuthLens()
                                }
                            } catch (_: Exception) {}
                        }
                    }
                    notifyIdTokenChanged()
                }
            } catch (_: Throwable) {}
        }
        scope.launch {
            try {
                bridgeClient.remoteLensEvents.collect { remoteLens ->
                    if (remoteLens is AuthLens.AppSession) {
                        clearAuthLensOverride()
                    } else {
                        setAuthLens(remoteLens)
                    }
                }
            } catch (_: Throwable) {}
        }
    }

    override fun getEffectiveLens(): AuthLens = _authLens.value

    fun signInWithEmailAndPassword(email: String, password: String): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = BridgeAuthOperations.signInEmail(bridgeClient, email, password, tenantId)
                val authResult = handleAuthSuccess(res)
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
                val res = BridgeAuthOperations.createUser(bridgeClient, email, password, tenantId)
                val authResult = handleAuthSuccess(res)
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
                val res = BridgeAuthOperations.signInAnonymously(bridgeClient, tenantId)
                val authResult = handleAuthSuccess(res, defaultSignInProvider = "anonymous")
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
                val res = BridgeAuthOperations.signInWithCustomToken(bridgeClient, token, tenantId)
                val enriched = enrichSignInResponseIfNeeded(res)
                val authResult = handleAuthSuccess(enriched, defaultSignInProvider = "custom")
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
                val res = BridgeAuthOperations.signInWithCredential(bridgeClient, credential, tenantId)
                val enriched = enrichSignInResponseIfNeeded(res)
                val fallbackProvider = credential["providerId"] as? String
                val authResult = handleAuthSuccess(enriched, defaultSignInProvider = fallbackProvider)
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
                val res = BridgeAuthOperations.signInWithCredential(bridgeClient, credential.toWireMap(), tenantId)
                val enriched = enrichSignInResponseIfNeeded(res)
                val authResult = handleAuthSuccess(enriched, defaultSignInProvider = credential.provider)
                tcs.setResult(authResult)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    private suspend fun enrichSignInResponseIfNeeded(res: Map<String, Any?>): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        val userMap = res["user"] as? Map<String, Any?>
        val hasEmbeddedClaims = res["customClaims"] != null ||
            res["claims"] != null ||
            userMap?.get("customClaims") != null ||
            userMap?.get("claims") != null
        if (hasEmbeddedClaims) return res
        val tokenSnapshot = runCatching {
            BridgeAuthOperations.getIdTokenResult(bridgeClient, forceRefresh = false)
        }.getOrNull() ?: return res
        if (tokenSnapshot["claims"] !is Map<*, *>) return res
        val copy = LinkedHashMap(res)
        copy["claims"] = tokenSnapshot["claims"]
        return copy
    }

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
        synchronized(authStateLock) {
            _currentUser.value = null
            _lensOverride.value = null
            _authLens.value = AuthLens.Anon
        }
        notifyAuthStateChanged()
        notifyIdTokenChanged()
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                BridgeAuthOperations.signOut(bridgeClient)
            } catch (_: Exception) {}
        }
    }

    fun authStateFlow(): StateFlow<FirebaseUser?> = _currentUser.asStateFlow()

    fun idTokenFlow(): Flow<FirebaseUser?> = callbackFlow {
        val listener = IdTokenListener { auth ->
            trySend(auth.currentUser)
        }
        addIdTokenListener(listener)
        awaitClose { removeIdTokenListener(listener) }
    }

    fun addAuthStateListener(listener: AuthStateListener) {
        authStateListeners.add(listener)
        listener.onAuthStateChanged(this)
    }

    fun removeAuthStateListener(listener: AuthStateListener) {
        authStateListeners.remove(listener)
    }

    fun addIdTokenListener(listener: IdTokenListener) {
        idTokenListeners.add(listener)
        listener.onIdTokenChanged(this)
    }

    fun removeIdTokenListener(listener: IdTokenListener) {
        idTokenListeners.remove(listener)
    }

    internal fun notifyTokenRefreshed(user: FirebaseUser) {
        synchronized(authStateLock) {
            if (_currentUser.value?.uid == user.uid) {
                _currentUser.value = user
                updateAuthLens()
            }
        }
        notifyIdTokenChanged()
    }

    internal fun notifyUserUpdated(user: FirebaseUser) {
        synchronized(authStateLock) {
            if (_currentUser.value?.uid == user.uid) {
                _currentUser.value = user
                updateAuthLens()
            }
        }
        notifyAuthStateChanged()
        notifyIdTokenChanged()
    }

    internal fun clearCurrentUserIfInvalidated(error: Exception, targetUid: String) {
        val authEx = error as? FirebaseAuthException ?: return
        val invalidated = authEx.errorCode == "ERROR_USER_TOKEN_EXPIRED" ||
            authEx.errorCode == "ERROR_USER_DISABLED" ||
            authEx.errorCode == "ERROR_USER_NOT_FOUND"
        if (!invalidated) return
        val cleared = synchronized(authStateLock) {
            if (_currentUser.value?.uid == targetUid) {
                _currentUser.value = null
                updateAuthLens()
                true
            } else {
                false
            }
        }
        if (cleared) {
            notifyAuthStateChanged()
            notifyIdTokenChanged()
        }
    }

    private fun handleAuthSuccess(
        res: Map<String, Any?>,
        defaultSignInProvider: String? = null
    ): AuthResult {
        @Suppress("UNCHECKED_CAST")
        val userMap = res["user"] as? Map<String, Any?> ?: emptyMap()
        @Suppress("UNCHECKED_CAST")
        val addInfo = res["additionalUserInfo"] as? Map<String, Any?>
        val explicitProviderId = (addInfo?.get("providerId") as? String) ?: (res["providerId"] as? String)
        val user = FirebaseUser(this, userMap, signInProviderOverride = explicitProviderId ?: defaultSignInProvider)
        @Suppress("UNCHECKED_CAST")
        val resClaims = (res["customClaims"] as? Map<String, Any?>) ?: (res["claims"] as? Map<String, Any?>)
        if (resClaims != null && user.customClaims.isEmpty()) {
            user.customClaims = FirebaseUser.extractCustomClaims(resClaims)
        }
        synchronized(authStateLock) {
            _currentUser.value = user
            updateAuthLens()
        }
        notifyAuthStateChanged()
        notifyIdTokenChanged()
        val providerId = explicitProviderId
            ?: user.providerData.firstOrNull()?.providerId?.takeIf { it.isNotBlank() && it != "firebase" }
        val isNew = (addInfo?.get("isNewUser") as? Boolean)
            ?: (res["operationType"] == "signIn" && userMap["isAnonymous"] != true)
        return AuthResult(user, AdditionalUserInfo(providerId, isNew))
    }

    private fun updateUserFromBridge(userMap: Map<String, Any?>?) {
        val changed = synchronized(authStateLock) {
            // Apply the initial snapshot atomically with sign-in completion;
            // an already-checked null must not erase a newly signed-in user.
            if (!initialBridgeSnapshotReceived) {
                initialBridgeSnapshotReceived = true
                if (userMap == null && _currentUser.value != null) return
            }
            val prevUid = _currentUser.value?.uid
            val uid = userMap?.get("uid") as? String
            if (userMap == null || uid.isNullOrEmpty()) {
                _currentUser.value = null
                _authLens.value = AuthLens.Anon
            } else {
                val existingUser = _currentUser.value
                val inheritedProvider = if (existingUser != null && existingUser.uid == uid) {
                    existingUser.signInProviderOverride
                } else {
                    null
                }
                val user = FirebaseUser(this, userMap, signInProviderOverride = inheritedProvider)
                if (existingUser != null && existingUser.uid == user.uid && user.customClaims.isEmpty() && existingUser.customClaims.isNotEmpty()) {
                    user.customClaims = existingUser.customClaims
                }
                _currentUser.value = user
                updateAuthLens()
            }
            _currentUser.value?.uid != prevUid
        }
        if (changed) {
            notifyAuthStateChanged()
            notifyIdTokenChanged()
        }
    }

    private fun updateAuthLens() = synchronized(authStateLock) {
        val override = _lensOverride.value
        if (override != null) {
            _authLens.value = override
            return
        }
        val user = _currentUser.value
        _authLens.value = if (user != null) {
            AuthLens.AsUser(
                uid = user.uid,
                token = user.buildJwtClaims(),
                tenant = user.tenantId ?: tenantId
            )
        } else {
            AuthLens.Anon
        }
    }

    internal fun notifyAuthStateChanged() {
        for (l in authStateListeners) l.onAuthStateChanged(this)
    }

    internal fun notifyIdTokenChanged() {
        for (l in idTokenListeners) l.onIdTokenChanged(this)
    }

    internal fun wrapException(e: Exception): Exception {
        if (e is FirebaseAuthException) return e
        val rawWireCode = (e as? FirebaseFirestoreException)?.wireCode?.lowercase() ?: ""
        val msg = e.message ?: "Authentication error"
        val combined = if (rawWireCode.isNotEmpty()) "$rawWireCode $msg" else msg
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
            combined.contains("no-mock-configured", ignoreCase = true) -> "ERROR_NO_MOCK_CONFIGURED"
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
