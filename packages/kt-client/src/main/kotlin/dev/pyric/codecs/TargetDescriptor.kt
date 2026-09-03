package dev.pyric.codecs

sealed class TargetDescriptor {

    abstract fun toMap(): Map<String, Any?>

    data class DocumentTarget(val path: String) : TargetDescriptor() {
        override fun toMap(): Map<String, Any?> = mapOf(
            "__ref" to "doc",
            "path" to path
        )
    }

    data class CollectionTarget(val path: String) : TargetDescriptor() {
        override fun toMap(): Map<String, Any?> = mapOf(
            "__ref" to "collection",
            "path" to path
        )
    }

    data class CollectionGroupTarget(val collectionId: String) : TargetDescriptor() {
        override fun toMap(): Map<String, Any?> = mapOf(
            "__ref" to "group",
            "collectionId" to collectionId
        )
    }

    data class QueryTarget(
        val source: TargetDescriptor,
        val constraints: List<Map<String, Any?>>
    ) : TargetDescriptor() {
        override fun toMap(): Map<String, Any?> {
            return if (constraints.isEmpty()) {
                source.toMap()
            } else {
                mapOf(
                    "__ref" to "query",
                    "source" to source.toMap(),
                    "constraints" to constraints
                )
            }
        }
    }
}
