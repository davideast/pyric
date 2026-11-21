package com.google.firebase.ai.type

import java.util.Objects

/** Interface representing a content part sent to or received from a generative model. */
interface Part {
    val isThought: Boolean
}

/** Represents text data sent to or received from a generative model. */
class TextPart internal constructor(
    val text: String,
    override val isThought: Boolean,
    val thoughtSignature: String?
) : Part {

    constructor(text: String) : this(text, false, null)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is TextPart) return false
        return text == other.text &&
            isThought == other.isThought &&
            thoughtSignature == other.thoughtSignature
    }

    override fun hashCode(): Int = Objects.hash(text, isThought, thoughtSignature)

    override fun toString(): String = "TextPart(text=$text, isThought=$isThought)"

    companion object {
        @JvmStatic
        fun createWithThinking(
            text: String,
            isThought: Boolean,
            thoughtSignature: String?
        ): TextPart = TextPart(text, isThought, thoughtSignature)
    }
}

/** Represents binary data with an associated IANA MIME type sent inline with a request or response. */
class InlineDataPart internal constructor(
    val inlineData: ByteArray,
    val mimeType: String,
    val displayName: String?,
    override val isThought: Boolean,
    val thoughtSignature: String?
) : Part {

    constructor(inlineData: ByteArray, mimeType: String) :
        this(inlineData.copyOf(), mimeType, null, false, null)

    constructor(inlineData: ByteArray, mimeType: String, displayName: String) :
        this(inlineData.copyOf(), mimeType, displayName, false, null)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is InlineDataPart) return false
        return inlineData.contentEquals(other.inlineData) &&
            mimeType == other.mimeType &&
            displayName == other.displayName &&
            isThought == other.isThought &&
            thoughtSignature == other.thoughtSignature
    }

    override fun hashCode(): Int {
        var result = inlineData.contentHashCode()
        result = 31 * result + mimeType.hashCode()
        result = 31 * result + (displayName?.hashCode() ?: 0)
        result = 31 * result + isThought.hashCode()
        result = 31 * result + (thoughtSignature?.hashCode() ?: 0)
        return result
    }

    override fun toString(): String =
        "InlineDataPart(mimeType=$mimeType, size=${inlineData.size}, isThought=$isThought)"

    companion object {
        @JvmStatic
        fun createWithThinking(
            inlineData: ByteArray,
            mimeType: String,
            displayName: String?,
            isThought: Boolean,
            thoughtSignature: String?
        ): InlineDataPart = InlineDataPart(
            inlineData.copyOf(),
            mimeType,
            displayName,
            isThought,
            thoughtSignature
        )
    }
}

/** Represents file data referenced by URI (such as a `gs://` Storage URI) and MIME type. */
class FileDataPart internal constructor(
    val uri: String,
    val mimeType: String,
    override val isThought: Boolean,
    val thoughtSignature: String?
) : Part {

    constructor(uri: String, mimeType: String) : this(uri, mimeType, false, null)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is FileDataPart) return false
        return uri == other.uri &&
            mimeType == other.mimeType &&
            isThought == other.isThought &&
            thoughtSignature == other.thoughtSignature
    }

    override fun hashCode(): Int = Objects.hash(uri, mimeType, isThought, thoughtSignature)

    override fun toString(): String = "FileDataPart(uri=$uri, mimeType=$mimeType)"

    companion object {
        @JvmStatic
        fun createWithThinking(
            uri: String,
            mimeType: String,
            isThought: Boolean,
            thoughtSignature: String?
        ): FileDataPart = FileDataPart(uri, mimeType, isThought, thoughtSignature)
    }
}

/** Represents a function call requested by the model. */
class FunctionCallPart internal constructor(
    val name: String,
    val args: Map<String, Any?>,
    val id: String?,
    override val isThought: Boolean,
    val thoughtSignature: String?
) : Part {

    @JvmOverloads
    constructor(
        name: String,
        args: Map<String, Any?> = emptyMap(),
        id: String? = null
    ) : this(name, args.toMap(), id, false, null)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is FunctionCallPart) return false
        return name == other.name &&
            args == other.args &&
            id == other.id &&
            isThought == other.isThought &&
            thoughtSignature == other.thoughtSignature
    }

    override fun hashCode(): Int = Objects.hash(name, args, id, isThought, thoughtSignature)

    override fun toString(): String = "FunctionCallPart(name=$name, id=$id, args=$args)"

    companion object {
        @JvmStatic
        fun createWithThinking(
            name: String,
            args: Map<String, Any?>,
            id: String?,
            isThought: Boolean,
            thoughtSignature: String?
        ): FunctionCallPart = FunctionCallPart(name, args.toMap(), id, isThought, thoughtSignature)
    }
}

/** Represents the execution output of a function call returned to the model. */
class FunctionResponsePart internal constructor(
    val name: String,
    val response: Map<String, Any?>,
    val id: String?,
    val parts: List<Part>,
    override val isThought: Boolean,
    val thoughtSignature: String?
) : Part {

    @JvmOverloads
    constructor(
        name: String,
        response: Map<String, Any?>,
        id: String? = null,
        parts: List<Part> = emptyList()
    ) : this(name, response.toMap(), id, parts.toList(), false, null)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is FunctionResponsePart) return false
        return name == other.name &&
            response == other.response &&
            id == other.id &&
            parts == other.parts &&
            isThought == other.isThought &&
            thoughtSignature == other.thoughtSignature
    }

    override fun hashCode(): Int =
        Objects.hash(name, response, id, parts, isThought, thoughtSignature)

    override fun toString(): String = "FunctionResponsePart(name=$name, id=$id)"

    companion object {
        @JvmStatic
        fun createWithThinking(
            name: String,
            response: Map<String, Any?>,
            id: String?,
            parts: List<Part>,
            isThought: Boolean,
            thoughtSignature: String?
        ): FunctionResponsePart =
            FunctionResponsePart(name, response.toMap(), id, parts.toList(), isThought, thoughtSignature)
    }
}

/** Returns the part's text if this is a [TextPart], or `null` otherwise. */
fun Part.asTextOrNull(): String? = (this as? TextPart)?.text

/** Returns this part as an [InlineDataPart] if applicable, or `null` otherwise. */
fun Part.asInlineDataPartOrNull(): InlineDataPart? = this as? InlineDataPart

/** Returns this part as a [FileDataPart] if applicable, or `null` otherwise. */
fun Part.asFileDataOrNull(): FileDataPart? = this as? FileDataPart
