package com.google.firebase.storage

import java.util.Collections

/**
 * Contains the prefixes (folders), items (files), and pagination token returned
 * by [StorageReference.list] and [StorageReference.listAll].
 */
class ListResult internal constructor(
    prefixes: List<StorageReference>,
    items: List<StorageReference>,
    val pageToken: String?
) {
    val prefixes: List<StorageReference> = Collections.unmodifiableList(ArrayList(prefixes))
    val items: List<StorageReference> = Collections.unmodifiableList(ArrayList(items))
}
