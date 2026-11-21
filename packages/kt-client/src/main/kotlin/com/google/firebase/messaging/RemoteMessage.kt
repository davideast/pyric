package com.google.firebase.messaging

import java.net.URI

class RemoteMessage internal constructor(
    val senderId: String? = null,
    val from: String? = null,
    val to: String? = null,
    data: Map<String, String> = emptyMap(),
    private val rawBytes: ByteArray? = null,
    val collapseKey: String? = null,
    val messageId: String? = null,
    val messageType: String? = null,
    val sentTime: Long = 0L,
    val ttl: Int = 0,
    val originalPriority: Int = PRIORITY_UNKNOWN,
    val priority: Int = PRIORITY_UNKNOWN,
    val notification: Notification? = null
) {
    val data: Map<String, String> = LinkedHashMap(data).let { java.util.Collections.unmodifiableMap(it) }

    val rawData: ByteArray?
        get() = rawBytes?.clone()

    class Builder(to: String) {
        private val targetTo: String
        private val dataEntries = LinkedHashMap<String, String>()
        private var rawBytes: ByteArray? = null
        private var msgId: String? = null
        private var msgType: String? = null
        private var ttlSeconds: Int = 0
        private var collapse: String? = null
        private var notif: Notification? = null

        init {
            require(to.isNotEmpty()) { "Invalid to: $to" }
            this.targetTo = to
        }

        fun build(): RemoteMessage {
            return RemoteMessage(
                to = targetTo,
                data = LinkedHashMap(dataEntries),
                rawBytes = rawBytes?.clone(),
                collapseKey = collapse,
                messageId = msgId,
                messageType = msgType,
                ttl = ttlSeconds,
                notification = notif
            )
        }

        fun addData(key: String, value: String?): Builder {
            if (value == null) {
                dataEntries.remove(key)
            } else {
                dataEntries[key] = value
            }
            return this
        }

        fun setData(data: Map<String, String>): Builder {
            dataEntries.clear()
            dataEntries.putAll(data)
            return this
        }

        val data: MutableMap<String, String>
            get() = dataEntries

        fun clearData(): Builder {
            dataEntries.clear()
            return this
        }

        fun setRawData(data: ByteArray?): Builder {
            rawBytes = data?.clone()
            return this
        }

        var messageId: String
            get() = msgId.orEmpty()
            @JvmSynthetic set(value) {
                msgId = value
            }

        fun setMessageId(messageId: String): Builder {
            msgId = messageId
            return this
        }

        var messageType: String?
            get() = msgType
            @JvmSynthetic set(value) {
                msgType = value
            }

        fun setMessageType(messageType: String?): Builder {
            msgType = messageType
            return this
        }

        var ttl: Int
            get() = ttlSeconds
            @JvmSynthetic set(value) {
                setTtl(value)
            }

        fun setTtl(ttl: Int): Builder {
            require(ttl in 0..MAX_TTL_SECONDS) { "ttl must be between 0 and $MAX_TTL_SECONDS" }
            ttlSeconds = ttl
            return this
        }

        var collapseKey: String?
            get() = collapse
            @JvmSynthetic set(value) {
                collapse = value
            }

        fun setCollapseKey(collapseKey: String?): Builder {
            collapse = collapseKey
            return this
        }

        fun setNotification(notification: Notification?): Builder {
            notif = notification
            return this
        }
    }

    class Notification(
        val title: String? = null,
        val body: String? = null,
        val imageUrl: URI? = null,
        val titleLocalizationKey: String? = null,
        private val titleLocArgs: Array<String>? = null,
        val bodyLocalizationKey: String? = null,
        private val bodyLocArgs: Array<String>? = null,
        val icon: String? = null,
        val sound: String? = null,
        val tag: String? = null,
        val color: String? = null,
        val clickAction: String? = null,
        val channelId: String? = null,
        val link: URI? = null,
        val ticker: String? = null,
        val sticky: Boolean = false,
        val localOnly: Boolean = false,
        val defaultSound: Boolean = false,
        val defaultVibrateSettings: Boolean = false,
        val defaultLightSettings: Boolean = false,
        val notificationPriority: Int? = null,
        val visibility: Int? = null,
        val notificationCount: Int? = null,
        val eventTime: Long? = null,
        private val lightSettingsValues: IntArray? = null,
        private val vibrateTimingsValues: LongArray? = null
    ) {
        val titleLocalizationArgs: Array<String>?
            get() = titleLocArgs?.clone()

        val bodyLocalizationArgs: Array<String>?
            get() = bodyLocArgs?.clone()

        val lightSettings: IntArray?
            get() = lightSettingsValues?.clone()

        val vibrateTimings: LongArray?
            get() = vibrateTimingsValues?.clone()
    }

    internal fun toBrokerMessage(): Map<String, Any?> {
        val payload = LinkedHashMap<String, Any?>()
        val target = to.orEmpty()
        if (target.startsWith("/topics/")) {
            payload["topic"] = target.removePrefix("/topics/")
        } else {
            payload["token"] = target
        }
        if (data.isNotEmpty()) {
            payload["data"] = LinkedHashMap(data)
        }
        if (notification != null) {
            val notifMap = LinkedHashMap<String, Any?>()
            if (notification.title != null) notifMap["title"] = notification.title
            if (notification.body != null) notifMap["body"] = notification.body
            if (notification.imageUrl != null) notifMap["imageUrl"] = notification.imageUrl.toString()
            if (notifMap.isNotEmpty()) {
                payload["notification"] = notifMap
            }
        }
        if (collapseKey != null || ttl > 0) {
            val androidMap = LinkedHashMap<String, Any?>()
            if (collapseKey != null) androidMap["collapseKey"] = collapseKey
            if (ttl > 0) androidMap["ttl"] = ttl.toLong() * 1_000L
            payload["android"] = androidMap
        }
        return payload
    }

    companion object {
        const val PRIORITY_UNKNOWN: Int = 0
        const val PRIORITY_HIGH: Int = 1
        const val PRIORITY_NORMAL: Int = 2
        private const val MAX_TTL_SECONDS: Int = 86_400

        internal fun parsePriority(raw: Any?): Int {
            return when (val text = (raw as? String)?.lowercase()) {
                "high" -> PRIORITY_HIGH
                "normal" -> PRIORITY_NORMAL
                null -> when (raw) {
                    is Number -> when (raw.toInt()) {
                        PRIORITY_HIGH -> PRIORITY_HIGH
                        PRIORITY_NORMAL -> PRIORITY_NORMAL
                        else -> PRIORITY_UNKNOWN
                    }
                    else -> PRIORITY_UNKNOWN
                }
                else -> if (text == "1") PRIORITY_HIGH else if (text == "2") PRIORITY_NORMAL else PRIORITY_UNKNOWN
            }
        }

        internal fun fromDeliveredPayload(raw: Map<*, *>): RemoteMessage {
            val fromVal = raw["from"] as? String
            val msgId = raw["messageId"] as? String
            val dataMap = LinkedHashMap<String, String>()
            val rawDataObj = raw["data"] as? Map<*, *>
            if (rawDataObj != null) {
                for ((k, v) in rawDataObj) {
                    if (k is String && v != null) {
                        dataMap[k] = v.toString()
                    }
                }
            }

            val rawNotif = raw["notification"] as? Map<*, *>
            val parsedNotification = if (rawNotif != null) {
                val imageStr = (rawNotif["image"] ?: rawNotif["imageUrl"]) as? String
                val parsedUri = imageStr?.takeIf { it.isNotEmpty() }?.let {
                    runCatching { URI.create(it) }.getOrNull()
                }
                Notification(
                    title = rawNotif["title"] as? String,
                    body = rawNotif["body"] as? String,
                    imageUrl = parsedUri,
                    icon = rawNotif["icon"] as? String,
                    sound = rawNotif["sound"] as? String,
                    tag = rawNotif["tag"] as? String,
                    color = rawNotif["color"] as? String,
                    clickAction = rawNotif["clickAction"] as? String,
                    channelId = rawNotif["channelId"] as? String
                )
            } else {
                null
            }

            val resolvedPriority = parsePriority(raw["priority"])
            val resolvedOriginalPriority = parsePriority(raw["originalPriority"] ?: raw["priority"])
            val sentMillis = (raw["sentTime"] as? Number)?.toLong() ?: 0L
            val ttlSec = (raw["ttl"] as? Number)?.toInt() ?: 0

            return RemoteMessage(
                senderId = fromVal,
                from = fromVal,
                to = raw["to"] as? String,
                data = dataMap,
                collapseKey = raw["collapseKey"] as? String,
                messageId = msgId,
                messageType = raw["messageType"] as? String,
                sentTime = sentMillis,
                ttl = ttlSec,
                originalPriority = resolvedOriginalPriority,
                priority = resolvedPriority,
                notification = parsedNotification
            )
        }
    }
}
