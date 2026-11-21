package dev.pyric.codecs

import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Filter

object QueryCompiler {

    private val INEQUALITY_OPERATORS = setOf(
        Filter.Unary.Operator.NOT_EQUAL,
        Filter.Unary.Operator.LESS_THAN,
        Filter.Unary.Operator.LESS_THAN_OR_EQUAL,
        Filter.Unary.Operator.GREATER_THAN,
        Filter.Unary.Operator.GREATER_THAN_OR_EQUAL,
        Filter.Unary.Operator.NOT_IN
    )

    fun compileTarget(
        path: String?,
        collectionId: String,
        isCollectionGroup: Boolean,
        filters: List<Filter>,
        orderBys: List<OrderBy>,
        limitValue: Long?,
        limitToLastValue: Long?,
        cursors: List<Cursor>
    ): Map<String, Any?> {
        val source: TargetDescriptor = if (isCollectionGroup) {
            TargetDescriptor.CollectionGroupTarget(collectionId)
        } else {
            TargetDescriptor.CollectionTarget(path ?: collectionId)
        }

        val constraints = mutableListOf<Map<String, Any?>>()

        // 1. Compile filters
        for (filter in filters) {
            val compiled = compileFilter(filter)
            if (compiled != null) {
                constraints.add(compiled)
            }
        }

        // 2. Compile orderBys
        for (orderBy in orderBys) {
            val entry = LinkedHashMap<String, Any?>()
            entry["kind"] = "orderBy"
            entry["field"] = orderBy.field
            if (orderBy.fieldPath != FieldPath.documentId()) {
                entry["fieldSegments"] = orderBy.fieldPath.segments
            }
            entry["direction"] = orderBy.direction.wireValue
            constraints.add(entry)
        }

        // 3. Compile limit / limitToLast
        if (limitValue != null) {
            require(limitValue > 0) { "Given limit must be greater than 0" }
        }
        if (limitToLastValue != null) {
            require(limitToLastValue > 0) { "Given limit must be greater than 0" }
            require(orderBys.isNotEmpty()) {
                "limitToLast() queries require at least one orderBy clause."
            }
            constraints.add(mapOf("kind" to "limitToLast", "n" to limitToLastValue))
        } else if (limitValue != null) {
            constraints.add(mapOf("kind" to "limit", "n" to limitValue))
        }

        // 4. Compile cursors
        val normalizedOrders by lazy { computeNormalizedOrders(orderBys, filters) }
        for (cursor in cursors) {
            val snap = cursor.snapshot
            if (snap != null) {
                require(snap.exists()) {
                    "Can't use a DocumentSnapshot for a document that doesn't exist for ${cursor.kind.wireKind}()."
                }
                val encodedValues = normalizedOrders.map { order ->
                    if (order.fieldPath == FieldPath.documentId()) {
                        mapOf(
                            "__type" to "reference",
                            "path" to snap.reference.path
                        )
                    } else {
                        require(snap.contains(order.fieldPath)) {
                            "Invalid query. You are trying to start or end a query using a document for which the field '${order.fieldPath}' is an undefined value."
                        }
                        ValueCodec.encodeQueryOperand(snap.get(order.fieldPath))
                    }
                }
                constraints.add(
                    mapOf(
                        "kind" to cursor.kind.wireKind,
                        "values" to encodedValues,
                        "fromSnapshot" to true,
                        "valueEncoding" to ValueCodec.DOC_VALUE_ENCODING_V1
                    )
                )
            } else {
                require(orderBys.isNotEmpty()) {
                    "You must not call Query.${cursor.kind.wireKind}() before calling Query.orderBy()."
                }
                require(cursor.values.size <= orderBys.size) {
                    "Too many arguments provided to Query.${cursor.kind.wireKind}(). The number of arguments must be less than or equal to the number of Query.orderBy() clauses."
                }
                val encodedValues = cursor.values.mapIndexed { idx, rawVal ->
                    if (rawVal is FieldValue) {
                        throw IllegalArgumentException(
                            "Invalid query value: FieldValue sentinels cannot be used in query cursors."
                        )
                    }
                    if (orderBys[idx].fieldPath == FieldPath.documentId()) {
                        encodeExplicitDocumentIdCursor(rawVal, isCollectionGroup)
                    } else {
                        ValueCodec.encodeQueryOperand(rawVal)
                    }
                }
                constraints.add(
                    mapOf(
                        "kind" to cursor.kind.wireKind,
                        "values" to encodedValues,
                        "valueEncoding" to ValueCodec.DOC_VALUE_ENCODING_V1
                    )
                )
            }
        }

        return TargetDescriptor.QueryTarget(source, constraints).toMap()
    }

