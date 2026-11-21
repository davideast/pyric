package com.google.firebase.ai.type

import java.util.Objects

/** Preset controlling the reasoning intensity of compatible Gemini models. */
class ThinkingLevel private constructor(
    val name: String,
    val ordinal: Int
) {
    internal fun toWireString(): String = name

    override fun equals(other: Any?): Boolean =
        this === other || (other is ThinkingLevel && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val MINIMAL: ThinkingLevel = ThinkingLevel("MINIMAL", 0)
        @JvmField val LOW: ThinkingLevel = ThinkingLevel("LOW", 1)
        @JvmField val MEDIUM: ThinkingLevel = ThinkingLevel("MEDIUM", 2)
        @JvmField val HIGH: ThinkingLevel = ThinkingLevel("HIGH", 3)
    }
}

/** Configuration for Gemini thinking / reasoning behavior. */
class ThinkingConfig private constructor(
    val thinkingBudget: Int? = null,
    val includeThoughts: Boolean? = null,
    val thinkingLevel: ThinkingLevel? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ThinkingConfig) return false
        return thinkingBudget == other.thinkingBudget &&
            includeThoughts == other.includeThoughts &&
            thinkingLevel == other.thinkingLevel
    }

    override fun hashCode(): Int = Objects.hash(thinkingBudget, includeThoughts, thinkingLevel)

    class Builder {
        @JvmField
        @set:JvmSynthetic
        var thinkingBudget: Int? = null

        @JvmField
        @set:JvmSynthetic
        var includeThoughts: Boolean? = null

        @JvmField
        @set:JvmSynthetic
        var thinkingLevel: ThinkingLevel? = null

        fun setThinkingBudget(thinkingBudget: Int): Builder = apply {
            this.thinkingBudget = thinkingBudget
        }

        fun setThinkingLevel(thinkingLevel: ThinkingLevel): Builder = apply {
            this.thinkingLevel = thinkingLevel
        }

        fun setIncludeThoughts(includeThoughts: Boolean): Builder = apply {
            this.includeThoughts = includeThoughts
        }

        fun build(): ThinkingConfig {
            if (thinkingBudget != null && thinkingLevel != null) {
                throw IllegalArgumentException(
                    "`thinkingBudget` already set. Cannot set both `thinkingBudget` and `thinkingLevel`"
                )
            }
            return ThinkingConfig(
                thinkingBudget = thinkingBudget,
                includeThoughts = includeThoughts,
                thinkingLevel = thinkingLevel
            )
        }
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

/** Constructs a [ThinkingConfig] using the Kotlin DSL. */
fun thinkingConfig(init: ThinkingConfig.Builder.() -> Unit): ThinkingConfig {
    val builder = ThinkingConfig.Builder()
    builder.init()
    return builder.build()
}
