package dev.pyric.codecs

import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Filter

object QueryCompiler {

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
            constraints.add(
                mapOf(
                    "kind" to "orderBy",
                    "field" to orderBy.field,
                    "direction" to orderBy.direction.wireValue
                )
            )
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
        for (cursor in cursors) {
            require(orderBys.isNotEmpty()) {
                "You must not call Query.${cursor.kind.wireKind}() before calling Query.orderBy()."
            }
            constraints.add(
                mapOf(
                    "kind" to cursor.kind.wireKind,
                    "values" to cursor.values.map { ValueCodec.encodeValue(it) }
                )
            )
        }

        return TargetDescriptor.QueryTarget(source, constraints).toMap()
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
                }
                mapOf(
                    "kind" to "where",
                    "field" to field,
                    "op" to filter.operator.wireOp,
                    "value" to ValueCodec.encodeValue(filter.value)
                )
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
