package com.google.firebase.ai.type

import java.util.Objects

/**
 * Represents content sent to and received from the model.
 *
 * @property role Producer of the content (typically `"user"` or `"model"`). Defaults to `"user"`.
 * @property parts Ordered list of [Part] instances constituting this turn.
 */
class Content @JvmOverloads constructor(
    val role: String? = "user",
    parts: List<Part>
) {
    val parts: List<Part> = parts.toList()

    /** Returns a copy of this [Content] with the provided fields replaced. */
    @JvmOverloads
    fun copy(role: String? = this.role, parts: List<Part> = this.parts): Content =
        Content(role, parts)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Content) return false
        return role == other.role && parts == other.parts
    }

    override fun hashCode(): Int = Objects.hash(role, parts)

    override fun toString(): String = "Content(role=$role, parts=$parts)"

    /** Builder for constructing [Content] instances in Kotlin DSL or Java style. */
    class Builder {
        @JvmField
        var role: String? = "user"

        @JvmField
        var parts: MutableList<Part> = arrayListOf()

        fun setRole(role: String?): Builder = apply { this.role = role }

        fun setParts(parts: MutableList<Part>): Builder = apply { this.parts = parts }

        /** Appends [data] to [parts]. */
        @JvmName("addPart")
        fun <T : Part> part(data: T): Builder = apply { parts.add(data) }

        /** Appends a [TextPart] carrying [text]. */
        @JvmName("addText")
        fun text(text: String): Builder = part(TextPart(text))

        /** Appends an [InlineDataPart] carrying [bytes] and [mimeType]. */
        @JvmName("addInlineData")
        fun inlineData(bytes: ByteArray, mimeType: String): Builder =
            part(InlineDataPart(bytes, mimeType))

        /** Appends an [InlineDataPart] carrying [blob] with [mimeType]. */
        @JvmName("addBlob")
        fun blob(mimeType: String, blob: ByteArray): Builder =
            part(InlineDataPart(blob, mimeType))

        /** Appends an [InlineDataPart] carrying [bytes] with [mimeType]. */
        @JvmName("addBlobBytesFirst")
        fun blob(bytes: ByteArray, mimeType: String): Builder =
            part(InlineDataPart(bytes, mimeType))

        /** Appends a [FileDataPart] carrying [uri] and [mimeType]. */
        @JvmName("addFileData")
        fun fileData(uri: String, mimeType: String): Builder =
            part(FileDataPart(uri, mimeType))

        /** Builds an immutable [Content] snapshot of the configured [role] and [parts]. */
        fun build(): Content = Content(role, parts.toList())
    }
}

/** Builds a [Content] instance using the Kotlin DSL. */
fun content(role: String? = "user", init: Content.Builder.() -> Unit): Content {
    val builder = Content.Builder()
    builder.role = role
    builder.init()
    return builder.build()
}
