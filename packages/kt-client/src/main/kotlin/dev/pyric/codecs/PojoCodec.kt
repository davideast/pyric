package dev.pyric.codecs

import java.lang.reflect.Modifier

object PojoCodec {

    fun <T> deserialize(data: Map<String, Any?>, valueType: Class<T>): T {
        // Try constructor with map parameter first
        try {
            val mapCtor = valueType.getConstructor(Map::class.java)
            return mapCtor.newInstance(data)
        } catch (_: NoSuchMethodException) {}

        // Try no-arg constructor
        try {
            val ctor = valueType.getDeclaredConstructor()
            ctor.isAccessible = true
            val instance = ctor.newInstance()

            for ((key, value) in data) {
                // Try setter method: setXxx
                val setterName = "set" + key.replaceFirstChar { it.uppercase() }
                val setter = valueType.methods.firstOrNull {
                    it.name == setterName && it.parameterCount == 1 && Modifier.isPublic(it.modifiers)
                }
                if (setter != null) {
                    val paramType = setter.parameterTypes[0]
                    val converted = convertValue(value, paramType)
                    setter.invoke(instance, converted)
                    continue
                }

                // Try direct field
                try {
                    val field = valueType.getDeclaredField(key)
                    field.isAccessible = true
                    field.set(instance, convertValue(value, field.type))
                } catch (_: NoSuchFieldException) {}
            }
            return instance
        } catch (_: NoSuchMethodException) {
            // Try single constructor with matching parameter names
            val ctors = valueType.constructors
            if (ctors.isNotEmpty()) {
                val ctor = ctors[0]
                val params = ctor.parameters
                val args = Array(params.size) { i ->
                    val param = params[i]
                    val paramName = param.name
                    val rawVal = data[paramName]
                    convertValue(rawVal, param.type)
                }
                @Suppress("UNCHECKED_CAST")
                return ctor.newInstance(*args) as T
            }
        }

        throw IllegalArgumentException("Cannot instantiate ${valueType.name}: no suitable constructor found.")
    }

    private fun convertValue(value: Any?, targetType: Class<*>): Any? {
        if (value == null) return null
        if (targetType.isInstance(value)) return value
        if (targetType == Long::class.java || targetType == java.lang.Long::class.java) {
            return (value as? Number)?.toLong()
        }
        if (targetType == Int::class.java || targetType == java.lang.Integer::class.java) {
            return (value as? Number)?.toInt()
        }
        if (targetType == Double::class.java || targetType == java.lang.Double::class.java) {
            return (value as? Number)?.toDouble()
        }
        if (targetType == Float::class.java || targetType == java.lang.Float::class.java) {
            return (value as? Number)?.toFloat()
        }
        if (targetType == String::class.java) {
            return value.toString()
        }
        if (targetType == Boolean::class.java || targetType == java.lang.Boolean::class.java) {
            return value as? Boolean
        }
        return value
    }
}
