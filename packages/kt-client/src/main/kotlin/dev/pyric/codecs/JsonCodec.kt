package dev.pyric.codecs

/**
 * Lightweight, zero-dependency pure-Kotlin JSON serializer and parser.
 */
object JsonCodec {

    fun encodeToString(value: Any?): String {
        val sb = java.lang.StringBuilder()
        serialize(value, sb)
        return sb.toString()
    }

    private fun serialize(value: Any?, sb: java.lang.StringBuilder) {
        when (value) {
            null -> sb.append("null")
            is Boolean -> sb.append(value)
            is Number -> sb.append(value)
            is String -> {
                sb.append('"')
                for (c in value) {
                    when (c) {
                        '"' -> sb.append("\\\"")
                        '\\' -> sb.append("\\\\")
                        '\b' -> sb.append("\\b")
                        '\u000C' -> sb.append("\\f")
                        '\n' -> sb.append("\\n")
                        '\r' -> sb.append("\\r")
                        '\t' -> sb.append("\\t")
                        else -> {
                            if (c.code < 0x20) {
                                sb.append(String.format("\\u%04x", c.code))
                            } else {
                                sb.append(c)
                            }
                        }
                    }
                }
                sb.append('"')
            }
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    serialize(k.toString(), sb)
                    sb.append(':')
                    serialize(v, sb)
                }
                sb.append('}')
            }
            is List<*> -> {
                sb.append('[')
                var first = true
                for (item in value) {
                    if (!first) sb.append(',')
                    first = false
                    serialize(item, sb)
                }
                sb.append(']')
            }
            is Array<*> -> serialize(value.toList(), sb)
            else -> serialize(value.toString(), sb)
        }
    }

    fun decode(json: String): Any? {
        val parser = Parser(json.trim())
        return parser.parseValue()
    }

    @Suppress("UNCHECKED_CAST")
    fun decodeMap(json: String): Map<String, Any?> {
        return (decode(json) as? Map<String, Any?>) ?: emptyMap()
    }

    private class Parser(private val src: String) {
        private var pos = 0
        private val len = src.length

        fun parseValue(): Any? {
            skipWhitespace()
            if (pos >= len) return null
            return when (val ch = src[pos]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't', 'f' -> parseBoolean()
                'n' -> parseNull()
                '-', in '0'..'9' -> parseNumber()
                else -> throw IllegalArgumentException("Unexpected char '$ch' at index $pos in: $src")
            }
        }

        private fun skipWhitespace() {
            while (pos < len && (src[pos] == ' ' || src[pos] == '\t' || src[pos] == '\n' || src[pos] == '\r')) {
                pos++
            }
        }

        private fun parseObject(): Map<String, Any?> {
            pos++ // consume '{'
            val map = mutableMapOf<String, Any?>()
            skipWhitespace()
            if (pos < len && src[pos] == '}') {
                pos++
                return map
            }
            while (pos < len) {
                skipWhitespace()
                val key = parseString()
                skipWhitespace()
                if (pos >= len || src[pos] != ':') {
                    throw IllegalArgumentException("Expected ':' at index $pos in: $src")
                }
                pos++ // consume ':'
                val value = parseValue()
                map[key] = value
                skipWhitespace()
                if (pos < len && src[pos] == ',') {
                    pos++
                } else if (pos < len && src[pos] == '}') {
                    pos++
                    return map
                } else {
                    throw IllegalArgumentException("Expected ',' or '}' at index $pos in: $src")
                }
            }
            throw IllegalArgumentException("Unterminated object in: $src")
        }

        private fun parseArray(): List<Any?> {
            pos++ // consume '['
            val list = mutableListOf<Any?>()
            skipWhitespace()
            if (pos < len && src[pos] == ']') {
                pos++
                return list
            }
            while (pos < len) {
                val value = parseValue()
                list.add(value)
                skipWhitespace()
                if (pos < len && src[pos] == ',') {
                    pos++
                } else if (pos < len && src[pos] == ']') {
                    pos++
                    return list
                } else {
                    throw IllegalArgumentException("Expected ',' or ']' at index $pos in: $src")
                }
            }
            throw IllegalArgumentException("Unterminated array in: $src")
        }

        private fun parseString(): String {
            if (pos >= len || src[pos] != '"') {
                throw IllegalArgumentException("Expected '\"' at index $pos in: $src")
            }
            pos++ // consume opening quote
            val sb = java.lang.StringBuilder()
            while (pos < len) {
                val c = src[pos++]
                if (c == '"') {
                    return sb.toString()
                }
                if (c == '\\') {
                    if (pos >= len) throw IllegalArgumentException("Unterminated escape at index $pos")
                    when (val esc = src[pos++]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (pos + 4 > len) throw IllegalArgumentException("Incomplete unicode escape at $pos")
                            val hex = src.substring(pos, pos + 4)
                            pos += 4
                            sb.append(hex.toInt(16).toChar())
                        }
                        else -> sb.append(esc)
                    }
                } else {
                    sb.append(c)
                }
            }
            throw IllegalArgumentException("Unterminated string in: $src")
        }

        private fun parseBoolean(): Boolean {
            if (src.startsWith("true", pos)) {
                pos += 4
                return true
            }
            if (src.startsWith("false", pos)) {
                pos += 5
                return false
            }
            throw IllegalArgumentException("Invalid boolean literal at index $pos in: $src")
        }

        private fun parseNull(): Any? {
            if (src.startsWith("null", pos)) {
                pos += 4
                return null
            }
            throw IllegalArgumentException("Invalid null literal at index $pos in: $src")
        }

        private fun parseNumber(): Number {
            val start = pos
            if (pos < len && src[pos] == '-') pos++
            while (pos < len && src[pos] in '0'..'9') pos++
            var isFloating = false
            if (pos < len && src[pos] == '.') {
                isFloating = true
                pos++
                while (pos < len && src[pos] in '0'..'9') pos++
            }
            if (pos < len && (src[pos] == 'e' || src[pos] == 'E')) {
                isFloating = true
                pos++
                if (pos < len && (src[pos] == '+' || src[pos] == '-')) pos++
                while (pos < len && src[pos] in '0'..'9') pos++
            }
            val numStr = src.substring(start, pos)
            return if (isFloating) {
                numStr.toDouble()
            } else {
                val longVal = numStr.toLong()
                if (longVal in Int.MIN_VALUE..Int.MAX_VALUE) {
                    longVal.toInt()
                } else {
                    longVal
                }
            }
        }
    }
}
