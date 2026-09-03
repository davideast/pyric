package com.google.firebase.firestore

class QuerySnapshot internal constructor(
    val query: Query,
    val documents: List<DocumentSnapshot>,
    val documentChanges: List<DocumentChange> = emptyList(),
    val metadata: SnapshotMetadata = SnapshotMetadata()
) : Iterable<QueryDocumentSnapshot> {

    fun size(): Int = documents.size
    val size: Int get() = size()

    @JvmName("isEmptyMethod")
    fun isEmpty(): Boolean = documents.isEmpty()
    val isEmpty: Boolean get() = isEmpty()

    @JvmName("getDocumentsMethod")
    fun getDocuments(): List<DocumentSnapshot> = documents

    @JvmName("getDocumentChangesMethod")
    fun getDocumentChanges(metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE): List<DocumentChange> = documentChanges

    override fun iterator(): Iterator<QueryDocumentSnapshot> =
        documents.filterIsInstance<QueryDocumentSnapshot>().iterator()

    fun <T> toObjects(valueType: Class<T>): List<T> =
        documents.mapNotNull { it.toObject(valueType) }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is QuerySnapshot) return false
        return query == other.query && documents == other.documents && metadata == other.metadata
    }

    override fun hashCode(): Int {
        var result = query.hashCode()
        result = 31 * result + documents.hashCode()
        result = 31 * result + metadata.hashCode()
        return result
    }

    override fun toString(): String =
        "QuerySnapshot(query=$query, count=${documents.size}, metadata=$metadata)"
}
