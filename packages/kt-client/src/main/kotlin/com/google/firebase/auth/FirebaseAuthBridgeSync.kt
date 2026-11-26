package com.google.firebase.auth

import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import dev.pyric.auth.BridgeAuthOperations
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal class FirebaseAuthBridgeSync(
    private val auth: FirebaseAuth,
    private val scope: CoroutineScope
) {
    private data class SessionState(
        val user: FirebaseUser? = null,
        val lensOverride: AuthLens? = null,
        val tenantId: String? = null,
        val effectiveLens: AuthLens = AuthLens.Anon
    )

    private sealed class BridgeTokenEnrichment {
        data object SessionMovedOn : BridgeTokenEnrichment()
        data class Resolved(
            val claims: Map<String, Any?>?,
            val signInProvider: String?
        ) : BridgeTokenEnrichment()
    }

    private val authStateLock = Any()
    private var authStateEpoch = 0L
    private var lastAuthoritativeWireSeq = 0L
    private var initialBridgeSnapshotReceived = false
    private var initialIdTokenSnapshotReceived = false

    private fun isStaleInboundWireSeq(wireSeq: Long): Boolean =
        wireSeq <= lastAuthoritativeWireSeq && (wireSeq > 0L || lastAuthoritativeWireSeq > 0L)

    @Volatile
    private var sessionState = SessionState()

    private val _currentUser = MutableStateFlow<FirebaseUser?>(null)
    val currentUserFlow: StateFlow<FirebaseUser?> = _currentUser.asStateFlow()

    private val _lensOverride = MutableStateFlow<AuthLens?>(null)
    val lensOverrideFlow: StateFlow<AuthLens?> = _lensOverride.asStateFlow()

    private val _authLens = MutableStateFlow<AuthLens>(AuthLens.Anon)
    val authLensFlow: StateFlow<AuthLens> = _authLens.asStateFlow()

    val currentUser: FirebaseUser?
        get() = synchronized(authStateLock) { sessionState.user }

    var tenantId: String?
        get() = synchronized(authStateLock) { sessionState.tenantId }
        set(value) {
            synchronized(authStateLock) {
                commitSessionStateLocked(tenantId = value)
            }
        }

    fun getEffectiveLens(): AuthLens =
        synchronized(authStateLock) { sessionState.effectiveLens }

    fun setAuthLens(lens: AuthLens?) {
        synchronized(authStateLock) {
            commitSessionStateLocked(lensOverride = lens)
        }
    }

    fun startSubscriptions() {
        // Register authState, idToken, and remoteLens synchronously before FirebaseAuth()
        // returns (D7). authState and idToken keep independent unlimited channels because
        // both suspend on auth.getIdTokenResult enrichment and order updates via wireSeq.
        val authSub = runCatching { auth.bridgeClient.openSequencedSubscription("authState") }.getOrNull()
        val idTokenSub = runCatching { auth.bridgeClient.openSequencedSubscription("idToken") }.getOrNull()
        val unregisterRemoteLens = auth.bridgeClient.addRemoteLensObserver { remoteLens ->
            if (remoteLens is AuthLens.AppSession) {
                setAuthLens(null)
            } else {
                setAuthLens(remoteLens)
            }
        }
        scope.coroutineContext[Job]?.invokeOnCompletion {
            unregisterRemoteLens()
            authSub?.cancel()
            idTokenSub?.cancel()
        }
        if (authSub != null) {
            scope.launch {
                try {
                    for (snap in authSub.channel) {
                        @Suppress("UNCHECKED_CAST")
                        updateUserFromBridge(snap.value as? Map<String, Any?>, snap.wireSeq)
                    }
                } catch (_: Throwable) {
                } finally {
                    authSub.cancel()
                }
            }
        }
        if (idTokenSub != null) {
            scope.launch {
                try {
                    for (snap in idTokenSub.channel) {
                        @Suppress("UNCHECKED_CAST")
                        handleIdTokenSnapshot(snap.value as? Map<String, Any?>, snap.wireSeq)
                    }
                } catch (_: Throwable) {
                } finally {
                    idTokenSub.cancel()
                }
            }
        }
    }

    private suspend fun handleIdTokenSnapshot(rawSnap: Map<String, Any?>?, wireSeq: Long) {
        if (rawSnap == null) {
            val shouldClear = synchronized(authStateLock) {
                if (!initialIdTokenSnapshotReceived) {
                    initialIdTokenSnapshotReceived = true
                    return@synchronized false
                }
                if (isStaleInboundWireSeq(wireSeq)) {
                    return@synchronized false
                }
                sessionState.user != null
            }
            if (shouldClear) {
                updateUserFromBridge(null, wireSeq)
            }
            return
        }

        val snapUid = rawSnap["uid"] as? String
        val (targetUser, epochBeforeFetch) = synchronized(authStateLock) {
            initialIdTokenSnapshotReceived = true
            if (isStaleInboundWireSeq(wireSeq)) {
                return
            }
            sessionState.user to authStateEpoch
        }
        if (targetUser == null) {
            // A non-null idToken snapshot carrying a uid can arrive ahead of the
            // sign-in transition that installs currentUser; that transition emits
            // the idToken notification once claims are ready.
            if (!snapUid.isNullOrEmpty()) return
            auth.notifyIdTokenChanged()
            return
        }
        if (!snapUid.isNullOrEmpty() && snapUid != targetUser.uid) {
            return
        }
        @Suppress("UNCHECKED_CAST")
        val snapClaims = (rawSnap["customClaims"] as? Map<String, Any?>)
            ?: (rawSnap["claims"] as? Map<String, Any?>)
        if (snapClaims != null) {
            val stillCurrent = synchronized(authStateLock) {
                val current = sessionState.user
                if (current?.uid == targetUser.uid && !isStaleInboundWireSeq(wireSeq)) {
                    val extracted = FirebaseUser.extractCustomClaims(snapClaims)
                    current.customClaims = extracted
                    if (targetUser !== current) {
                        targetUser.customClaims = extracted
                    }
                    lastAuthoritativeWireSeq = maxOf(lastAuthoritativeWireSeq, wireSeq)
                    commitSessionStateLocked()
                    true
                } else {
                    false
                }
            }
            if (!stillCurrent) return
        } else {
            when (val enrichment = fetchBridgeUserTokenEnrichment(targetUser.uid)) {
                BridgeTokenEnrichment.SessionMovedOn -> return
                is BridgeTokenEnrichment.Resolved -> {
                    val stillCurrent = synchronized(authStateLock) {
                        val current = sessionState.user
                        if (current?.uid != targetUser.uid || isStaleInboundWireSeq(wireSeq)) {
                            false
                        } else {
                            if (authStateEpoch == epochBeforeFetch) {
                                enrichment.signInProvider?.let {
                                    current.signInProviderOverride = it
                                    if (targetUser !== current) {
                                        targetUser.signInProviderOverride = it
                                    }
                                }
                                enrichment.claims?.let {
                                    val extracted = FirebaseUser.extractCustomClaims(it)
                                    current.customClaims = extracted
                                    if (targetUser !== current) {
                                        targetUser.customClaims = extracted
                                    }
                                }
                                lastAuthoritativeWireSeq = maxOf(lastAuthoritativeWireSeq, wireSeq)
                                if (enrichment.signInProvider != null || enrichment.claims != null) {
                                    commitSessionStateLocked()
                                }
                            }
                            true
                        }
                    }
                    if (!stillCurrent) return
                }
            }
        }
        auth.notifyIdTokenChanged()
    }

    suspend fun enrichSignInResponseIfNeeded(res: Map<String, Any?>): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        val userMap = res["user"] as? Map<String, Any?>
        val hasEmbeddedClaims = res["customClaims"] != null ||
            res["claims"] != null ||
            userMap?.get("customClaims") != null ||
            userMap?.get("claims") != null
        if (hasEmbeddedClaims) return res
        val tokenSnapshot = runCatching {
            BridgeAuthOperations.getIdTokenResult(auth.bridgeClient, forceRefresh = false)
        }.getOrNull() ?: return res
        if (tokenSnapshot["claims"] !is Map<*, *>) return res
        val copy = LinkedHashMap(res)
        copy["claims"] = tokenSnapshot["claims"]
        return copy
    }

    fun signOutLocal() {
        synchronized(authStateLock) {
            authStateEpoch += 1
            lastAuthoritativeWireSeq = maxOf(lastAuthoritativeWireSeq, auth.bridgeClient.currentInboundWireSeq())
            commitSessionStateLocked(user = null, lensOverride = null)
        }
        auth.notifyAuthStateChanged()
        auth.notifyIdTokenChanged()
    }

    fun commitUserMutation(user: FirebaseUser, wireSeq: Long = 0L, mutate: () -> Unit): Boolean {
        val updated = synchronized(authStateLock) {
            if (sessionState.user?.uid != user.uid || isStaleInboundWireSeq(wireSeq)) {
                false
            } else {
                mutate()
                authStateEpoch += 1
                lastAuthoritativeWireSeq = maxOf(lastAuthoritativeWireSeq, wireSeq)
                commitSessionStateLocked(user = user)
                true
            }
        }
        if (updated) {
            auth.notifyIdTokenChanged()
        }
        return updated
    }

    fun notifyTokenRefreshed(user: FirebaseUser, wireSeq: Long = 0L) {
        commitUserMutation(user, wireSeq) {}
    }

    fun notifyUserUpdated(user: FirebaseUser, wireSeq: Long = 0L) {
        commitUserMutation(user, wireSeq) {}
    }

    fun clearCurrentUserIfInvalidated(error: Exception, targetUid: String) {
        val authEx = error as? FirebaseAuthException ?: return
        val invalidated = authEx.errorCode == "ERROR_USER_TOKEN_EXPIRED" ||
            authEx.errorCode == "ERROR_USER_DISABLED" ||
            authEx.errorCode == "ERROR_USER_NOT_FOUND"
        if (!invalidated) return
        clearIfMatchingUid(targetUid, wireSeq = auth.bridgeClient.currentInboundWireSeq(), enforceFreshSeq = false)
    }

    fun clearCurrentUserAfterDelete(targetUid: String, wireSeq: Long = 0L) {
        if (wireSeq > 0L) {
            clearIfMatchingUid(targetUid, wireSeq, enforceFreshSeq = true)
        } else {
            clearIfMatchingUid(targetUid, auth.bridgeClient.currentInboundWireSeq(), enforceFreshSeq = false)
        }
    }

    private fun clearIfMatchingUid(targetUid: String, wireSeq: Long, enforceFreshSeq: Boolean) {
        val cleared = synchronized(authStateLock) {
            if (enforceFreshSeq && isStaleInboundWireSeq(wireSeq)) {
                false
            } else if (sessionState.user?.uid == targetUid) {
                authStateEpoch += 1
                lastAuthoritativeWireSeq = maxOf(lastAuthoritativeWireSeq, wireSeq)
                commitSessionStateLocked(user = null)
                true
            } else {
                false
            }
        }
        if (cleared) {
            auth.notifyAuthStateChanged()
            auth.notifyIdTokenChanged()
        }
    }

    fun handleAuthSuccess(
        res: Map<String, Any?>,
        wireSeq: Long,
        defaultSignInProvider: String? = null
    ): AuthResult {
        @Suppress("UNCHECKED_CAST")
        val userMap = res["user"] as? Map<String, Any?> ?: emptyMap()
        @Suppress("UNCHECKED_CAST")
        val addInfo = res["additionalUserInfo"] as? Map<String, Any?>
        val explicitProviderId = (addInfo?.get("providerId") as? String) ?: (res["providerId"] as? String)
        val user = FirebaseUser(auth, userMap, signInProviderOverride = explicitProviderId ?: defaultSignInProvider)
        @Suppress("UNCHECKED_CAST")
        val resClaims = (res["customClaims"] as? Map<String, Any?>) ?: (res["claims"] as? Map<String, Any?>)
        if (resClaims != null && user.customClaims.isEmpty()) {
            user.customClaims = FirebaseUser.extractCustomClaims(resClaims)
        }
        val applied = synchronized(authStateLock) {
            if (isStaleInboundWireSeq(wireSeq)) {
                false
            } else {
                authStateEpoch += 1
                lastAuthoritativeWireSeq = maxOf(lastAuthoritativeWireSeq, wireSeq)
                commitSessionStateLocked(user = user)
                true
            }
        }
        if (applied) {
            auth.notifyAuthStateChanged()
            auth.notifyIdTokenChanged()
        }
        val providerId = explicitProviderId
            ?: user.providerData.firstOrNull { it.providerId.isNotBlank() && it.providerId != "firebase" }?.providerId
        val isNew = (addInfo?.get("isNewUser") as? Boolean)
            ?: (res["operationType"] == "signIn" && userMap["isAnonymous"] != true)
        return AuthResult(user, AdditionalUserInfo(providerId, isNew))
    }

    private suspend fun fetchBridgeUserTokenEnrichment(expectedUid: String): BridgeTokenEnrichment {
        val res = try {
            BridgeAuthOperations.getIdTokenResult(auth.bridgeClient, forceRefresh = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val wireCode = (e as? FirebaseFirestoreException)?.wireCode?.lowercase() ?: ""
            val msg = e.message?.lowercase() ?: ""
            if (wireCode.contains("no-current-user") || msg.contains("no-current-user")) {
                return BridgeTokenEnrichment.SessionMovedOn
            }
            return BridgeTokenEnrichment.Resolved(claims = null, signInProvider = null)
        }
        @Suppress("UNCHECKED_CAST")
        val claims = res["claims"] as? Map<String, Any?>
        val tokenSub = claims?.get("sub") as? String
        if (!tokenSub.isNullOrBlank() && tokenSub != expectedUid) {
            return BridgeTokenEnrichment.SessionMovedOn
        }
        @Suppress("UNCHECKED_CAST")
        val firebaseMap = claims?.get("firebase") as? Map<String, Any?>
        val provider = (res["signInProvider"] as? String)?.takeIf { it.isNotBlank() }
            ?: (firebaseMap?.get("sign_in_provider") as? String)?.takeIf { it.isNotBlank() }
        return BridgeTokenEnrichment.Resolved(claims = claims, signInProvider = provider)
    }

    private suspend fun updateUserFromBridge(userMap: Map<String, Any?>?, wireSeq: Long) {
        val uid = userMap?.get("uid") as? String
        if (userMap == null || uid.isNullOrEmpty()) {
            val changed = synchronized(authStateLock) {
                if (!initialBridgeSnapshotReceived) {
                    initialBridgeSnapshotReceived = true
                    if (isStaleInboundWireSeq(wireSeq) || sessionState.user != null) {
                        return
                    }
                } else if (isStaleInboundWireSeq(wireSeq)) {
                    return
                }
                val prevUid = sessionState.user?.uid
                if (prevUid != null) {
                    authStateEpoch += 1
                    lastAuthoritativeWireSeq = maxOf(lastAuthoritativeWireSeq, wireSeq)
                    commitSessionStateLocked(user = null)
                    true
                } else {
                    false
                }
            }
            if (changed) {
                auth.notifyAuthStateChanged()
                auth.notifyIdTokenChanged()
            }
            return
        }

        val hasEmbeddedClaims = userMap["customClaims"] != null || userMap["claims"] != null
        val fetchEpoch: Long? = synchronized(authStateLock) {
            initialBridgeSnapshotReceived = true
            if (isStaleInboundWireSeq(wireSeq)) {
                return
            }
            val existingUser = sessionState.user
            if (hasEmbeddedClaims || (existingUser != null && existingUser.uid == uid)) {
                null
            } else {
                authStateEpoch
            }
        }

        val enrichment: BridgeTokenEnrichment.Resolved? = if (fetchEpoch != null) {
            when (val resolved = fetchBridgeUserTokenEnrichment(uid)) {
                BridgeTokenEnrichment.SessionMovedOn -> return
                is BridgeTokenEnrichment.Resolved -> resolved
            }
        } else {
            null
        }

        val changed = synchronized(authStateLock) {
            if (isStaleInboundWireSeq(wireSeq)) {
                return
            }
            if (fetchEpoch != null && authStateEpoch != fetchEpoch) {
                return
            }
            val existingUser = sessionState.user
            val prevUid = existingUser?.uid
            val inheritedProvider = if (existingUser != null && existingUser.uid == uid) {
                existingUser.signInProviderOverride
            } else {
                enrichment?.signInProvider
            }
            val user = FirebaseUser(auth, userMap, signInProviderOverride = inheritedProvider)
            val enrichedClaims = enrichment?.claims
            if (enrichedClaims != null && user.customClaims.isEmpty()) {
                user.customClaims = FirebaseUser.extractCustomClaims(enrichedClaims)
            } else if (existingUser != null && existingUser.uid == user.uid && user.customClaims.isEmpty() && existingUser.customClaims.isNotEmpty()) {
                user.customClaims = existingUser.customClaims
            }
            authStateEpoch += 1
            lastAuthoritativeWireSeq = maxOf(lastAuthoritativeWireSeq, wireSeq)
            commitSessionStateLocked(user = user)
            sessionState.user?.uid != prevUid
        }
        if (changed) {
            auth.notifyAuthStateChanged()
            auth.notifyIdTokenChanged()
        }
    }

    private fun commitSessionStateLocked(
        user: FirebaseUser? = sessionState.user,
        lensOverride: AuthLens? = sessionState.lensOverride,
        tenantId: String? = sessionState.tenantId
    ) {
        val resolvedLens = lensOverride ?: if (user != null) {
            AuthLens.AsUser(
                uid = user.uid,
                token = user.buildJwtClaims(),
                tenant = (user.rawData["tenantId"] as? String) ?: tenantId
            )
        } else {
            AuthLens.Anon
        }
        sessionState = SessionState(
            user = user,
            lensOverride = lensOverride,
            tenantId = tenantId,
            effectiveLens = resolvedLens
        )
        _lensOverride.value = lensOverride
        _authLens.value = resolvedLens
        _currentUser.value = user
    }
}
