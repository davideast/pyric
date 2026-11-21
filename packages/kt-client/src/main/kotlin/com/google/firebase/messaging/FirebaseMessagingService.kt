package com.google.firebase.messaging

open class FirebaseMessagingService {
    open fun onMessageReceived(message: RemoteMessage) {}

    open fun onDeletedMessages() {}

    open fun onMessageSent(msgId: String) {}

    open fun onSendError(msgId: String, exception: Exception) {}

    open fun onNewToken(token: String) {}

    open fun onRegistered(token: String) {}

    open fun onUnregistered(token: String) {}

    companion object {
        const val ACTION_DIRECT_BOOT_REMOTE_INTENT: String =
            "com.google.firebase.messaging.DIRECT_BOOT_REMOTE_INTENT"
    }
}
