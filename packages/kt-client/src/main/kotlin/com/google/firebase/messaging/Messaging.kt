package com.google.firebase.messaging

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp

val Firebase.messaging: FirebaseMessaging
    get() = FirebaseMessaging.getInstance()

fun Firebase.messaging(app: FirebaseApp): FirebaseMessaging =
    FirebaseMessaging.getInstance(app)

var FirebaseMessaging.deliveryMetricsExportToBigQuery: Boolean
    get() = deliveryMetricsExportToBigQueryEnabled()
    set(value) {
        setDeliveryMetricsExportToBigQuery(value)
    }

fun remoteMessage(
    to: String,
    init: RemoteMessage.Builder.() -> Unit
): RemoteMessage {
    val builder = RemoteMessage.Builder(to)
    builder.init()
    return builder.build()
}
