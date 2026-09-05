package dev.pyric.debug.model

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
    val resourceData: Map<String, Any?>? = null
) {
    companion object {
        fun fromMap(map: Map<String, Any?>?): DeniedRequest? {
            if (map == null) return null
            val method = (map["method"] as? String)?.lowercase()
            val path = map["path"] as? String
            @Suppress("UNCHECKED_CAST")
            val data = (map["resourceData"] ?: map["data"]) as? Map<String, Any?>
            return DeniedRequest(method = method, path = path, resourceData = data)
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

data class RulesDenialContext(
    val rule: RuleCitation? = null,
    val auth: EvaluatedAuth? = null,
    val reasons: List<String> = emptyList(),
    val failedFields: List<String> = emptyList(),
    val request: DeniedRequest? = null,
    val resource: DeniedResource? = null,
    val query: DeniedQuery? = null
) {
    fun computeDataDiff(): List<FieldDiff> {
        val oldData = resource?.data ?: emptyMap()
        val newData = request?.resourceData ?: emptyMap()
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
        fun fromMap(map: Map<String, Any?>): RulesDenialContext {
            val rule = RuleCitation.parse(map["rule"])
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

            return RulesDenialContext(
                rule = rule,
                auth = auth,
                reasons = reasons,
                failedFields = failedFields,
                request = request,
                resource = resource,
                query = query
            )
        }
    }
}
