package dev.pyric.debug.model

import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens

data class RuleCitation(
    val file: String? = null,
    val line: Int? = null,
    val column: Int? = null,
    val citation: String? = null,
    val expression: String? = null
) {
    val formattedCitation: String
        get() {
            if (!citation.isNullOrBlank()) return citation
            if (!file.isNullOrBlank() && line != null) {
                return if (column != null) "$file:$line:$column" else "$file:$line"
            }
            return file ?: "unknown"
        }

    companion object {
        fun parse(raw: Any?): RuleCitation? {
            if (raw == null) return null
            if (raw is String) {
                return parseCitationString(raw)
            }
            if (raw is Map<*, *>) {
                @Suppress("UNCHECKED_CAST")
                val map = raw as Map<String, Any?>
                val file = map["file"] as? String
                val line = (map["line"] as? Number)?.toInt()
                val col = ((map["col"] ?: map["column"]) as? Number)?.toInt()
                val expr = (map["expression"] ?: map["expr"]) as? String
                val citationStr = map["citation"] as? String
                    ?: if (file != null && line != null) {
                        if (col != null) "$file:$line:$col" else "$file:$line"
                    } else null

                return RuleCitation(
                    file = file,
                    line = line,
                    column = col,
                    citation = citationStr,
                    expression = expr
                )
            }
            return null
        }

        private fun parseCitationString(str: String): RuleCitation {
            val parts = str.split(":")
            val file = parts.getOrNull(0)?.takeIf { it.isNotBlank() }
            val line = parts.getOrNull(1)?.toIntOrNull()
            val col = parts.getOrNull(2)?.toIntOrNull()
            return RuleCitation(
                file = file,
                line = line,
                column = col,
                citation = str,
                expression = null
            )
        }
    }
}

data class EvaluatedAuth(
    val uid: String? = null,
    val token: Map<String, Any?>? = null,
    val tenant: String? = null
) {
    val role: String?
        get() = (token?.get("role") as? String)
            ?: if (token?.get("admin") == true) "admin" else null

    companion object {
        fun fromMap(map: Map<String, Any?>?): EvaluatedAuth? {
            if (map == null) return null
            val uid = map["uid"] as? String
            @Suppress("UNCHECKED_CAST")
            val token = map["token"] as? Map<String, Any?>
            val tenant = map["tenant"] as? String
                ?: token?.let { t ->
                    @Suppress("UNCHECKED_CAST")
                    (t["firebase"] as? Map<String, Any?>)?.get("tenant") as? String
                }

            return EvaluatedAuth(uid = uid, token = token, tenant = tenant)
        }
    }
}

data class DeniedRequest(
    val method: String? = null,
    val path: String? = null,
    val resourceData: Map<String, Any?>? = null,
    /** The proposed value as sent. An RTDB write may propose any JSON value. */
    val proposedValue: Any? = null
) {
    companion object {
        fun fromMap(map: Map<String, Any?>?): DeniedRequest? {
            if (map == null) return null
            // Kept as sent: RTDB methods such as `setPriority` are camelCase.
            val method = map["method"] as? String
            val path = map["path"] as? String
            val proposed = map["resourceData"] ?: map["data"]
            @Suppress("UNCHECKED_CAST")
            val data = proposed as? Map<String, Any?>
            return DeniedRequest(method = method, path = path, resourceData = data, proposedValue = proposed)
        }
    }
}

data class DeniedResource(
    val exists: Boolean = false,
    val data: Map<String, Any?>? = null
) {
    companion object {
        fun fromMap(map: Map<String, Any?>?): DeniedResource? {
            if (map == null) return null
            val exists = map["exists"] == true
            @Suppress("UNCHECKED_CAST")
            val data = map["data"] as? Map<String, Any?>
            return DeniedResource(exists = exists, data = data)
        }
    }
}

data class DeniedQuery(
    val where: List<Map<String, Any?>> = emptyList(),
    val limit: Long? = null,
    val orderBy: String? = null
) {
    companion object {
        fun fromMap(map: Map<String, Any?>?): DeniedQuery? {
            if (map == null) return null
            @Suppress("UNCHECKED_CAST")
            val whereList = (map["where"] as? List<Map<String, Any?>>) ?: emptyList()
            val limitVal = (map["limit"] as? Number)?.toLong()
            val orderVal = map["orderBy"] as? String
            return DeniedQuery(where = whereList, limit = limitVal, orderBy = orderVal)
        }
    }
}

