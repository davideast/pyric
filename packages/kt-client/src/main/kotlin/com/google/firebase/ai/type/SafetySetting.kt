package com.google.firebase.ai.type

import java.util.Objects

/** Category of potential harm evaluated by safety filters. */
class HarmCategory private constructor(
    val name: String,
    val ordinal: Int,
    internal val wireName: String
) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is HarmCategory && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val UNKNOWN: HarmCategory =
            HarmCategory("UNKNOWN", 0, "HARM_CATEGORY_UNSPECIFIED")
        @JvmField val HARASSMENT: HarmCategory =
            HarmCategory("HARASSMENT", 1, "HARM_CATEGORY_HARASSMENT")
        @JvmField val HATE_SPEECH: HarmCategory =
            HarmCategory("HATE_SPEECH", 2, "HARM_CATEGORY_HATE_SPEECH")
        @JvmField val SEXUALLY_EXPLICIT: HarmCategory =
            HarmCategory("SEXUALLY_EXPLICIT", 3, "HARM_CATEGORY_SEXUALLY_EXPLICIT")
        @JvmField val DANGEROUS_CONTENT: HarmCategory =
            HarmCategory("DANGEROUS_CONTENT", 4, "HARM_CATEGORY_DANGEROUS_CONTENT")
        @JvmField val CIVIC_INTEGRITY: HarmCategory =
            HarmCategory("CIVIC_INTEGRITY", 5, "HARM_CATEGORY_CIVIC_INTEGRITY")
        @JvmField val IMAGE_HATE: HarmCategory =
            HarmCategory("IMAGE_HATE", 6, "HARM_CATEGORY_IMAGE_HATE")
        @JvmField val IMAGE_DANGEROUS_CONTENT: HarmCategory =
            HarmCategory("IMAGE_DANGEROUS_CONTENT", 7, "HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT")
        @JvmField val IMAGE_HARASSMENT: HarmCategory =
            HarmCategory("IMAGE_HARASSMENT", 8, "HARM_CATEGORY_IMAGE_HARASSMENT")
        @JvmField val IMAGE_SEXUALLY_EXPLICIT: HarmCategory =
            HarmCategory("IMAGE_SEXUALLY_EXPLICIT", 9, "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT")

        internal fun fromWire(raw: String?): HarmCategory = when (raw) {
            "HARM_CATEGORY_HARASSMENT", "HARASSMENT" -> HARASSMENT
            "HARM_CATEGORY_HATE_SPEECH", "HATE_SPEECH" -> HATE_SPEECH
            "HARM_CATEGORY_SEXUALLY_EXPLICIT", "SEXUALLY_EXPLICIT" -> SEXUALLY_EXPLICIT
            "HARM_CATEGORY_DANGEROUS_CONTENT", "DANGEROUS_CONTENT" -> DANGEROUS_CONTENT
            "HARM_CATEGORY_CIVIC_INTEGRITY", "CIVIC_INTEGRITY" -> CIVIC_INTEGRITY
            "HARM_CATEGORY_IMAGE_HATE", "IMAGE_HATE" -> IMAGE_HATE
            "HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT", "IMAGE_DANGEROUS_CONTENT" ->
                IMAGE_DANGEROUS_CONTENT
            "HARM_CATEGORY_IMAGE_HARASSMENT", "IMAGE_HARASSMENT" -> IMAGE_HARASSMENT
            "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT", "IMAGE_SEXUALLY_EXPLICIT" ->
                IMAGE_SEXUALLY_EXPLICIT
            else -> UNKNOWN
        }
    }
}

/** Sensitivity threshold above which content matching a [HarmCategory] is blocked. */
class HarmBlockThreshold private constructor(
    val name: String,
    val ordinal: Int,
    internal val wireName: String
) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is HarmBlockThreshold && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val LOW_AND_ABOVE: HarmBlockThreshold =
            HarmBlockThreshold("LOW_AND_ABOVE", 0, "BLOCK_LOW_AND_ABOVE")
        @JvmField val MEDIUM_AND_ABOVE: HarmBlockThreshold =
            HarmBlockThreshold("MEDIUM_AND_ABOVE", 1, "BLOCK_MEDIUM_AND_ABOVE")
        @JvmField val ONLY_HIGH: HarmBlockThreshold =
            HarmBlockThreshold("ONLY_HIGH", 2, "BLOCK_ONLY_HIGH")
        @JvmField val NONE: HarmBlockThreshold =
            HarmBlockThreshold("NONE", 3, "BLOCK_NONE")
        @JvmField val OFF: HarmBlockThreshold =
            HarmBlockThreshold("OFF", 4, "OFF")

        @JvmField val BLOCK_LOW_AND_ABOVE: HarmBlockThreshold = LOW_AND_ABOVE
        @JvmField val BLOCK_MEDIUM_AND_ABOVE: HarmBlockThreshold = MEDIUM_AND_ABOVE
        @JvmField val BLOCK_ONLY_HIGH: HarmBlockThreshold = ONLY_HIGH
        @JvmField val BLOCK_NONE: HarmBlockThreshold = NONE
    }
}

/** Alias matching legacy `BlockThreshold` references. */
typealias BlockThreshold = HarmBlockThreshold

/** Specifies how safety thresholds evaluate probability vs severity scores (Vertex AI only). */
class HarmBlockMethod private constructor(
    val name: String,
    val ordinal: Int
) {
    internal val wireName: String get() = name

    override fun equals(other: Any?): Boolean =
        this === other || (other is HarmBlockMethod && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val SEVERITY: HarmBlockMethod = HarmBlockMethod("SEVERITY", 0)
        @JvmField val PROBABILITY: HarmBlockMethod = HarmBlockMethod("PROBABILITY", 1)
    }
}

/** Pairs a [HarmCategory] with a [HarmBlockThreshold] and optional [HarmBlockMethod]. */
class SafetySetting @JvmOverloads constructor(
    val harmCategory: HarmCategory,
    val threshold: HarmBlockThreshold,
    val method: HarmBlockMethod? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SafetySetting) return false
        return harmCategory == other.harmCategory &&
            threshold == other.threshold &&
            method == other.method
    }

    override fun hashCode(): Int = Objects.hash(harmCategory, threshold, method)

    override fun toString(): String =
        "SafetySetting(harmCategory=$harmCategory, threshold=$threshold, method=$method)"
}
