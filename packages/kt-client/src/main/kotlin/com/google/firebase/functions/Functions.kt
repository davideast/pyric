package com.google.firebase.functions

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import java.net.URL

val Firebase.functions: FirebaseFunctions
    get() = FirebaseFunctions.getInstance()

fun Firebase.functions(regionOrCustomDomain: String): FirebaseFunctions =
    FirebaseFunctions.getInstance(regionOrCustomDomain)

fun Firebase.functions(app: FirebaseApp): FirebaseFunctions =
    FirebaseFunctions.getInstance(app)

fun Firebase.functions(app: FirebaseApp, regionOrCustomDomain: String): FirebaseFunctions =
    FirebaseFunctions.getInstance(app, regionOrCustomDomain)

fun FirebaseFunctions.getHttpsCallable(
    name: String,
    init: HttpsCallableOptions.Builder.() -> Unit
): HttpsCallableReference {
    val builder = HttpsCallableOptions.Builder()
    builder.init()
    return getHttpsCallable(name, builder.build())
}

fun FirebaseFunctions.getHttpsCallableFromUrl(
    url: URL,
    init: HttpsCallableOptions.Builder.() -> Unit
): HttpsCallableReference {
    val builder = HttpsCallableOptions.Builder()
    builder.init()
    return getHttpsCallableFromUrl(url, builder.build())
}
