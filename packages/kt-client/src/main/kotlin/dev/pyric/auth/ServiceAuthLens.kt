package dev.pyric.auth

import com.google.firebase.auth.FirebaseAuth
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * Resolves a service's effective [AuthLens] synchronously from an explicit
 * override, a remote lens fallback (when no shared [FirebaseAuth] owns
 * [PyricBridgeClient.remoteLensEvents]), or [CredentialsProvider.getEffectiveLens].
 *
 * Reading the credentials provider directly avoids the asynchronous lag of
 * mirroring [CredentialsProvider.authLensFlow] on a background dispatcher, so
 * synchronous auth transitions such as `FirebaseAuth.signOut()` take effect on
 * the very next Storage or Realtime Database request.
 */
internal class ServiceAuthLens(
    private val credentialsProvider: CredentialsProvider?,
    bridgeClient: PyricBridgeClient,
    scope: CoroutineScope
) {
    private val lock = Any()
    private var explicitAuthLens: AuthLens? = null
    private var remoteAuthLens: AuthLens? = null
    private val overrideLensFlow = MutableStateFlow<AuthLens?>(null)

    private val delegatesRemoteLensToAuth: Boolean =
        credentialsProvider is FirebaseAuth && credentialsProvider.bridgeClient === bridgeClient

    init {
        if (!delegatesRemoteLensToAuth) {
            val unregister = bridgeClient.addRemoteLensObserver { lens ->
                synchronized(lock) {
                    remoteAuthLens = if (lens is AuthLens.AppSession) null else lens
                    overrideLensFlow.value = explicitAuthLens ?: remoteAuthLens
                }
            }
            scope.coroutineContext[Job]?.invokeOnCompletion { unregister() }
        }
    }

    fun setExplicitLens(lens: AuthLens?) {
        synchronized(lock) {
            explicitAuthLens = lens
            overrideLensFlow.value = explicitAuthLens ?: remoteAuthLens
        }
    }

    fun getEffectiveLens(): AuthLens =
        overrideLensFlow.value ?: credentialsProvider?.getEffectiveLens() ?: AuthLens.Anon

    val authLensFlow: StateFlow<AuthLens> = DerivedAuthLensStateFlow(
        resolve = ::getEffectiveLens,
        overrideFlow = overrideLensFlow,
        credentialsFlow = credentialsProvider?.authLensFlow
    )
}

@OptIn(ExperimentalForInheritanceCoroutinesApi::class)
private class DerivedAuthLensStateFlow(
    private val resolve: () -> AuthLens,
    private val overrideFlow: StateFlow<AuthLens?>,
    private val credentialsFlow: StateFlow<AuthLens>?
) : StateFlow<AuthLens> {
    override val value: AuthLens
        get() = resolve()

    override val replayCache: List<AuthLens>
        get() = listOf(value)

    override suspend fun collect(collector: FlowCollector<AuthLens>): Nothing {
        val source: Flow<AuthLens> = if (credentialsFlow != null) {
            combine(overrideFlow, credentialsFlow) { overrideLens, credLens ->
                overrideLens ?: credLens
            }
        } else {
            overrideFlow.map { it ?: AuthLens.Anon }
        }
        source.distinctUntilChanged().collect(collector)
        awaitCancellation()
    }
}
