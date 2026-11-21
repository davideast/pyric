package com.google.firebase.storage

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import java.net.URI

/** Returns the [FirebaseStorage] instance of the default [FirebaseApp]. */
val Firebase.storage: FirebaseStorage
    get() = FirebaseStorage.getInstance()

/** Returns the [FirebaseStorage] instance for a custom storage bucket at [url]. */
fun Firebase.storage(url: String): FirebaseStorage =
    FirebaseStorage.getInstance(url)

/** Returns the [FirebaseStorage] instance of a given [FirebaseApp]. */
fun Firebase.storage(app: FirebaseApp): FirebaseStorage =
    FirebaseStorage.getInstance(app)

/** Returns the [FirebaseStorage] instance of a given [FirebaseApp] and storage bucket [url]. */
fun Firebase.storage(app: FirebaseApp, url: String): FirebaseStorage =
    FirebaseStorage.getInstance(app, url)

/** Builds a [StorageMetadata] instance using a Kotlin DSL initializer block. */
fun storageMetadata(init: StorageMetadata.Builder.() -> Unit): StorageMetadata {
    val builder = StorageMetadata.Builder()
    builder.init()
    return builder.build()
}

operator fun UploadTask.TaskSnapshot.component1(): Long = bytesTransferred

operator fun UploadTask.TaskSnapshot.component2(): Long = totalByteCount

operator fun UploadTask.TaskSnapshot.component3(): StorageMetadata? = metadata

operator fun UploadTask.TaskSnapshot.component4(): URI? = uploadSessionUri

operator fun ListResult.component1(): List<StorageReference> = items

operator fun ListResult.component2(): List<StorageReference> = prefixes

operator fun ListResult.component3(): String? = pageToken