    private fun encodeExplicitDocumentIdCursor(rawVal: Any?, isCollectionGroup: Boolean): String {
        return when (rawVal) {
            is DocumentReference -> rawVal.path
            is String -> {
                require(rawVal.isNotEmpty()) {
                    "Invalid query. When querying with FieldPath.documentId(), you must provide a valid non-empty document ID."
                }
                if (isCollectionGroup) {
                    val segs = rawVal.trim('/').split('/').filter { it.isNotEmpty() }
                    require(segs.isNotEmpty() && segs.size % 2 == 0) {
                        "Invalid query. When querying a collection group by FieldPath.documentId(), the value provided must result in a valid document path, but '$rawVal' has ${segs.size} segment(s)."
                    }
                }
                rawVal
            }
            else -> throw IllegalArgumentException(
                "Invalid query. Expected a String or DocumentReference for a FieldPath.documentId() cursor value."
            )
        }
    }

    private fun computeNormalizedOrders(
        explicitOrders: List<OrderBy>,
        filters: List<Filter>
    ): List<OrderBy> {
        val result = explicitOrders.toMutableList()
        val seen = result.map { it.fieldPath }.toMutableSet()
        val lastDirection = explicitOrders.lastOrNull()?.direction ?: Direction.ASCENDING

        val inequalityFields = mutableSetOf<FieldPath>()
        for (filter in filters) {
            collectInequalityFields(filter, inequalityFields)
        }

        val unordered = inequalityFields
            .filter { it != FieldPath.documentId() && it !in seen }
            .sorted()
        for (fp in unordered) {
            seen.add(fp)
            result.add(OrderBy(fp.canonicalString, lastDirection, fp))
        }

        if (FieldPath.documentId() !in seen) {
            result.add(OrderBy("__name__", lastDirection, FieldPath.documentId()))
        }
        return result
    }

    private fun collectInequalityFields(filter: Filter, out: MutableSet<FieldPath>) {
        when (filter) {
            is Filter.Unary -> {
                if (filter.operator in INEQUALITY_OPERATORS) {
                    out.add(filter.fieldPath)
                }
            }
            is Filter.Composite -> {
                for (nested in filter.filters) {
                    collectInequalityFields(nested, out)
                }
            }
        }
    }

    private fun compileFilter(filter: Filter): Map<String, Any?>? {
        return when (filter) {
            is Filter.Unary -> {
                val field = filter.fieldPath.canonicalString
                if (field == "__name__" && (filter.operator == Filter.Unary.Operator.ARRAY_CONTAINS || filter.operator == Filter.Unary.Operator.ARRAY_CONTAINS_ANY)) {
                    throw IllegalArgumentException("Invalid query. You can't perform '${filter.operator.wireOp}' queries on FieldPath.documentId().")
                }
                if (filter.value is FieldValue) {
                    throw IllegalArgumentException("Invalid query value: FieldValue sentinels cannot be used in query filters.")
                }
                val op = filter.operator
                if (op == Filter.Unary.Operator.IN || op == Filter.Unary.Operator.NOT_IN || op == Filter.Unary.Operator.ARRAY_CONTAINS_ANY) {
                    val list = when (val v = filter.value) {
                        is List<*> -> v
                        is Array<*> -> v.asList()
                        else -> null
                    } ?: throw IllegalArgumentException("Invalid Query. A non-empty array is required for '${op.wireOp}' filters.")
                    require(list.isNotEmpty()) { "Invalid Query. A non-empty array is required for '${op.wireOp}' filters." }
                    require(list.size <= 30) { "Invalid Query. '${op.wireOp}' filters support a maximum of 30 elements in the value array." }
                    if (list.any { it is FieldValue }) {
                        throw IllegalArgumentException("Invalid query value: FieldValue sentinels cannot be used in query filters.")
                    }
                }
                val entry = LinkedHashMap<String, Any?>()
                entry["kind"] = "where"
                entry["field"] = field
                if (filter.fieldPath != FieldPath.documentId()) {
                    entry["fieldSegments"] = filter.fieldPath.segments
                }
                entry["op"] = filter.operator.wireOp
                entry["value"] = ValueCodec.encodeQueryOperand(filter.value)
                entry["valueEncoding"] = ValueCodec.DOC_VALUE_ENCODING_V1
                entry
            }
            is Filter.Composite -> {
                if (filter.filters.isEmpty()) {
                    null
                } else if (filter.filters.size == 1) {
                    compileFilter(filter.filters.first())
                } else {
                    val subFilters = filter.filters.mapNotNull { compileFilter(it) }
                    mapOf(
                        "kind" to filter.operator.wireOp,
                        "filters" to subFilters
                    )
                }
            }
        }
    }
}
