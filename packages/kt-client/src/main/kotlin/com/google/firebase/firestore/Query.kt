package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import dev.pyric.codecs.Cursor
import dev.pyric.codecs.DocumentDataEnvelope
import dev.pyric.codecs.OrderBy
import dev.pyric.codecs.QueryCompiler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch

open class Query internal constructor(
    val firestore: FirebaseFirestore,
    val path: String? = null,
    val collectionId: String,
    val isCollectionGroup: Boolean = false,
    val filters: List<Filter> = emptyList(),
    val orderBys: List<OrderBy> = emptyList(),
    val limitValue: Long? = null,
    val limitToLastValue: Long? = null,
    val cursors: List<Cursor> = emptyList()
) {
    enum class Direction {
        ASCENDING,
        DESCENDING
    }

    fun whereEqualTo(field: String, value: Any?): Query = where(Filter.equalTo(field, value))
    fun whereEqualTo(fieldPath: FieldPath, value: Any?): Query = where(Filter.equalTo(fieldPath, value))

    fun whereNotEqualTo(field: String, value: Any?): Query = where(Filter.notEqualTo(field, value))
    fun whereNotEqualTo(fieldPath: FieldPath, value: Any?): Query = where(Filter.notEqualTo(fieldPath, value))

    fun whereLessThan(field: String, value: Any?): Query = where(Filter.lessThan(field, value))
    fun whereLessThan(fieldPath: FieldPath, value: Any?): Query = where(Filter.lessThan(fieldPath, value))

    fun whereLessThanOrEqualTo(field: String, value: Any?): Query = where(Filter.lessThanOrEqualTo(field, value))
    fun whereLessThanOrEqualTo(fieldPath: FieldPath, value: Any?): Query = where(Filter.lessThanOrEqualTo(fieldPath, value))

    fun whereGreaterThan(field: String, value: Any?): Query = where(Filter.greaterThan(field, value))
    fun whereGreaterThan(fieldPath: FieldPath, value: Any?): Query = where(Filter.greaterThan(fieldPath, value))

    fun whereGreaterThanOrEqualTo(field: String, value: Any?): Query = where(Filter.greaterThanOrEqualTo(field, value))
    fun whereGreaterThanOrEqualTo(fieldPath: FieldPath, value: Any?): Query = where(Filter.greaterThanOrEqualTo(fieldPath, value))

    fun whereArrayContains(field: String, value: Any?): Query = where(Filter.arrayContains(field, value))
    fun whereArrayContains(fieldPath: FieldPath, value: Any?): Query = where(Filter.arrayContains(fieldPath, value))

    fun whereArrayContainsAny(field: String, values: List<Any?>): Query = where(Filter.arrayContainsAny(field, values))
    fun whereArrayContainsAny(fieldPath: FieldPath, values: List<Any?>): Query = where(Filter.arrayContainsAny(fieldPath, values))

    fun whereIn(field: String, values: List<Any?>): Query = where(Filter.inArray(field, values))
    fun whereIn(fieldPath: FieldPath, values: List<Any?>): Query = where(Filter.inArray(fieldPath, values))

    fun whereNotIn(field: String, values: List<Any?>): Query = where(Filter.notInArray(field, values))
    fun whereNotIn(fieldPath: FieldPath, values: List<Any?>): Query = where(Filter.notInArray(fieldPath, values))

    fun where(filter: Filter): Query {
        validateFilter(filter)
        return copy(filters = filters + filter)
    }

    private fun validateFilter(filter: Filter) {
        when (filter) {
            is Filter.Unary -> {
                val field = filter.fieldPath.canonicalString
                val op = filter.operator
                if (field == "__name__" && (op == Filter.Unary.Operator.ARRAY_CONTAINS || op == Filter.Unary.Operator.ARRAY_CONTAINS_ANY)) {
                    throw IllegalArgumentException("Invalid query. You can't perform '${op.wireOp}' queries on FieldPath.documentId().")
                }
                if (filter.value is FieldValue) {
                    throw IllegalArgumentException("Invalid query value: FieldValue sentinels cannot be used in query filters.")
                }
                if (op == Filter.Unary.Operator.IN || op == Filter.Unary.Operator.NOT_IN || op == Filter.Unary.Operator.ARRAY_CONTAINS_ANY) {
                    val list = when (val v = filter.value) {
                        is List<*> -> v
                        is Array<*> -> v.asList()
                        else -> null
                    } ?: throw IllegalArgumentException("Invalid Query. A non-empty array is required for '${op.wireOp}' filters.")
                    require(list.isNotEmpty()) { "Invalid Query. A non-empty array is required for '${op.wireOp}' filters." }
                    require(list.size <= 30) { "Invalid Query. '${op.wireOp}' filters support a maximum of 30 elements in the value array." }
                }
            }
            is Filter.Composite -> {
                filter.filters.forEach { validateFilter(it) }
            }
        }
    }

    fun orderBy(field: String, direction: Direction = Direction.ASCENDING): Query {
        require(cursors.isEmpty()) {
            "You must not call Query.startAt() or Query.startAfter() before calling Query.orderBy()."
        }
        val dir = if (direction == Direction.ASCENDING) dev.pyric.codecs.Direction.ASCENDING else dev.pyric.codecs.Direction.DESCENDING
        return copy(orderBys = orderBys + OrderBy(field, dir))
    }

    fun orderBy(fieldPath: FieldPath, direction: Direction = Direction.ASCENDING): Query =
        orderBy(fieldPath.canonicalString, direction)

    fun limit(limit: Long): Query {
        require(limit > 0) { "Given limit must be greater than 0" }
        return copy(limitValue = limit, limitToLastValue = null)
    }

    fun limitToLast(limit: Long): Query {
        require(limit > 0) { "Given limit must be greater than 0" }
        return copy(limitToLastValue = limit, limitValue = null)
    }

    fun startAt(vararg fieldValues: Any?): Query =
        addCursor(Cursor.Kind.START_AT, fieldValues.toList())

    fun startAt(snapshot: DocumentSnapshot): Query =
        addCursor(Cursor.Kind.START_AT, extractSnapshotValues(snapshot))

    fun startAfter(vararg fieldValues: Any?): Query =
        addCursor(Cursor.Kind.START_AFTER, fieldValues.toList())

    fun startAfter(snapshot: DocumentSnapshot): Query =
        addCursor(Cursor.Kind.START_AFTER, extractSnapshotValues(snapshot))

    fun endBefore(vararg fieldValues: Any?): Query =
        addCursor(Cursor.Kind.END_BEFORE, fieldValues.toList())

    fun endBefore(snapshot: DocumentSnapshot): Query =
        addCursor(Cursor.Kind.END_BEFORE, extractSnapshotValues(snapshot))

    fun endAt(vararg fieldValues: Any?): Query =
        addCursor(Cursor.Kind.END_AT, fieldValues.toList())

    fun endAt(snapshot: DocumentSnapshot): Query =
        addCursor(Cursor.Kind.END_AT, extractSnapshotValues(snapshot))

    private fun addCursor(kind: Cursor.Kind, values: List<Any?>): Query {
        val newCursor = Cursor(kind, values)
        val filtered = cursors.filter {
            if (kind == Cursor.Kind.START_AT || kind == Cursor.Kind.START_AFTER) {
                it.kind != Cursor.Kind.START_AT && it.kind != Cursor.Kind.START_AFTER
            } else {
                it.kind != Cursor.Kind.END_AT && it.kind != Cursor.Kind.END_BEFORE
            }
        }
        return copy(cursors = filtered + newCursor)
    }

    private fun extractSnapshotValues(snapshot: DocumentSnapshot): List<Any?> {
        require(snapshot.exists()) {
            "Can't use a DocumentSnapshot for a document that doesn't exist for startAt()."
        }
        val values = mutableListOf<Any?>()
        for (order in orderBys) {
            if (order.field == "__name__") {
                values.add(snapshot.reference.path)
            } else {
                values.add(snapshot.get(order.field))
            }
        }
        return values
    }

    fun toTargetDescriptor(): Map<String, Any?> {
        return QueryCompiler.compileTarget(
            path = path,
            collectionId = collectionId,
            isCollectionGroup = isCollectionGroup,
            filters = filters,
            orderBys = orderBys,
            limitValue = limitValue,
            limitToLastValue = limitToLastValue,
            cursors = cursors
        )
    }

    fun get(source: Source = Source.DEFAULT): Task<QuerySnapshot> {
        val tcs = TaskCompletionSource<QuerySnapshot>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                val targetDesc = toTargetDescriptor()
                val res = firestore.bridgeClient.op(
                    method = "getDocs",
                    params = mapOf("target" to targetDesc)
                )
                @Suppress("UNCHECKED_CAST")
                val resMap = res as? Map<String, Any?> ?: emptyMap()
                @Suppress("UNCHECKED_CAST")
                val rawDocs = (resMap["docs"] as? List<Map<String, Any?>>) ?: emptyList()

                val docs = rawDocs.map { docMap ->
                    val docId = docMap["id"] as String
                    val docPath = docMap["path"] as String
                    val unpackedData = DocumentDataEnvelope.unpack(docMap["data"]) { p -> firestore.document(p) }
                    QueryDocumentSnapshot(
                        id = docId,
                        reference = firestore.document(docPath),
                        dataMap = unpackedData,
                        metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
                    )
                }

                val snapshot = QuerySnapshot(
                    query = this@Query,
                    documents = docs,
                    documentChanges = emptyList(),
                    metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
                )
                tcs.setResult(snapshot)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun count(): AggregateQuery = AggregateQuery(this, listOf(AggregateField.count()))

    fun aggregate(field: AggregateField, vararg moreFields: AggregateField): AggregateQuery =
        AggregateQuery(this, listOf(field) + moreFields.toList())

    fun addSnapshotListener(
        metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE,
        listener: EventListener<QuerySnapshot>
    ): ListenerRegistration {
        val scope = CoroutineScope(Dispatchers.IO)
        val flow = firestore.bridgeClient.subscribe(
            target = toTargetDescriptor(),
            includeMetadataChanges = (metadataChanges == MetadataChanges.INCLUDE)
        )

        var job: Job? = null
        job = scope.launch {
            flow.catch { e ->
                val fse = (e as? FirebaseFirestoreException)
                    ?: FirebaseFirestoreException(e.message ?: "Query snapshot error", FirebaseFirestoreException.Code.UNKNOWN, e)
                listener.onEvent(null, fse)
            }.collect { rawMsg ->
                @Suppress("UNCHECKED_CAST")
                val resMap = rawMsg as? Map<String, Any?> ?: emptyMap()
                @Suppress("UNCHECKED_CAST")
                val rawDocs = (resMap["docs"] as? List<Map<String, Any?>>) ?: emptyList()

                val docs = rawDocs.map { docMap ->
                    val docId = docMap["id"] as String
                    val docPath = docMap["path"] as String
                    val unpackedData = DocumentDataEnvelope.unpack(docMap["data"]) { p -> firestore.document(p) }
                    QueryDocumentSnapshot(
                        id = docId,
                        reference = firestore.document(docPath),
                        dataMap = unpackedData,
                        metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
                    )
                }

                val snapshot = QuerySnapshot(
                    query = this@Query,
                    documents = docs,
                    documentChanges = emptyList(),
                    metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
                )
                listener.onEvent(snapshot, null)
            }
        }

        return ListenerRegistration { job.cancel() }
    }

    private fun copy(
        filters: List<Filter> = this.filters,
        orderBys: List<OrderBy> = this.orderBys,
        limitValue: Long? = this.limitValue,
        limitToLastValue: Long? = this.limitToLastValue,
        cursors: List<Cursor> = this.cursors
    ): Query = Query(
        firestore = firestore,
        path = path,
        collectionId = collectionId,
        isCollectionGroup = isCollectionGroup,
        filters = filters,
        orderBys = orderBys,
        limitValue = limitValue,
        limitToLastValue = limitToLastValue,
        cursors = cursors
    )

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Query) return false
        return firestore == other.firestore && path == other.path && collectionId == other.collectionId &&
                isCollectionGroup == other.isCollectionGroup && filters == other.filters &&
                orderBys == other.orderBys && limitValue == other.limitValue &&
                limitToLastValue == other.limitToLastValue && cursors == other.cursors
    }

    override fun hashCode(): Int {
        var result = firestore.hashCode()
        result = 31 * result + (path?.hashCode() ?: 0)
        result = 31 * result + collectionId.hashCode()
        result = 31 * result + isCollectionGroup.hashCode()
        result = 31 * result + filters.hashCode()
        result = 31 * result + orderBys.hashCode()
        result = 31 * result + (limitValue?.hashCode() ?: 0)
        result = 31 * result + (limitToLastValue?.hashCode() ?: 0)
        result = 31 * result + cursors.hashCode()
        return result
    }

    override fun toString(): String =
        "Query(path=$path, collectionId=$collectionId, isCollectionGroup=$isCollectionGroup, filters=$filters, orderBys=$orderBys, limit=$limitValue, limitToLast=$limitToLastValue)"
}
