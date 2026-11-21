package com.google.firebase.storage

import dev.pyric.codecs.Base64Url

/**
 * Collaborator for delimited prefix listing (`listAll` and cursor-paginated `list`)
 * over the Pyric `storage.listAll` wire operation.
 */
internal object StorageListPaginator {
    private const val PAGE_TOKEN_PREFIX: String = "pyric-cursor:"

    private data class DelimitedEntry(
        val sortKey: String,
        val isPrefix: Boolean,
        val ref: StorageReference
    )

    suspend fun listAll(reference: StorageReference): ListResult {
        val timeoutMs = reference.storage.maxOperationRetryTimeMillis
        val raw = try {
            BridgeStorageOperations.executeStorageOp(
                reference,
                "storage.listAll",
                mapOf("path" to reference.wirePath),
                timeoutMs
            )
        } catch (t: Throwable) {
            throw StorageException.fromWireException(t)
        }
        return parseListAllReply(raw, reference)
    }

    suspend fun list(
        reference: StorageReference,
        maxResults: Int,
        pageToken: String?
    ): ListResult {
        val full = listAll(reference)

        val unified = ArrayList<DelimitedEntry>(full.items.size + full.prefixes.size)
        for (item in full.items) {
            unified.add(DelimitedEntry(sortKey = item.wirePath, isPrefix = false, ref = item))
        }
        for (prefix in full.prefixes) {
            unified.add(DelimitedEntry(sortKey = "${prefix.wirePath}/", isPrefix = true, ref = prefix))
        }
        unified.sortBy { it.sortKey }

        val startIndex = if (pageToken == null) {
            0
        } else {
            val cursorKey = decodePageToken(pageToken)
            val idx = unified.indexOfFirst { it.sortKey > cursorKey }
            if (idx == -1) unified.size else idx
        }

        val endExclusive = minOf(startIndex + maxResults, unified.size)
        val slice = if (startIndex < endExclusive) unified.subList(startIndex, endExclusive) else emptyList()

        val pageItems = ArrayList<StorageReference>()
        val pagePrefixes = ArrayList<StorageReference>()
        for (entry in slice) {
            if (entry.isPrefix) {
                pagePrefixes.add(entry.ref)
            } else {
                pageItems.add(entry.ref)
            }
        }

        val nextToken = if (endExclusive < unified.size && slice.isNotEmpty()) {
            encodePageToken(slice.last().sortKey)
        } else {
            null
        }
        return ListResult(prefixes = pagePrefixes, items = pageItems, pageToken = nextToken)
    }

    private fun encodePageToken(lastSortKey: String): String =
        Base64Url.encodeUnpadded("$PAGE_TOKEN_PREFIX$lastSortKey".toByteArray(Charsets.UTF_8))

    private fun decodePageToken(token: String): String {
        return try {
            val decoded = String(Base64Url.decodeUnpadded(token), Charsets.UTF_8)
            if (!decoded.startsWith(PAGE_TOKEN_PREFIX)) {
                throw StorageException(StorageException.ERROR_UNKNOWN, "Invalid list pageToken.")
            }
            decoded.removePrefix(PAGE_TOKEN_PREFIX)
        } catch (e: StorageException) {
            throw e
        } catch (e: Throwable) {
            throw StorageException(StorageException.ERROR_UNKNOWN, "Invalid list pageToken.", 0, e)
        }
    }

    private fun parseListAllReply(raw: Any?, reference: StorageReference): ListResult {
        @Suppress("UNCHECKED_CAST")
        val map = raw as? Map<String, Any?>
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed storage.listAll wire response.")

        val items = parseRefEntries(map["items"], reference.storage)
        val prefixes = parseRefEntries(map["prefixes"], reference.storage)
        return ListResult(prefixes = prefixes, items = items, pageToken = null)
    }

    private fun parseRefEntries(rawList: Any?, storage: FirebaseStorage): List<StorageReference> {
        val entries = rawList as? List<*> ?: return emptyList()
        val result = ArrayList<StorageReference>(entries.size)
        for (entry in entries) {
            val fullPath = when (entry) {
                is String -> StorageUrlParser.normalizeWirePath(entry)
                is Map<*, *> -> StorageUrlParser.normalizeWirePath(
                    (entry["fullPath"] as? String) ?: (entry["path"] as? String) ?: (entry["name"] as? String) ?: ""
                )
                else -> ""
            }
            if (fullPath.isNotEmpty()) {
                result.add(StorageReference(storage, fullPath))
            }
        }
        return result
    }
}
