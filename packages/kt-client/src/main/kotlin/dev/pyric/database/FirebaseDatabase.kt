package dev.pyric.database

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp

typealias FirebaseDatabase = com.google.firebase.database.FirebaseDatabase

val Firebase.database: FirebaseDatabase
    get() = com.google.firebase.database.FirebaseDatabase.getInstance()

fun Firebase.database(url: String): FirebaseDatabase =
    com.google.firebase.database.FirebaseDatabase.getInstance(url)

fun Firebase.database(app: FirebaseApp): FirebaseDatabase =
    com.google.firebase.database.FirebaseDatabase.getInstance(app)

fun Firebase.database(app: FirebaseApp, url: String): FirebaseDatabase =
    com.google.firebase.database.FirebaseDatabase.getInstance(app, url)

internal fun attachWireInstance(params: Map<String, Any?>, instance: String?): Map<String, Any?> {
    if (instance == null) return params
    return params + ("instance" to instance)
}