data class QueryProofFailure(
    val kind: String? = null,
    val reason: String? = null,
    val residual: Map<String, Any?>? = null,
    val predicate: RuleCitation? = null,
    val rule: RuleCitation? = null,
    val raw: Map<String, Any?> = emptyMap()
) {
    companion object {
        fun fromMap(map: Map<String, Any?>?): QueryProofFailure? {
            if (map == null) return null
            @Suppress("UNCHECKED_CAST")
            val residual = map["residual"] as? Map<String, Any?>
            return QueryProofFailure(
                kind = map["kind"] as? String,
                reason = map["reason"] as? String,
                residual = residual,
                predicate = RuleCitation.parse(map["predicate"]),
                rule = RuleCitation.parse(map["rule"]),
                raw = map
            )
        }
    }
}

data class QueryProof(
    val kind: String? = null,
    val verdict: String? = null,
    val provable: Boolean? = null,
    val reason: String? = null,
    val remediation: String? = null,
    val rule: RuleCitation? = null,
    val failures: List<QueryProofFailure> = emptyList(),
    val query: Any? = null,
    val raw: Map<String, Any?> = emptyMap()
) {
    companion object {
        fun fromMap(map: Map<String, Any?>?): QueryProof? {
            if (map == null) return null
            val rawFailures = map["failures"] as? List<*>
            val failures = rawFailures?.mapNotNull { entry ->
                @Suppress("UNCHECKED_CAST")
                QueryProofFailure.fromMap(entry as? Map<String, Any?>)
            } ?: emptyList()
            return QueryProof(
                kind = map["kind"] as? String,
                verdict = map["verdict"] as? String,
                provable = map["provable"] as? Boolean,
                reason = map["reason"] as? String,
                remediation = map["remediation"] as? String,
                rule = RuleCitation.parse(map["rule"]),
                failures = failures,
                query = map["query"],
                raw = map
            )
        }
    }
}

data class QueryRepro(
    val command: String? = null,
    val testCase: Map<String, Any?>? = null,
    val raw: Map<String, Any?> = emptyMap()
) {
    companion object {
        fun fromMap(map: Map<String, Any?>?): QueryRepro? {
            if (map == null) return null
            @Suppress("UNCHECKED_CAST")
            val testCase = map["testCase"] as? Map<String, Any?>
            return QueryRepro(
                command = map["command"] as? String,
                testCase = testCase,
                raw = map
            )
        }
    }
}

enum class FieldDiffKind {
    ADDED,
    MODIFIED,
    REMOVED
}

data class FieldDiff(
    val path: String,
    val oldValue: Any?,
    val newValue: Any?,
    val kind: FieldDiffKind
)

/**
 * A Security Rules denial frame. [engine] names the rules engine: "firestore"
 * (the default when a frame names none), "rtdb", or "storage". An RTDB frame
 * carries the deciding rules node ([matchedPath]), its expression
 * ([matchedRule]) and the `$` wildcard bindings in place of a line citation;
 * [rule] is derived from them.
 */
