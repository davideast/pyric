@file:JvmName("FirebaseCrashlyticsKt")

package com.google.firebase.crashlytics

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp

val Firebase.crashlytics: FirebaseCrashlytics
    get() = FirebaseCrashlytics.getInstance()

fun Firebase.crashlytics(app: FirebaseApp): FirebaseCrashlytics =
    FirebaseCrashlytics.getInstance(app)

fun FirebaseCrashlytics.setCustomKeys(init: KeyValueBuilder.() -> Unit) {
    val builder = KeyValueBuilder()
    builder.init()
    setCustomKeys(builder.build())
}

fun FirebaseCrashlytics.recordException(
    throwable: Throwable,
    init: KeyValueBuilder.() -> Unit
) {
    val builder = KeyValueBuilder()
    builder.init()
    recordException(throwable, builder.build())
}
