package com.google.firebase.firestore

class QueryDocumentSnapshot internal constructor(
    id: String,
    reference: DocumentReference,
    private val dataMap: Map<String, Any?>,
    metadata: SnapshotMetadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
) : DocumentSnapshot(id, reference, true, dataMap, metadata) {

    override fun exists(): Boolean = true

    override fun getData(): Map<String, Any?> = dataMap

    override fun <T> toObject(valueType: Class<T>): T = super.toObject(valueType)!!
}

val QueryDocumentSnapshot.data: Map<String, Any?>
    get() = getData()
