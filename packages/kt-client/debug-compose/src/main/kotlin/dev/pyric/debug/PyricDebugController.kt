package dev.pyric.debug

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import dev.pyric.auth.BridgeAuthOperations
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.debug.model.RulesDenialContext
import dev.pyric.debug.model.RulesDenialRecord
import dev.pyric.debug.model.SandboxUser
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

enum class DebugTab {
    IDENTITY,
    RULES_DENIALS
}

class PyricDebugController(
    val auth: FirebaseAuth,
    val firestore: FirebaseFirestore? = null,
    val bridgeClient: PyricBridgeClient = auth.bridgeClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
) {
    private val _users = MutableStateFlow<List<SandboxUser>>(emptyList())
    val users: StateFlow<List<SandboxUser>> = _users.asStateFlow()

    private val _isLoadingUsers = MutableStateFlow(false)
    val isLoadingUsers: StateFlow<Boolean> = _isLoadingUsers.asStateFlow()

    private val _userSearchQuery = MutableStateFlow("")
    val userSearchQuery: StateFlow<String> = _userSearchQuery.asStateFlow()

    val filteredUsers: StateFlow<List<SandboxUser>> = kotlinx.coroutines.flow.combine(
        _users,
        _userSearchQuery
    ) { userList, query ->
        if (query.isBlank()) {
            userList
        } else {
            val lower = query.lowercase().trim()
            userList.filter { u ->
                u.uid.lowercase().contains(lower) ||
                    (u.email?.lowercase()?.contains(lower) == true) ||
                    (u.displayName?.lowercase()?.contains(lower) == true) ||
                    (u.tenantId?.lowercase()?.contains(lower) == true) ||
                    (u.role?.lowercase()?.contains(lower) == true)
            }
        }
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    private val _activeLens = MutableStateFlow<AuthLens>(auth.getEffectiveLens())
    val activeLens: StateFlow<AuthLens> = _activeLens.asStateFlow()

    private val _isAdminBypassActive = MutableStateFlow(auth.getEffectiveLens() is AuthLens.Admin)
    val isAdminBypassActive: StateFlow<Boolean> = _isAdminBypassActive.asStateFlow()

    private val _denials = MutableStateFlow<List<RulesDenialRecord>>(emptyList())
    val denials: StateFlow<List<RulesDenialRecord>> = _denials.asStateFlow()

    val unviewedDenialsCount: StateFlow<Int> = _denials.map { list ->
        list.count { !it.isViewed }
    }.stateIn(scope, SharingStarted.Eagerly, 0)

    private val _isSheetVisible = MutableStateFlow(false)
    val isSheetVisible: StateFlow<Boolean> = _isSheetVisible.asStateFlow()

    private val _selectedTab = MutableStateFlow(DebugTab.IDENTITY)
    val selectedTab: StateFlow<DebugTab> = _selectedTab.asStateFlow()

    init {
        scope.launch {
            auth.authLensFlow.collect { lens ->
                _activeLens.value = lens
                _isAdminBypassActive.value = (lens is AuthLens.Admin)
            }
        }

        firestore?.addRulesDenialListener { exception, contextMap ->
            recordDenial(exception, contextMap)
        }

        refreshUsers()
    }

    fun refreshUsers() {
        scope.launch(Dispatchers.IO) {
            _isLoadingUsers.value = true
            try {
                val rawUsers = BridgeAuthOperations.listUsers(bridgeClient)
                val parsed = rawUsers.map { SandboxUser.fromMap(it) }
                _users.value = parsed
            } catch (_: Exception) {
                // Ignore transient list failure
            } finally {
                _isLoadingUsers.value = false
            }
        }
    }

    fun setUserSearchQuery(query: String) {
        _userSearchQuery.value = query
    }

    fun impersonateUser(user: SandboxUser) {
        val claims = user.customClaims.takeIf { it.isNotEmpty() }
        val tenant = user.tenantId ?: auth.tenantId
        auth.setAuthLens(AuthLens.AsUser(uid = user.uid, token = claims, tenant = tenant))
    }

    fun impersonateUid(uid: String, claims: Map<String, Any?> = emptyMap(), tenant: String? = null) {
        auth.setAuthLens(
            AuthLens.AsUser(
                uid = uid,
                token = claims.takeIf { it.isNotEmpty() },
                tenant = tenant ?: auth.tenantId
            )
        )
    }

    fun impersonateAnonymous() {
        auth.setAuthLens(AuthLens.Anon)
    }

    fun toggleAdminBypass(enable: Boolean) {
        if (enable) {
            auth.setAuthLens(AuthLens.Admin)
        } else {
            auth.clearAuthLensOverride()
        }
    }

    fun resetToAppSession() {
        auth.clearAuthLensOverride()
    }

    fun recordDenial(exception: FirebaseFirestoreException, contextMap: Map<String, Any?>) {
        val parsedContext = RulesDenialContext.fromMap(contextMap)
        val record = RulesDenialRecord(
            exception = exception,
            context = parsedContext,
            isViewed = _isSheetVisible.value && _selectedTab.value == DebugTab.RULES_DENIALS
        )
        val currentList = _denials.value.toMutableList()
        currentList.add(0, record)
        if (currentList.size > 100) {
            _denials.value = currentList.subList(0, 100)
        } else {
            _denials.value = currentList
        }
    }

    fun setSheetVisible(visible: Boolean) {
        _isSheetVisible.value = visible
        if (visible && _selectedTab.value == DebugTab.RULES_DENIALS) {
            markDenialsViewed()
        }
    }

    fun setSelectedTab(tab: DebugTab) {
        _selectedTab.value = tab
        if (tab == DebugTab.RULES_DENIALS) {
            markDenialsViewed()
        }
    }

    fun markDenialsViewed() {
        val current = _denials.value
        if (current.any { !it.isViewed }) {
            _denials.value = current.map { it.copy(isViewed = true) }
        }
    }

    fun clearDenials() {
        _denials.value = emptyList()
    }
}