data class RulesDenialContext(
    val rule: RuleCitation? = null,
    val auth: EvaluatedAuth? = null,
    val reasons: List<String> = emptyList(),
    val failedFields: List<String> = emptyList(),
    val request: DeniedRequest? = null,
    val resource: DeniedResource? = null,
    val query: DeniedQuery? = null,
    val engine: String = "firestore",
    val matchedPath: String? = null,
    val matchedRule: String? = null,
    val pathVariableBindings: Map<String, String>? = null,
    val reason: String? = null,
    val errorCode: String? = null,
    val queryProof: QueryProof? = null,
    val repro: QueryRepro? = null,
    val remediation: String? = null
) {
    val isRtdb: Boolean
        get() = engine == "rtdb"

    val isStorage: Boolean
        get() = engine == "storage"

    fun computeDataDiff(): List<FieldDiff> {
        val method = request?.method?.lowercase()
        if (method in NON_WRITE_DIFF_METHODS) return emptyList()
        val newData = request?.resourceData ?: return emptyList()
        val oldData = resource?.data ?: emptyMap()
        val diffs = mutableListOf<FieldDiff>()

        val allKeys = (oldData.keys + newData.keys).toSortedSet()
        for (key in allKeys) {
            val inOld = oldData.containsKey(key)
            val inNew = newData.containsKey(key)
            val oldVal = oldData[key]
            val newVal = newData[key]

            if (!inOld && inNew) {
                diffs.add(FieldDiff(key, null, newVal, FieldDiffKind.ADDED))
            } else if (inOld && !inNew) {
                diffs.add(FieldDiff(key, oldVal, null, FieldDiffKind.REMOVED))
            } else if (oldVal != newVal) {
                diffs.add(FieldDiff(key, oldVal, newVal, FieldDiffKind.MODIFIED))
            }
        }
        return diffs
    }

    companion object {
        private const val RTDB_RULES_FILE = "database.rules.json"
        private const val STORAGE_RULES_FILE = "storage.rules"
        private val NON_WRITE_DIFF_METHODS = setOf("get", "list", "listen", "query", "delete", "remove")
        private val STORAGE_MSG_PATTERN = Regex(
            """^(?:storage/unauthorized:\s*)?([A-Za-z]+)\s+"([^"]+)"(?:\s+in\s+bucket\s+"([^"]+)")?""",
            RegexOption.IGNORE_CASE
        )

        fun fromMap(map: Map<String, Any?>): RulesDenialContext {
            val engine = map["engine"] as? String ?: "firestore"
            val matchedPath = map["matchedPath"] as? String
            val matchedRule = map["matchedRule"] as? String
            val rtdbRule = if (engine == "rtdb") {
                RuleCitation(
                    file = RTDB_RULES_FILE,
                    citation = if (matchedPath != null) "$RTDB_RULES_FILE $matchedPath" else RTDB_RULES_FILE,
                    expression = matchedRule
                )
            } else null
            val rule = RuleCitation.parse(map["rule"]) ?: rtdbRule
            val pathVariableBindings = (map["pathVariableBindings"] as? Map<*, *>)
                ?.entries
                ?.mapNotNull { (key, value) -> if (key is String && value != null) key to value.toString() else null }
                ?.toMap()
            @Suppress("UNCHECKED_CAST")
            val auth = EvaluatedAuth.fromMap(map["auth"] as? Map<String, Any?>)
            @Suppress("UNCHECKED_CAST")
            val reasons = (map["reasons"] as? List<*>)?.mapNotNull { it?.toString() } ?: emptyList()
            @Suppress("UNCHECKED_CAST")
            val failedFields = (map["failedFields"] as? List<*>)?.mapNotNull { it?.toString() } ?: emptyList()
            @Suppress("UNCHECKED_CAST")
            val request = DeniedRequest.fromMap(map["request"] as? Map<String, Any?>)
            @Suppress("UNCHECKED_CAST")
            val resource = DeniedResource.fromMap(map["resource"] as? Map<String, Any?>)
            @Suppress("UNCHECKED_CAST")
            val query = DeniedQuery.fromMap(map["query"] as? Map<String, Any?>)
            @Suppress("UNCHECKED_CAST")
            val queryProof = QueryProof.fromMap(map["queryProof"] as? Map<String, Any?>)
            @Suppress("UNCHECKED_CAST")
            val repro = QueryRepro.fromMap(map["repro"] as? Map<String, Any?>)

            return RulesDenialContext(
                rule = rule,
                auth = auth,
                reasons = reasons,
                failedFields = failedFields,
                request = request,
                resource = resource,
                query = query,
                engine = engine,
                matchedPath = matchedPath,
                matchedRule = matchedRule,
                pathVariableBindings = pathVariableBindings,
                reason = map["reason"] as? String,
                errorCode = map["errorCode"] as? String,
                queryProof = queryProof,
                repro = repro,
                remediation = map["remediation"] as? String
            )
        }

        fun fromException(
            exception: FirebaseFirestoreException,
            contextMap: Map<String, Any?> = emptyMap(),
            activeLens: AuthLens? = null
        ): RulesDenialContext {
            if (contextMap.isNotEmpty()) {
                return fromMap(contextMap)
            }
            val rawMessage = exception.message?.trim().orEmpty()
            val wireCode = exception.wireCode
            val isStorageDenial =
                wireCode.equals("storage/unauthorized", ignoreCase = true) ||
                    wireCode.equals("unauthorized", ignoreCase = true) ||
                    rawMessage.startsWith("storage/unauthorized", ignoreCase = true)
            val fallbackAuth = when (activeLens) {
                is AuthLens.AsUser -> EvaluatedAuth(
                    uid = activeLens.uid,
                    token = activeLens.token,
                    tenant = activeLens.tenant
                )
                is AuthLens.Anon -> EvaluatedAuth(uid = null)
                else -> null
            }
            if (!isStorageDenial) {
                return RulesDenialContext(
                    auth = fallbackAuth,
                    reasons = if (rawMessage.isNotEmpty()) listOf(rawMessage) else emptyList(),
                    errorCode = wireCode
                )
            }
            val match = STORAGE_MSG_PATTERN.find(rawMessage)
            val method = match?.groupValues?.get(1)?.lowercase() ?: "storage"
            val path = match?.groupValues?.get(2)?.takeIf { it.isNotBlank() }
            val cleanReason = rawMessage
                .removePrefix("storage/unauthorized:")
                .removePrefix("STORAGE/UNAUTHORIZED:")
                .trim()
                .ifEmpty { "Storage operation denied by security rules." }
            return RulesDenialContext(
                rule = RuleCitation(file = STORAGE_RULES_FILE, citation = STORAGE_RULES_FILE),
                auth = fallbackAuth,
                reasons = listOf(cleanReason),
                request = DeniedRequest(method = method, path = path),
                engine = "storage",
                reason = cleanReason,
                errorCode = wireCode ?: "storage/unauthorized"
            )
        }
    }
}
