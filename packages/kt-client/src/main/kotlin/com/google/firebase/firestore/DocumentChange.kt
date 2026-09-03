package com.google.firebase.firestore

class DocumentChange internal constructor(
    val type: Type,
    val document: QueryDocumentSnapshot,
    val oldIndex: Int,
    val newIndex: Int
) {
    enum class Type {
        ADDED,
        MODIFIED,
        REMOVED
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DocumentChange) return false
        return type == other.type && document == other.document && oldIndex == other.oldIndex && newIndex == other.newIndex
    }

    override fun hashCode(): Int {
        var result = type.hashCode()
        result = 31 * result + document.hashCode()
        result = 31 * result + oldIndex
        result = 31 * result + newIndex
        return result
    }

    override fun toString(): String =
        "DocumentChange(type=$type, document=${document.id}, oldIndex=$oldIndex, newIndex=$newIndex)"
}
