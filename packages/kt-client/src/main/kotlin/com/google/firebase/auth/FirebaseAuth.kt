package com.google.firebase.auth

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.firebase.FirebaseApp
import dev.pyric.auth.AuthLens
import dev.pyric.auth.BridgeAuthOperations
import dev.pyric.auth.CredentialsProvider
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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
    val bridgeClient: PyricBridgeClient
) : CredentialsProvider {

    private val scope = CoroutineScope(Dispatchers.IO)

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

    init {
        var initialBridgeSnapshotReceived = false
        scope.launch {
            BridgeAuthOperations.subscribeAuthState(bridgeClient).collect { rawUser ->
                if (!initialBridgeSnapshotReceived) {
                    initialBridgeSnapshotReceived = true
                    if (rawUser == null && _currentUser.value != null) {
                        return@collect
                    }
                }
                updateUserFromBridge(rawUser)
            }
        }
        scope.launch {
            BridgeAuthOperations.subscribeIdToken(bridgeClient).collect { rawSnap ->
                currentUser?.let { user ->
                    @Suppress("UNCHECKED_CAST")
                    val snapClaims = (rawSnap?.get("customClaims") as? Map<String, Any?>)
                        ?: (rawSnap?.get("claims") as? Map<String, Any?>)
                    if (snapClaims != null) {
                        user.customClaims = snapClaims
                        updateAuthLens()
                    } else {
                        try {
                            val res = BridgeAuthOperations.getIdTokenResult(bridgeClient, forceRefresh = false)
                            @Suppress("UNCHECKED_CAST")
                            val claims = res["claims"] as? Map<String, Any?>
                            if (claims != null) {
                                user.customClaims = claims
                                updateAuthLens()
                            }
                        } catch (_: Exception) {}
                    }
                }
                notifyIdTokenChanged()
            }
        }
        scope.launch {
            bridgeClient.remoteLensEvents.collect { remoteLens ->
                if (remoteLens is AuthLens.AppSession) {
                    clearAuthLensOverride()
                } else {
                    setAuthLens(remoteLens)
                }
            }
        }
    }

    override fun getEffectiveLens(): AuthLens = _authLens.value

    fun signInWithEmailAndPassword(email: String, password: String): Task<AuthResult> {
        val tcs = TaskCompletionSource<AuthResult>()
        scope.launch {
            try {
                val res = BridgeAuthOperations.signInEmail(bridgeClient, email, password)
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
        scope.launch {
            try {
                val res = BridgeAuthOperations.createUser(bridgeClient, email, password)
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
        scope.launch {
            try {
                val res = BridgeAuthOperations.signInAnonymously(bridgeClient)
                val authResult = handleAuthSuccess(res)
                tcs.setResult(authResult)
            } catch (e: Exception) {
                tcs.setException(wrapException(e))
            }
        }
        return tcs.task
    }

    fun signOut() {
        scope.launch {
            try {
                BridgeAuthOperations.signOut(bridgeClient)
            } catch (_: Exception) {}
            _currentUser.value = null
            _lensOverride.value = null
            _authLens.value = AuthLens.Anon
            notifyAuthStateChanged()
            notifyIdTokenChanged()
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
        _currentUser.value = user
        updateAuthLens()
        notifyIdTokenChanged()
    }

    internal fun notifyUserUpdated(user: FirebaseUser) {
        _currentUser.value = user
        updateAuthLens()
        notifyAuthStateChanged()
        notifyIdTokenChanged()
    }

    private fun handleAuthSuccess(res: Map<String, Any?>): AuthResult {
        @Suppress("UNCHECKED_CAST")
        val userMap = res["user"] as? Map<String, Any?> ?: emptyMap()
        val user = FirebaseUser(this, userMap)
        @Suppress("UNCHECKED_CAST")
        val resClaims = (res["customClaims"] as? Map<String, Any?>) ?: (res["claims"] as? Map<String, Any?>)
        if (resClaims != null && user.customClaims.isEmpty()) {
            user.customClaims = resClaims
        }
        _currentUser.value = user
        updateAuthLens()
        notifyAuthStateChanged()
        notifyIdTokenChanged()
        val providerId = res["providerId"] as? String
        val isNew = res["operationType"] == "signIn" && userMap["isAnonymous"] != true
        return AuthResult(user, AdditionalUserInfo(providerId, isNew))
    }

    private fun updateUserFromBridge(userMap: Map<String, Any?>?) {
        val prevUid = _currentUser.value?.uid
        val uid = userMap?.get("uid") as? String
        if (userMap == null || uid.isNullOrEmpty()) {
            _currentUser.value = null
            _authLens.value = AuthLens.Anon
        } else {
            val existingUser = _currentUser.value
            val user = FirebaseUser(this, userMap)
            if (existingUser != null && existingUser.uid == user.uid && user.customClaims.isEmpty() && existingUser.customClaims.isNotEmpty()) {
                user.customClaims = existingUser.customClaims
            }
            _currentUser.value = user
            updateAuthLens()
        }
        if (_currentUser.value?.uid != prevUid) {
            notifyAuthStateChanged()
            notifyIdTokenChanged()
        }
    }

    private fun updateAuthLens() {
        val override = _lensOverride.value
        if (override != null) {
            _authLens.value = override
            return
        }
        val user = _currentUser.value
        _authLens.value = if (user != null) {
            val claims = user.customClaims
            AuthLens.AsUser(
                uid = user.uid,
                token = if (claims.isNotEmpty()) claims else null,
                tenant = tenantId
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

    private fun wrapException(e: Exception): Exception {
        if (e is FirebaseAuthException) return e
        val msg = e.message ?: "Authentication error"
        val code = when {
            msg.contains("user-not-found", ignoreCase = true) -> "ERROR_USER_NOT_FOUND"
            msg.contains("wrong-password", ignoreCase = true) -> "ERROR_WRONG_PASSWORD"
            msg.contains("email-already-in-use", ignoreCase = true) -> "ERROR_EMAIL_ALREADY_IN_USE"
            msg.contains("invalid-email", ignoreCase = true) -> "ERROR_INVALID_EMAIL"
            msg.contains("weak-password", ignoreCase = true) -> "ERROR_WEAK_PASSWORD"
            msg.contains("operation-not-allowed", ignoreCase = true) -> "ERROR_OPERATION_NOT_ALLOWED"
            msg.contains("user-disabled", ignoreCase = true) -> "ERROR_USER_DISABLED"
            msg.contains("invalid-credential", ignoreCase = true) -> "ERROR_INVALID_CREDENTIAL"
            msg.contains("requires-recent-login", ignoreCase = true) -> "ERROR_REQUIRES_RECENT_LOGIN"
            msg.contains("too-many-requests", ignoreCase = true) -> "ERROR_TOO_MANY_REQUESTS"
            else -> "ERROR_UNKNOWN"
        }
        return FirebaseAuthException(code, msg, e)
    }

    fun interface AuthStateListener {
        fun onAuthStateChanged(auth: FirebaseAuth)
    }

    fun interface IdTokenListener {
        fun onIdTokenChanged(auth: FirebaseAuth)
    }

    companion object {
        private val instances = ConcurrentHashMap<String, FirebaseAuth>()

        fun getInstance(): FirebaseAuth = getInstance(FirebaseApp.getInstance())

        fun getInstance(app: FirebaseApp): FirebaseAuth {
            return instances.computeIfAbsent(app.name) {
                FirebaseAuth(app, PyricBridgeClient.createDefault())
            }
        }

        fun getInstance(app: FirebaseApp, bridgeClient: PyricBridgeClient): FirebaseAuth {
            return instances.computeIfAbsent(app.name) {
                FirebaseAuth(app, bridgeClient)
            }
        }

        fun clearInstancesForTest() {
            instances.clear()
        }
    }
}
